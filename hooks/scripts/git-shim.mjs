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
 * Imports only Node built-ins: this file runs as a copy, outside the plugin.
 */

import { spawn, spawnSync } from 'node:child_process'
import { accessSync, appendFileSync, constants, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import { createServer } from 'node:net'

const FULL_SHA = /^[0-9a-f]{40}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/u
const MAX_TRACE_BYTES = 1024 * 1024
const TRACE_CLOSE_GRACE_MS = 250
const MAX_JOURNAL_LINE = 8192

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
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
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
 * outside every observer directory, so a stale stand-in can never call itself.
 */
function realGitFor(config) {
  let base = null
  try { base = realpathSync(config.base) } catch { base = config.base }
  const candidates = [...String(process.env.PATH || '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'git')), config.real_git]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !executable(candidate)) continue
    let real
    try { real = realpathSync(candidate) } catch { continue }
    if (base && inside(real, base)) continue
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

async function delegate(realGit, args, childEnv) {
  const child = spawn(realGit, args, { cwd: process.cwd(), env: childEnv, stdio: 'inherit', windowsHide: true })
  const forwarded = []
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    const handler = () => {
      try { child.kill(signal) } catch { /* best-effort forwarding */ }
    }
    process.on(signal, handler)
    forwarded.push([signal, handler])
  }
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: 126, signal: null, error }))
    child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal, error: null }))
  })
  for (const [signal, handler] of forwarded) process.off(signal, handler)
  return result
}

async function startTraceCapture() {
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
 * The connection this conversation is bound to now, by the rule the plugin's hooks
 * use (commit-observation.mjs boundConnection): exactly one enabled connection whose
 * conversation is this one. Attribution only; nothing else is read from the file.
 */
function boundConnection(sessionId) {
  const dir = join(homedir(), '.devspec', 'remote-control', 'connections')
  const found = new Set()
  let names = []
  try { names = readdirSync(dir) } catch { return null }
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.json$/iu.test(name)) continue
    try {
      const text = readFileSync(join(dir, name), 'utf8')
      if (!text.includes(sessionId)) continue
      const state = JSON.parse(text)
      if (state?.enabled === true && state.local_id === sessionId && UUID.test(state.connection_id ?? '')) found.add(state.connection_id.toLowerCase())
    } catch { /* a file being rewritten is not a bond */ }
  }
  return found.size === 1 ? [...found][0] : null
}

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
const eligible = Boolean(config && !process.env.GIT_TRACE2_EVENT && !process.env.GIT_TRACE2)
const builtins = new Set(Array.isArray(config?.builtins) ? config.builtins : [])
const before = eligible ? preflight(realGit, args, builtins) : null
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
const result = await delegate(realGit, args, childEnv)
const endedAt = Date.now()
const trace = capture ? await capture.finish().catch(() => null) : null

try {
  if (trace && result.code === 0 && !result.signal) {
    const found = directCommit(readTrace(trace))
    let worktree = null
    try { worktree = found ? realpathSync(found.worktree) : null } catch { worktree = null }
    const commit = found && worktree === before.worktree
      ? inspectCommit(realGit, worktree, before.previousHead, found.amend, startedAt, endedAt)
      : null
    if (commit) {
      const line = JSON.stringify({
        v: 1,
        generation: config.generation,
        session_id: config.session_id,
        connection_id: boundConnection(config.session_id),
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
