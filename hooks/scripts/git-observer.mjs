#!/usr/bin/env node
/**
 * Report every commit the agent makes in this conversation, mechanically (item
 * 604c360a; the same design as DevSpec-Pi's observer, item 2c971806).
 *
 *   session-start  SessionStart. Creates the conversation's private directory under
 *                  ~/.devspec/git-observer/, holding a `git` stand-in (git-shim.mjs),
 *                  and adds that directory to the front of PATH in the environment
 *                  file Claude Code applies to every shell command of this
 *                  conversation: the agent's, its subagents', background commands and
 *                  Monitor commands (CLAUDE_ENV_FILE). Nothing else is exported, and
 *                  nothing is installed in any repository or git configuration.
 *   drain          After each tool call, at Stop and SubagentStop, when a commit is
 *                  waiting. Reads the journal the stand-in wrote and reports each
 *                  commit with report_commit_provenance.
 *   session-end    SessionEnd. Reports what is left, logs anything it could not
 *                  send, and removes the directory.
 *
 * Each commit is reported once, with its full id read from git, its branch and the
 * repository's origin; DevSpec decides which project that repository belongs to and
 * refuses one it does not track. The pin in .devspec/project.json is used only for a
 * repository with no origin. A commit counts as this agent's only when this
 * conversation was bound to the same connection when the commit was made. A report
 * that cannot be sent is tried again a bounded number of times; anything dropped,
 * refused or sent is written to ~/.devspec/git-observer/commits.log.
 *
 * On Windows, Claude Code runs Bash commands in Git Bash, so the stand-in and the
 * PATH line name paths the way Git Bash does, and the stand-in runs git.exe (item
 * 4054ff58). Where this cannot run (a Claude Code without CLAUDE_ENV_FILE), the older
 * command recogniser in commit-observation.mjs reports what it can.
 */

import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isEntryPoint } from './entry-point.mjs'
import { McpToolRefusalError, isRetryableHttpFailure, mcpToolsCall } from './mcp-call.mjs'
import { findProjectPin } from './devspec-scope.mjs'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'
import { stateDir } from './commit-provenance.mjs'

const SHIM_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'git-shim.mjs')
// The stand-in imports this, so it is copied beside it (item e597bc18).
const STAMP_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'commit-stamp.mjs')
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FULL_SHA = /^[0-9a-f]{40}$/
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** What reporting may cost: attempts, age, queue length, and one hook's share. */
export const LIMITS = Object.freeze({
  attempts: 5,
  ttlMs: 24 * 60 * 60 * 1000,
  queue: 200,
  perDrain: 5,
  callTimeoutMs: 4_000,
  staleSessionMs: 7 * 24 * 60 * 60 * 1000,
  logBytes: 512 * 1024,
  lockMs: 30_000,
})

export function observerBase(home = os.homedir()) {
  return path.join(home, '.devspec', 'git-observer')
}

export function observerDir(sessionId, home = os.homedir()) {
  return SESSION_ID.test(sessionId ?? '') ? path.join(observerBase(home), sessionId) : null
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

// ---------------------------------------------------------------------------
// The log: every outcome, so nothing is dropped silently.
// ---------------------------------------------------------------------------

export function logPath(home = os.homedir()) {
  return path.join(observerBase(home), 'commits.log')
}

export function logOutcome(entry, home = os.homedir()) {
  try {
    const file = logPath(home)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    try {
      if (fs.statSync(file).size > LIMITS.logBytes) fs.renameSync(file, `${file}.1`)
    } catch { /* no log yet */ }
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 })
  } catch { /* the log is best effort; git is never affected */ }
}

// ---------------------------------------------------------------------------
// Session start: the stand-in, and the PATH line Claude Code applies.
// ---------------------------------------------------------------------------

/** The git a hook would run, outside every observer directory. */
export function findRealGit(env = process.env, home = os.homedir(), platform = process.platform) {
  const windows = platform === 'win32'
  const fold = (value) => (windows ? value.toLowerCase() : value)
  const base = fold(observerBase(home))
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    // Windows runs git.exe; an extensionless file there is a script, like the stand-in.
    const candidate = path.join(dir, windows ? 'git.exe' : 'git')
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (!fs.statSync(candidate).isFile()) continue
      const real = fold(fs.realpathSync(candidate))
      if (real === base || real.startsWith(base + path.sep)) continue
      return candidate
    } catch { /* not here */ }
  }
  return null
}

/**
 * A Windows path as Git Bash names it (C:\Users\x → /c/Users/x), for its PATH and the
 * stand-in's own script. On Windows, Claude Code runs shell commands in Git Bash
 * (item 4054ff58).
 */
export function toBashPath(target) {
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(target)
  return drive ? `/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}` : target.replace(/\\/g, '/')
}

/** git's own builtin command names. Empty if git cannot say: then every command is observed. */
function gitBuiltins(realGit) {
  try {
    return execFileSync(realGit, ['--list-cmds=builtins'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 })
      .split('\n').map((name) => name.trim()).filter((name) => /^[a-z][a-z0-9-]*$/.test(name))
  } catch {
    return []
  }
}

/**
 * Set up this conversation's observer. Returns { ok: true, dir } or { ok: false, reason }.
 * Never throws: a session must start whatever happens here.
 */
export function startObserver({ sessionId, envFile, env = process.env, home = os.homedir(), nodePath = process.execPath, platform = process.platform, now = Date.now() } = {}) {
  try {
    const dir = observerDir(sessionId, home)
    if (!dir) return { ok: false, reason: 'no conversation id' }
    // On Windows the shell is Git Bash: its own paths for what it runs and searches,
    // forward-slash Windows paths for what Node is handed.
    const windows = platform === 'win32'
    const forBash = (target) => (windows ? toBashPath(target) : target)
    const forNode = (target) => (windows ? target.replace(/\\/g, '/') : target)
    if (typeof envFile !== 'string' || !envFile) return { ok: false, reason: 'no CLAUDE_ENV_FILE' }
    const realGit = findRealGit(env, home, platform)
    if (!realGit) return { ok: false, reason: 'git not found' }
    pruneStale(home, now, sessionId)
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(observerBase(home), { recursive: true, mode: 0o700 })
    fs.mkdirSync(bin, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700)
    const shim = path.join(dir, 'git-shim.mjs')
    fs.copyFileSync(SHIM_SOURCE, shim)
    fs.chmodSync(shim, 0o600)
    fs.copyFileSync(STAMP_SOURCE, path.join(dir, 'commit-stamp.mjs'))
    fs.chmodSync(path.join(dir, 'commit-stamp.mjs'), 0o600)
    const journal = path.join(dir, 'journal.jsonl')
    if (!fs.existsSync(journal)) fs.writeFileSync(journal, '', { mode: 0o600 })
    const previous = readPrivateJson(path.join(dir, 'observer.json'))
    writePrivateJson(path.join(dir, 'observer.json'), {
      v: 1,
      // A resumed or compacted conversation keeps its journal and what it has read.
      generation: typeof previous?.generation === 'string' ? previous.generation : crypto.randomUUID(),
      session_id: sessionId,
      base: observerBase(home),
      journal,
      real_git: realGit,
      // The plugin's own scripts, for the online check of a reference the model wrote (6fa0241e).
      plugin_root: path.resolve(path.dirname(SHIM_SOURCE), '..', '..'),
      // git's builtins, which run straight through the stand-in unless one is commit.
      builtins: gitBuiltins(realGit),
      // Where the plugin's hooks keep this conversation's claims (commit-provenance.mjs).
      claims_dir: stateDir(env),
      started_at: new Date(now).toISOString(),
    })
    // If node or the copy goes missing, git still runs.
    fs.writeFileSync(path.join(bin, 'git'), [
      '#!/bin/sh',
      `if [ -x ${shellQuote(forBash(nodePath))} ] && [ -f ${shellQuote(forBash(shim))} ]; then`,
      `  DEVSPEC_CLAUDE_GIT_OBSERVER=${shellQuote(forNode(dir))} exec ${shellQuote(forBash(nodePath))} ${shellQuote(forNode(shim))} "$@"`,
      'fi',
      `exec ${shellQuote(forBash(realGit))} "$@"`,
      '',
    ].join('\n'), { mode: 0o700 })
    fs.chmodSync(path.join(bin, 'git'), 0o700)
    fs.appendFileSync(envFile, `export PATH=${shellQuote(forBash(bin))}:"$PATH"\n`)
    return { ok: true, dir }
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) }
  }
}

/** Whether this conversation's commits are observed by the stand-in (commit-observation.mjs stands down). */
export function observerActive(sessionId, home = os.homedir()) {
  const dir = observerDir(sessionId, home)
  if (!dir) return false
  try {
    return fs.statSync(path.join(dir, 'bin', 'git')).isFile() && Boolean(readPrivateJson(path.join(dir, 'observer.json')))
  } catch {
    return false
  }
}

/** Remove the directories of conversations gone for a week, logging what they still held. */
function pruneStale(home, now, keep) {
  let names = []
  try { names = fs.readdirSync(observerBase(home)) } catch { return }
  for (const name of names) {
    if (name === keep || !SESSION_ID.test(name)) continue
    const dir = path.join(observerBase(home), name)
    try {
      const stat = fs.statSync(dir)
      if (!stat.isDirectory() || now - stat.mtimeMs < LIMITS.staleSessionMs) continue
      for (const item of readQueue(dir)) logOutcome({ outcome: 'dropped', reason: 'conversation ended without reporting it', session: name, sha: item.sha }, home)
      fs.rmSync(dir, { recursive: true, force: true })
    } catch { /* next */ }
  }
}

// ---------------------------------------------------------------------------
// Drain: journal -> queue -> report_commit_provenance.
// ---------------------------------------------------------------------------

function readQueue(dir) {
  const queue = readPrivateJson(path.join(dir, 'queue.json'))
  return Array.isArray(queue?.items) ? queue.items : []
}

function writeQueue(dir, items) {
  writePrivateJson(path.join(dir, 'queue.json'), { v: 1, items })
}

function validRow(row, config) {
  return row?.v === 1 && row.generation === config.generation && row.session_id === config.session_id &&
    UUID.test(row.observation_id ?? '') && FULL_SHA.test(row.sha ?? '') &&
    (row.connection_id === null || UUID.test(row.connection_id ?? '')) &&
    typeof row.worktree === 'string' && row.worktree.length > 0 &&
    (row.branch === null || typeof row.branch === 'string') &&
    (row.remote === null || typeof row.remote === 'string') && typeof row.amend === 'boolean'
}

/** Credential-bearing, local and unknown remotes are never sent (as in Pi). */
export function safeRemote(raw) {
  if (!raw) return null
  const value = String(raw).trim()
  if (!value || value.length > 512 || /[\s?#\u0000-\u001f\u007f]/u.test(value)) return null
  const scp = /^([^/@:]+)@([^/:]+):(.+)$/u.exec(value)
  if (scp) return scp[1] === 'git' ? value : null
  try {
    const url = new URL(value)
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || url.password || url.search || url.hash) return null
    if (url.username && !(url.protocol === 'ssh:' && url.username === 'git')) return null
    return value
  } catch {
    return null
  }
}

function withLock(dir, fn) {
  const lock = path.join(dir, 'drain.lock')
  try {
    fs.mkdirSync(lock)
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs < LIMITS.lockMs) return null
      fs.rmSync(lock, { recursive: true, force: true })
      fs.mkdirSync(lock)
    } catch {
      return null
    }
  }
  return Promise.resolve().then(fn).finally(() => {
    try { fs.rmSync(lock, { recursive: true, force: true }) } catch { /* next drain clears a stale one */ }
  })
}

/**
 * New journal lines, and where the journal has been read to. The caller records that
 * only once the queue holding them is written: a line is never lost, and one read
 * twice is the same report again, which DevSpec keeps once.
 */
function readJournal(dir, config, now) {
  let offset = 0
  try { offset = Number(fs.readFileSync(path.join(dir, 'journal.offset'), 'utf8')) || 0 } catch { offset = 0 }
  let data
  try { data = fs.readFileSync(config.journal) } catch { return { rows: [], offset } }
  if (offset > data.byteLength) offset = 0
  const tail = data.subarray(offset).toString('utf8')
  const end = tail.lastIndexOf('\n')
  if (end < 0) return { rows: [], offset }
  const next = offset + Buffer.byteLength(tail.slice(0, end + 1))
  const rows = []
  for (const line of tail.slice(0, end).split('\n')) {
    try {
      const row = JSON.parse(line)
      if (validRow(row, config)) rows.push({ ...row, attempts: 0, next_at: now, queued_at: now })
    } catch { /* a torn line is not a commit */ }
  }
  return { rows, offset: next }
}

/** report_commit_provenance's arguments for one commit, or why it cannot be sent. */
export function reportArguments(item, connectionId, { pin = findProjectPin } = {}) {
  const remote = safeRemote(item.remote)
  if (item.remote && !remote) return { skip: 'the repository origin carries credentials or is not a network address, so it is never sent' }
  let pinned = null
  if (!remote) {
    try { pinned = pin(item.worktree)?.project_id ?? null } catch { pinned = null }
    if (!pinned || !PROJECT_ID.test(pinned)) return { skip: 'the repository has no origin and no DevSpec project pin' }
  }
  return {
    args: {
      connection_id: connectionId,
      commit_sha: item.sha,
      observation_id: item.observation_id,
      ...(item.branch ? { branch: item.branch } : {}),
      ...(remote ? { git_remote: remote } : { pinned_project_id: pinned }),
    },
  }
}

function classify(error) {
  if (error instanceof McpToolRefusalError) return { retry: false, reason: error.message.slice(0, 500) }
  if (error?.code === 'timeout' || isRetryableHttpFailure(error) || /fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket/i.test(String(error?.message))) {
    return { retry: true, reason: String(error?.message ?? error).slice(0, 300) }
  }
  return { retry: false, reason: String(error?.message ?? error).slice(0, 500) }
}

/**
 * Report this conversation's waiting commits. `boundConnection(sessionId)` is the
 * conversation's connection state now (commit-observation.mjs); `call` is
 * mcpToolsCall. Returns what happened to each, for tests.
 */
export async function drainObserver({ sessionId, home = os.homedir(), now = Date.now(), boundConnection, call = mcpToolsCall, final = false } = {}) {
  const dir = observerDir(sessionId, home)
  if (!dir) return []
  const config = readPrivateJson(path.join(dir, 'observer.json'))
  if (!config || config.session_id !== sessionId) return []
  const outcomes = []
  const log = (item, outcome, reason) => {
    outcomes.push({ sha: item.sha, outcome, reason })
    logOutcome({ outcome, reason, session: sessionId, sha: item.sha, branch: item.branch ?? null, connection_id: item.connection_id ?? null }, home)
  }
  const ran = await withLock(dir, async () => {
    const journal = readJournal(dir, config, now)
    let queue = [...readQueue(dir), ...journal.rows]
    if (queue.length > LIMITS.queue) {
      for (const item of queue.slice(0, queue.length - LIMITS.queue)) log(item, 'dropped', `more than ${LIMITS.queue} commits waiting`)
      queue = queue.slice(-LIMITS.queue)
    }
    const state = boundConnection(sessionId)
    const kept = []
    let sent = 0
    for (const item of queue) {
      if (now - item.queued_at > LIMITS.ttlMs) { log(item, 'dropped', 'not reported within a day'); continue }
      if (!item.connection_id) { log(item, 'skipped', 'this conversation was not connected to DevSpec when the commit was made'); continue }
      if (!state?.connection_id || !state.token || !state.mcp_url) {
        if (final) log(item, 'dropped', 'the conversation ended while not connected to DevSpec')
        else kept.push(item)
        continue
      }
      if (state.connection_id.toLowerCase() !== item.connection_id) { log(item, 'skipped', 'made under a different connection than this conversation has now'); continue }
      if ((item.next_at > now && !final) || sent >= LIMITS.perDrain) { kept.push(item); continue }
      const prepared = reportArguments(item, state.connection_id)
      if (prepared.skip) { log(item, 'skipped', prepared.skip); continue }
      sent += 1
      try {
        const result = await call({
          mcpUrl: state.mcp_url,
          token: state.token,
          connectionCapability: state.connection_capability ?? null,
          name: 'report_commit_provenance',
          arguments: prepared.args,
          timeoutMs: LIMITS.callTimeoutMs,
        })
        if (result?.recorded === false) log(item, 'refused', String(result.message ?? 'not recorded').slice(0, 500))
        else log(item, 'reported', result?.repository_verified === false ? 'repository not verified' : null)
      } catch (error) {
        const { retry, reason } = classify(error)
        const attempts = (item.attempts ?? 0) + 1
        if (!retry) log(item, 'refused', reason)
        else if (attempts >= LIMITS.attempts || final) log(item, 'dropped', `${reason} (after ${attempts} attempt${attempts === 1 ? '' : 's'})`)
        else kept.push({ ...item, attempts, next_at: now + Math.min(10 * 60_000, 15_000 * 2 ** (attempts - 1)) })
      }
    }
    if (final) {
      for (const item of kept) log(item, 'dropped', 'the conversation ended before it could be reported')
      kept.length = 0
    }
    writeQueue(dir, kept)
    fs.writeFileSync(path.join(dir, 'journal.offset'), String(journal.offset), { mode: 0o600 })
    if (kept.length === 0) {
      try {
        // Only when the journal has nothing unread either: a commit noted meanwhile keeps it.
        const size = fs.statSync(config.journal).size
        const offset = Number(fs.readFileSync(path.join(dir, 'journal.offset'), 'utf8')) || 0
        if (offset >= size) fs.rmSync(path.join(dir, 'pending'), { force: true })
      } catch { /* the next drain looks again */ }
    }
  })
  return ran === null ? null : outcomes
}

/** SessionEnd: report what can be, log the rest, and remove the directory. */
export async function endObserver({ sessionId, home = os.homedir(), boundConnection, call = mcpToolsCall, now = Date.now() } = {}) {
  const dir = observerDir(sessionId, home)
  if (!dir || !fs.existsSync(dir)) return []
  const outcomes = await drainObserver({ sessionId, home, boundConnection, call, now, final: true }) ?? []
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* pruned later */ }
  return outcomes
}

// ---------------------------------------------------------------------------
// CLI (hooks)
// ---------------------------------------------------------------------------

function readHookInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}') } catch { return {} }
}

async function main(command) {
  const input = readHookInput()
  const sessionId = typeof input.session_id === 'string' ? input.session_id : null
  if (!sessionId) return
  if (command === 'session-start') {
    const result = startObserver({ sessionId, envFile: process.env.CLAUDE_ENV_FILE })
    if (!result.ok) logOutcome({ outcome: 'not observing', reason: result.reason, session: sessionId })
    return
  }
  const { boundConnection } = await import('./commit-observation.mjs')
  if (command === 'drain') await drainObserver({ sessionId, boundConnection })
  else if (command === 'session-end') await endObserver({ sessionId, boundConnection })
}

if (isEntryPoint(import.meta.url)) {
  // Hook stdout is context for the model: this says nothing there, and always exits 0.
  main(process.argv[2]).catch(() => {}).finally(() => process.exit(0))
}
