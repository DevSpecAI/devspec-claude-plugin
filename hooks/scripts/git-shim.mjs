#!/usr/bin/env node
/**
 * The git the agent's shell commands run in this conversation (item 604c360a,
 * after DevSpec-Pi's observer, item 2c971806).
 *
 * git-observer.mjs puts a directory holding a `git` stand-in first on the PATH of
 * every shell command Claude Code runs for this conversation, through the
 * environment file Claude Code applies to each one: the agent's own commands, its
 * subagents', background commands and Monitor commands alike. That stand-in runs
 * this script, copied into the conversation's private directory. It is not a git
 * hook, and nothing in any repository or git configuration changes.
 *
 * It runs the real git with the same arguments, input, output and exit status.
 * When git itself reports, through its Trace2 event stream, that the command was a
 * commit, and the repository shows a new commit made by it, one line is added to
 * the conversation's journal: the full commit id read from git, the branch, the
 * worktree, the previous head, whether it was an amend, the repository's origin,
 * and the connection this conversation was bound to at that moment. The model's
 * command is never read. Observation failing never changes what git does.
 *
 * Before git runs, a plain `git commit` in one of the connected project's
 * repositories gets the task tag added, or is stopped with what to do instead
 * (commit-stamp.mjs, item e597bc18). It works on git's own arguments, after the shell
 * has evaluated them, so every way of writing the message is the same here. A
 * reference the model wrote itself is confirmed online first, as decided in 6fa0241e.
 *
 * Another DevSpec plugin's stand-in can be on the same PATH, for example when this
 * agent runs Pi. This one never takes another for git, and never goes deeper than
 * git-stand-in.mjs allows (item 30978c06).
 *
 * Imports only Node built-ins, commit-stamp.mjs and git-stand-in.mjs, copied beside it:
 * this file runs as a copy, outside the plugin. The online check alone loads the plugin's own
 * scripts from where it is installed, and is skipped if they are not there.
 */

import { spawn, spawnSync } from 'node:child_process'
import { accessSync, appendFileSync, constants, mkdtempSync, readFileSync, realpathSync as realpathJs, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
import {
  ANY_REFERENCE, boundConnectionId, conversationClaims, gitIn, noClaimText, parseCommitArgs, projectScope,
  severalClaimsText, stampedText, tagMessage,
} from './commit-stamp.mjs'
import { MAX_STAND_IN_DEPTH, STAND_IN_DEPTH_ENV, isMarkedStandIn, loopStoppedText, standInDepth } from './git-stand-in.mjs'

const FULL_SHA = /^[0-9a-f]{40}$/u
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/u
const MAX_TRACE_BYTES = 1024 * 1024
const TRACE_CLOSE_GRACE_MS = 250
const MAX_JOURNAL_LINE = 8192
const WINDOWS = process.platform === 'win32'

/**
 * A path as the file system names it. On Windows the native form also settles the
 * letter case and the separators, so two spellings of one folder (git's C:/Users/…,
 * Node's C:\users\…) compare equal (item 4054ff58).
 */
function realpathSync(target) {
  return typeof realpathJs.native === 'function' ? realpathJs.native(target) : realpathJs(target)
}
const comparable = (target) => (WINDOWS ? target.toLowerCase() : target)

function readConfig(dir) {
  try {
    const config = JSON.parse(readFileSync(join(dir, 'observer.json'), 'utf8'))
    if (config?.v !== 1 || typeof config.generation !== 'string' || !SESSION_ID.test(config.session_id ?? '')) return null
    if (typeof config.base !== 'string' || typeof config.journal !== 'string') return null
    return config
  } catch {
    return null
  }
}

function inside(child, parent) {
  const c = comparable(child)
  const p = comparable(parent)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

function executable(file) {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * The git this shell would have run without the stand-in: the first one on PATH
 * outside every observer directory, so a stale stand-in can never call itself, and
 * not another DevSpec plugin's stand-in, which may well be calling this one.
 */
function realGitFor(config) {
  let base = null
  try { base = realpathSync(config.base) } catch { base = config.base }
  // Windows runs git.exe; the extensionless stand-in there is for Git Bash only.
  const name = WINDOWS ? 'git.exe' : 'git'
  const candidates = [...String(process.env.PATH || '').split(delimiter).filter(Boolean).map((dir) => join(dir, name)), config.real_git]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !executable(candidate)) continue
    let real
    try { real = realpathSync(candidate) } catch { continue }
    if (base && inside(real, base)) continue
    if (isMarkedStandIn(real)) continue
    return candidate
  }
  return null
}

function run(realGit, args, options = {}) {
  return spawnSync(realGit, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    timeout: 10_000,
  })
}

async function delegate(realGit, args, childEnv, input = null) {
  // Standard input this read (a message for -F -) goes to git byte for byte.
  const child = spawn(realGit, args, { cwd: process.cwd(), env: childEnv, stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'], windowsHide: true })
  if (input) {
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  }
  const forwarded = []
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    const handler = () => {
      try { child.kill(signal) } catch { /* best-effort forwarding */ }
    }
    try {
      process.on(signal, handler)
      forwarded.push([signal, handler])
    } catch { /* a signal this platform does not have */ }
  }
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: 126, signal: null, error }))
    child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal, error: null }))
  })
  for (const [signal, handler] of forwarded) process.off(signal, handler)
  return result
}

/**
 * Git's Trace2 events for this invocation. A Unix socket where there is one; on Windows,
 * where Git for Windows writes Trace2 only to a file, a file in a private directory.
 */
async function startTraceCapture() {
  if (WINDOWS) {
    const dir = mkdtempSync(join(tmpdir(), 'dsg-'))
    const file = join(dir, 't.json')
    writeFileSync(file, '', { mode: 0o600 })
    return {
      target: file,
      async finish() {
        try {
          if (statSync(file).size > MAX_TRACE_BYTES) return null
          return readFileSync(file, 'utf8')
        } finally {
          try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
        }
      },
    }
  }
  // A socket path is limited to about 100 bytes, which a home directory can exceed:
  // a private (0700) directory under the system temp directory keeps it short.
  const socketDir = mkdtempSync(join(tmpdir(), 'dsg-'))
  const socketPath = join(socketDir, 't.sock')
  const chunks = []
  const sockets = new Set()
  let bytes = 0
  let overflow = false
  let resolveIdle = null
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes <= MAX_TRACE_BYTES) chunks.push(chunk)
      else overflow = true
    })
    socket.on('close', () => {
      sockets.delete(socket)
      if (sockets.size === 0 && resolveIdle) {
        resolveIdle()
        resolveIdle = null
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    target: `af_unix:stream:${socketPath}`,
    async finish() {
      if (sockets.size > 0) {
        await Promise.race([
          new Promise((resolve) => { resolveIdle = resolve }),
          new Promise((resolve) => setTimeout(resolve, TRACE_CLOSE_GRACE_MS)),
        ])
      }
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(() => resolve()))
      try { rmSync(socketDir, { recursive: true, force: true }) } catch { /* best effort */ }
      return overflow ? null : Buffer.concat(chunks).toString('utf8')
    },
  }
}

function readTrace(raw) {
  if (!raw) return []
  const rows = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row === 'object') rows.push(row)
    } catch {
      return []
    }
  }
  return rows
}

/** git's own options before the command, so the repository is the one git will use. */
function gitGlobals(args) {
  const globals = []
  const takesValue = new Set(['-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path'])
  const flags = new Set(['--no-pager', '-P', '--paginate', '-p', '--bare', '--no-replace-objects', '--literal-pathspecs', '--no-literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks'])
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (takesValue.has(arg)) {
      if (typeof args[i + 1] !== 'string') return null
      globals.push(arg, args[i + 1])
      i += 1
    } else if ((arg.startsWith('-C') && arg.length > 2) || ['--config-env=', '--git-dir=', '--work-tree=', '--namespace=', '--super-prefix=', '--exec-path='].some((prefix) => arg.startsWith(prefix)) || flags.has(arg)) {
      globals.push(arg)
    } else if (arg.startsWith('-')) {
      return null
    } else {
      return { globals, command: arg }
    }
  }
  return null
}

function preflight(realGit, args, builtins) {
  const parsed = gitGlobals(args)
  if (!parsed) return null
  // A builtin other than commit cannot commit, and an alias cannot shadow a builtin:
  // such commands run straight through. commit, aliases and git-* programs are observed.
  if (parsed.command !== 'commit' && builtins.has(parsed.command)) return null
  const globals = parsed.globals
  const root = run(realGit, [...globals, 'rev-parse', '--show-toplevel'])
  if (root.status !== 0 || !root.stdout.trim()) return null
  let worktree
  try { worktree = realpathSync(root.stdout.trim()) } catch { return null }
  const before = run(realGit, [...globals, 'rev-parse', '--verify', 'HEAD^{commit}'])
  const head = before.status === 0 ? before.stdout.trim().toLowerCase() : ''
  return { worktree, previousHead: FULL_SHA.test(head) ? head : null }
}

/** The commit git ran for this invocation, from its own trace: never a hook's, never a guess. */
function directCommit(rows) {
  const rootSid = rows.find((row) => row.event === 'start' && typeof row.sid === 'string')?.sid
  if (!rootSid) return null
  const commit = rows.find((row) => {
    if (row.event !== 'cmd_name' || row.name !== 'commit' || typeof row.sid !== 'string') return false
    if (row.sid === rootSid && row.hierarchy === 'commit') return true
    // An alias runs in a child process; a hook's commit never counts.
    return row.sid.startsWith(`${rootSid}/`) && typeof row.hierarchy === 'string' &&
      row.hierarchy.includes('_run_git_alias_') && row.hierarchy.endsWith('/commit')
  })
  if (!commit) return null
  const start = rows.find((row) => row.event === 'start' && row.sid === commit.sid)
  const argv = Array.isArray(start?.argv) ? start.argv : []
  if (argv.includes('--dry-run')) return null
  const repo = rows.find((row) => row.event === 'def_repo' && row.sid === commit.sid && (row.repo === 1 || row.repo == null))
  if (!repo || typeof repo.worktree !== 'string' || !repo.worktree) return null
  return { worktree: repo.worktree, amend: argv.includes('--amend') }
}

function inspectCommit(realGit, worktree, previousHead, amend, startedAt, endedAt) {
  const head = run(realGit, ['-C', worktree, 'rev-parse', '--verify', 'HEAD^{commit}'])
  const sha = head.status === 0 ? head.stdout.trim().toLowerCase() : ''
  if (!FULL_SHA.test(sha) || sha === previousHead) return null
  const parentsOf = (rev) => {
    const line = run(realGit, ['-C', worktree, 'rev-list', '--parents', '-n', '1', rev])
    return line.status === 0 ? line.stdout.trim().split(/\s+/u).slice(1) : null
  }
  const parents = parentsOf(sha)
  if (!parents) return null
  if (previousHead === null) {
    if (amend || parents.length !== 0) return null
  } else if (amend) {
    const prior = parentsOf(previousHead)
    if (!prior || parents.length !== prior.length || parents.some((parent, index) => parent !== prior[index])) return null
  } else if (parents.length !== 1 || parents[0] !== previousHead) {
    return null // a merge being completed, or a hook that moved HEAD
  }
  // The new commit is HEAD and the newest HEAD reflog entry, made during this command.
  const reflog = run(realGit, ['-C', worktree, 'reflog', 'show', '-2', '--format=%H%x09%gs%x09%ct', 'HEAD'])
  if (reflog.status !== 0) return null
  const entries = reflog.stdout.trim().split('\n').filter(Boolean).map((line) => line.split('\t'))
  const [reflogSha = '', action = '', reflogEpoch = ''] = entries[0] ?? []
  const priorReflogSha = entries[1]?.[0]?.toLowerCase() ?? null
  const expected = previousHead === null ? /^commit \(initial\):/u : amend ? /^commit \(amend\):/u : /^commit:/u
  if (reflogSha.toLowerCase() !== sha || !expected.test(action)) return null
  if (previousHead === null ? entries.length !== 1 : priorReflogSha !== previousHead) return null
  const epochMs = Number.parseInt(reflogEpoch, 10) * 1000
  if (!Number.isFinite(epochMs) || epochMs < startedAt - 2000 || epochMs > endedAt + 2000) return null
  const branch = run(realGit, ['-C', worktree, 'symbolic-ref', '--quiet', '--short', 'HEAD'])
  const origin = run(realGit, ['-C', worktree, 'remote', 'get-url', 'origin'])
  return {
    sha,
    branch: branch.status === 0 && branch.stdout.trim() ? branch.stdout.trim().slice(0, 255) : null,
    remote: origin.status === 0 && origin.stdout.trim() ? origin.stdout.trim().slice(0, 1024) : null,
    previousHead,
    amend,
  }
}

/**
 * What to run for this invocation. A plain `git commit` in the connected project's
 * repositories, with no reference in its message, gets the tag of the one task this
 * conversation has claimed, or is stopped: with no claim, and with several. Anything
 * else runs exactly as written, and a message read from standard input is passed on
 * byte for byte. Never throws.
 */
/**
 * Is a reference the model wrote to a task that exists? (6fa0241e, kept by item
 * e597bc18.) The plugin's own check from 0.17.0, run from where the plugin is
 * installed: the same transport and credentials (mcp-call.mjs, resolve-mcp-auth.mjs,
 * credentials following the repository's main working tree), the same project hints
 * and the same 2.5 second bound. Only a definitive answer that it resolves to nothing
 * stops the commit; anything else, including the plugin not being where it was, lets
 * it through. Returns the text to stop with, or null.
 */
async function unresolvedReference(text, { cwd, git, config }) {
  try {
    const scripts = join(config.plugin_root, 'hooks', 'scripts')
    const provenance = await import(pathToFileURL(join(scripts, 'commit-provenance.mjs')).href)
    const reference = provenance.referenceIn(text)
    if (!reference) return null // not a well-formed reference: nothing to look up
    const { findProjectPin } = await import(pathToFileURL(join(scripts, 'devspec-scope.mjs')).href)
    const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'])
    const mainWorktree = common && basename(resolve(common)) === '.git' ? dirname(resolve(common)) : null
    let marker = null
    // The pin, as a hint for which project to ask about (pinned_project_id).
    try {
      const pin = findProjectPin(cwd, { home: homedir(), mainWorktree })
      marker = pin ? { kind: 'pin', project_id: pin.project_id } : null
    } catch { marker = null }
    const outcome = await provenance.confirmReferenceOnline(text, { cwd, mainWorktree, marker, localId: config.session_id })
    return outcome === 'not_found' ? provenance.unresolvedReferenceText(reference) : null
  } catch {
    return null
  }
}

async function planCommit(realGit, args, config, dir) {
  let input = null
  try {
    if (typeof config.claims_dir !== 'string') return { args } // claims cannot be read: leave it to git
    const parsed = gitGlobals(args)
    if (!parsed || parsed.command !== 'commit') return { args }
    const at = parsed.globals.length + 1
    const commit = parseCommitArgs(args.slice(at))
    if (!commit.known || commit.reuse || commit.amend || commit.noEdit || commit.edit || commit.dryRun) return { args }
    const sources = commit.messages.length + commit.files.length
    if (sources === 0 || (commit.messages.length > 0 && commit.files.length > 0) || commit.files.length > 1) return { args }
    let cwd = process.cwd()
    for (let i = 0; i < parsed.globals.length; i += 1) {
      if (parsed.globals[i] === '-C') { cwd = resolve(cwd, parsed.globals[i + 1]); i += 1 } else if (parsed.globals[i].startsWith('-C')) cwd = resolve(cwd, parsed.globals[i].slice(2))
    }
    const git = gitIn(realGit, cwd)
    const top = git(['rev-parse', '--show-toplevel'])
    if (!top) return { args }
    const scope = projectScope({ cwd: realpathSync(cwd), worktree: realpathSync(top), sessionId: config.session_id, home: homedir(), git })
    if (!scope.inScope) return { args }

    const file = commit.files[0] ?? null
    let text = null
    if (file) {
      let bytes = null
      if (file.value === '-') {
        bytes = readFileSync(0)
        input = bytes
      } else {
        try { bytes = readFileSync(resolve(cwd, file.value)) } catch { bytes = null }
      }
      const decoded = bytes ? bytes.toString('utf8') : null
      text = decoded !== null && Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : null
    } else {
      text = commit.messages.map((message) => message.value).join('\n\n')
    }
    // Unreadable, or it already names a task: git gets exactly what it was given.
    if (text === null) return { args, input }
    // A reference the model wrote is never replaced, and is confirmed online before git
    // runs. A commit without one makes no network call.
    if (ANY_REFERENCE.test(text)) {
      const stop = typeof config.plugin_root === 'string' ? await unresolvedReference(text, { cwd, git, config }) : null
      return stop ? { stop } : { args, input }
    }

    const claims = conversationClaims({ sessionId: config.session_id, stateDir: config.claims_dir })
    if (claims.length === 0) return { stop: noClaimText() }
    if (claims.length > 1) return { stop: severalClaimsText(claims) }
    const id = claims[0]
    const next = [...args]
    if (file) {
      const tagged = tagMessage(text, id)
      if (tagged === null) return { args, input }
      // A private copy: the person's own file is never edited.
      const copy = join(dir, `commit-message-${randomUUID()}.txt`)
      writeFileSync(copy, tagged, { mode: 0o600 })
      next[at + file.index] = `${file.prefix}${copy}`
      return { args: next, copy, stamped: id }
    }
    const part = commit.messages.find((message) => tagMessage(message.value, id) !== null)
    if (!part) return { args }
    next[at + part.index] = `${part.prefix}${tagMessage(part.value, id)}`
    return { args: next, stamped: id }
  } catch {
    return { args, input }
  }
}

// Started inside another stand-in's work: go no deeper than the plugins agree, and
// make everything started from here, git included, one level deeper.
const depth = standInDepth(process.env)
if (depth >= MAX_STAND_IN_DEPTH) {
  process.stderr.write(`${loopStoppedText()}\n`)
  process.exit(126)
}
process.env[STAND_IN_DEPTH_ENV] = String(depth + 1)

let dir = process.env.DEVSPEC_CLAUDE_GIT_OBSERVER
let config = dir ? readConfig(dir) : null
const realGit = config ? realGitFor(config) : null
const args = process.argv.slice(2)
if (!realGit) {
  process.stderr.write('git: DevSpec could not find git on PATH\n')
  process.exit(127)
}

// The commit belongs to the conversation running the command. After /clear, or in a
// nested `claude` that inherited this PATH, that is another conversation: its own
// observer records it, and with none it is nobody's here.
const session = process.env.CLAUDE_CODE_SESSION_ID
if (config && session && session !== config.session_id) {
  const other = SESSION_ID.test(session) ? join(config.base, session) : null
  const otherConfig = other ? readConfig(other) : null
  dir = otherConfig ? other : null
  config = otherConfig
}
// Inside another stand-in's work (another plugin's, or a git hook under one), the
// commit is that one's to tag and record: git runs straight through.
const eligible = Boolean(config && depth === 0 && !process.env.GIT_TRACE2_EVENT && !process.env.GIT_TRACE2)
const builtins = new Set(Array.isArray(config?.builtins) ? config.builtins : [])
const plan = eligible ? await planCommit(realGit, args, config, dir) : { args }
if (plan.stop) {
  // Stopped before git runs: the repository is exactly as it was.
  process.stderr.write(`${plan.stop}\n`)
  process.exit(1)
}
const before = eligible ? preflight(realGit, plan.args, builtins) : null
let capture = null
let childEnv = process.env
if (before) {
  try {
    capture = await startTraceCapture()
    childEnv = { ...process.env, GIT_TRACE2_EVENT: capture.target }
  } catch {
    capture = null
  }
}

const startedAt = Date.now()
const result = await delegate(realGit, plan.args, childEnv, plan.input ?? null)
const endedAt = Date.now()
if (plan.copy) { try { rmSync(plan.copy, { force: true }) } catch { /* removed with the conversation */ } }
if (plan.stamped && result.code === 0 && !result.signal) process.stderr.write(`${stampedText(plan.stamped)}\n`)
const trace = capture ? await capture.finish().catch(() => null) : null

try {
  if (trace && result.code === 0 && !result.signal) {
    const found = directCommit(readTrace(trace))
    let worktree = null
    try { worktree = found ? realpathSync(found.worktree) : null } catch { worktree = null }
    const commit = found && worktree && comparable(worktree) === comparable(before.worktree)
      ? inspectCommit(realGit, worktree, before.previousHead, found.amend, startedAt, endedAt)
      : null
    if (commit) {
      const line = JSON.stringify({
        v: 1,
        generation: config.generation,
        session_id: config.session_id,
        connection_id: boundConnectionId(config.session_id, homedir()),
        observation_id: randomUUID(),
        sha: commit.sha,
        branch: commit.branch,
        worktree,
        remote: commit.remote,
        previous_head: commit.previousHead,
        amend: commit.amend,
        observed_at: new Date(endedAt).toISOString(),
      })
      if (Buffer.byteLength(line) <= MAX_JOURNAL_LINE) {
        appendFileSync(config.journal, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
        writeFileSync(join(dir, 'pending'), '', { mode: 0o600 })
      }
    }
  }
} catch {
  // Observation never affects git.
}

if (result.error) {
  process.stderr.write(`git: ${result.error.message}\n`)
  process.exit(126)
}
if (result.signal) {
  try { process.kill(process.pid, result.signal) } catch { process.exit(1) }
}
process.exit(result.code)
