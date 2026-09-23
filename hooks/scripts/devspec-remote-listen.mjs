#!/usr/bin/env node
/**
 * The DevSpec listener Claude Code starts with every interactive session (item b7ef1fe2).
 *
 * Declared in plugin.json as a plugin MONITOR, so Claude Code launches it by itself at
 * session start and keeps it for the lifetime of the session. It connects this
 * conversation to DevSpec and then streams the connection's inbox, and every stdout
 * line it produces reaches the model as a notification. That is the whole point: the
 * model is not involved until a person actually sends something.
 *
 * What that replaces, measured on 2026-09-23 against Claude Code 2.1.280:
 *   - `/devspec.remote` put the command file, the connect output and the tier texts
 *     into the conversation before anyone had asked for anything;
 *   - the Monitor tool the model then armed is capped at 30 minutes on the schema
 *     Claude Code now serves, so an idle agent woke itself every half hour just to
 *     re-arm (memory d4a7d4fc: ~$0.19–0.24 a wake, ~$9–11 a day per idle session).
 * A plugin monitor has neither cost: it starts without a turn and it is not capped.
 *
 * ## The one rule: stdout is the model's ear
 *
 * Anything written to stdout starts a model turn. So this process never writes there
 * itself — status, refusals and diagnostics go to a private log — and the only thing
 * on stdout is what `devspec-remote-wait.mjs --stream` emits for owner mail. A listener
 * that prints "connected" at startup would cost the very turn it exists to avoid.
 *
 * ## Standing down is silent, and it does not exit
 *
 * Most folders a person opens Claude Code in are not DevSpec projects, and some people
 * turn this off. In every such case the listener goes DORMANT: it stays alive, says
 * nothing, and exits only when Claude Code does. Exiting would end the monitor, and
 * Claude Code tells the model when a monitor ends — a wake about nothing.
 *
 * ## One reader per inbox
 *
 * If something already holds this connection's wake (a Monitor armed by an older
 * `/devspec.remote` in the same conversation), the listener does not start a second
 * reader: two readers race one byte-offset cursor. The existing listener pidfile is
 * the arbiter, exactly as the Stop hook reads it.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connect, ConnectError } from './devspec-remote-connect.mjs'
import { isWaitArmed, EXIT_REARM, EXIT_TERMINAL } from './devspec-remote-wait.mjs'
import { storeTiers } from './instruction-tiers.mjs'
import { readPrivateJsonResult, STATE_OK } from './private-state.mjs'
import { detectLocalId } from './remote-control-state.mjs'
import { resolveClaudePid, STARTUP_DIR, startupFilePath, writeListenerMarker } from './startup-listener.mjs'

export { resolveClaudePid }

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const WAIT_SCRIPT = path.join(THIS_DIR, 'devspec-remote-wait.mjs')
const LISTEN_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'listen')

/** Retry schedule for a server that gave no verdict (down, redeploying, offline laptop). */
export const UNREACHABLE_RETRY_MS = [5_000, 30_000, 120_000, 600_000]
/** How long to wait for the SessionStart hook's startup file when env carries no key. */
const STARTUP_FILE_WAIT_MS = 20_000
const OWNER_POLL_MS = 5_000

/** Failures that are answers, not outages: never retried. */
const TERMINAL_REASONS = new Set([
  'folder_not_linked',
  'register_refused',
  'auth',
  'server_scope_unproven',
  'bad_args',
  'node_version',
])

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !!e && e.code === 'EPERM'
  }
}

/**
 * Is connecting at startup switched on? The `connect_at_startup` userConfig option,
 * default on. Only an explicit false-ish value turns it off, so a missing or garbled
 * value never silently disables the feature a person installed the plugin for.
 */
export function connectAtStartupEnabled(env = process.env, fileValue = undefined) {
  const raw =
    env.CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP ??
    env.CLAUDE_PLUGIN_OPTION_connect_at_startup ??
    (fileValue === undefined ? undefined : String(fileValue))
  if (raw === undefined || raw === null) return true
  return !/^(false|0|no|off)$/i.test(String(raw).trim())
}

/**
 * The plugin's configuration as the SessionStart hook recorded it for this session.
 *
 * Claude Code gives plugin settings to HOOKS, not to monitors. The SessionStart hook
 * already carries them into the session environment, and a monitor started after it
 * inherits them — observed, not promised. So the hook also files them privately, keyed
 * by session, and this waits briefly for that file when the environment has no key:
 * whichever of the two starts first, the listener still finds its configuration.
 */
export async function readStartupConfig(sessionId, { env = process.env, waitMs = STARTUP_FILE_WAIT_MS, dir = STARTUP_DIR, sleepFn = sleep } = {}) {
  // Any key the resolver already reads from the environment — the plugin's own, or an
  // explicit override — means there is nothing to wait for.
  const envToken =
    env.CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN ||
    env.CLAUDE_PLUGIN_OPTION_devspec_token ||
    env.DEVSPEC_MCP_TOKEN ||
    env.DEVSPEC_TOKEN
  if (envToken || !sessionId) return null
  const deadline = Date.now() + waitMs
  for (;;) {
    const read = readPrivateJsonResult(startupFilePath(sessionId, dir))
    if (read.status === STATE_OK && read.value) return read.value
    if (Date.now() >= deadline) return null
    await sleepFn(500)
  }
}

/** Merge a startup file into the environment connect() reads, without overriding env. */
export function envWithStartupConfig(env, config) {
  if (!config?.token) return env
  return {
    ...env,
    CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: config.token,
    CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: config.mcp_url || env.CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL,
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function openLog(name) {
  try {
    fs.mkdirSync(LISTEN_DIR, { recursive: true, mode: 0o700 })
    const file = path.join(LISTEN_DIR, `${String(name).replace(/[^a-zA-Z0-9._-]/g, '') || process.pid}.log`)
    const fd = fs.openSync(file, 'a', 0o600)
    return {
      fd,
      write: (message, detail = {}) => {
        try {
          fs.writeSync(fd, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, message, ...detail }) + '\n')
        } catch {
          /* a log we cannot write must never cost the listener */
        }
      },
    }
  } catch {
    return { fd: 'ignore', write: () => {} }
  }
}

/**
 * Stay alive, silently, until Claude Code goes. See the header for why dormant never
 * exits early. Without an owner to watch it falls back to its parent shell.
 */
async function dormant(ownerPid, log, reason, detail = {}) {
  log.write('dormant', { reason, ...detail })
  const watch = ownerPid || process.ppid
  while (pidAlive(watch)) await sleep(OWNER_POLL_MS)
  log.write('owner gone — exiting', { owner_pid: watch })
  process.exit(0)
}

/**
 * A signal means Claude Code (or a person) is stopping this monitor — when the session
 * ends, or when someone stops it from the task panel. It must always win.
 *
 * Installed ONCE, before anything else. The first version forwarded the signal to the
 * stream child and then treated the child's exit like any other: the child exits 3 on a
 * signal, the owner was still alive in that instant, so the listener re-armed — and a
 * monitor could not be stopped while Claude Code ran. Now a signal kills the current
 * child if there is one and exits, and nothing re-arms after it.
 */
let stopping = false
let currentChild = null
function installStopHandlers(log) {
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => {
      if (stopping) return
      stopping = true
      log.write('stopping', { signal: sig })
      const child = currentChild
      if (!child) process.exit(0)
      try {
        child.kill(sig)
      } catch {
        process.exit(0)
      }
      // Never outlive a child that ignores the signal.
      setTimeout(() => process.exit(0), 3_000).unref()
    })
  }
}

/**
 * Run the wake stream as a child whose stdout IS this process's stdout. Resolves with
 * the child's exit; the caller decides whether to re-arm.
 */
function runStream({ connectionId, ownerPid, cursorFlag, log }) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [WAIT_SCRIPT, '--connection-id', connectionId, '--owner-pid', String(ownerPid), '--stream', cursorFlag],
      { stdio: ['ignore', 'inherit', log.fd === 'ignore' ? 'ignore' : log.fd] },
    )
    currentChild = child
    child.on('exit', (code, signal) => {
      currentChild = null
      resolve({ code, signal })
    })
    child.on('error', (error) => {
      currentChild = null
      resolve({ code: null, signal: null, error })
    })
  })
}

async function main() {
  const env = process.env
  const detected = detectLocalId({}, env)
  const localId = detected.local_id
  const log = openLog(localId || `pid-${process.pid}`)
  installStopHandlers(log)
  const ownerPid = resolveClaudePid(env)
  const cwd = process.cwd()
  log.write('start', { local_id: localId, owner_pid: ownerPid, cwd })

  if (!ownerPid) return dormant(null, log, 'no_owner_pid')
  if (!localId) return dormant(ownerPid, log, 'no_conversation_id')

  const config = await readStartupConfig(localId, { env })
  if (!connectAtStartupEnabled(env, config?.connect_at_startup)) {
    return dormant(ownerPid, log, 'turned_off')
  }
  const connectEnv = envWithStartupConfig(env, config)

  let summary = null
  for (let attempt = 0; ; attempt++) {
    try {
      summary = await connect(
        { startup: true, ownerPid, cwd, localId, env: connectEnv },
        { onRetryMessage: (message) => log.write('retry', { detail: message.trim() }) },
      )
      break
    } catch (e) {
      const reason = e instanceof ConnectError ? e.reason : 'unexpected'
      log.write('connect failed', { reason, error: e?.message })
      if (TERMINAL_REASONS.has(reason)) return dormant(ownerPid, log, reason)
      const wait = UNREACHABLE_RETRY_MS[Math.min(attempt, UNREACHABLE_RETRY_MS.length - 1)]
      await sleep(wait)
      if (!pidAlive(ownerPid)) process.exit(0)
    }
  }

  const connectionId = summary.connection_id
  log.write('connected', {
    connection_id: connectionId,
    codename: summary.codename,
    bond_action: summary.bond_action,
    created: summary.created,
    poller: summary.poller?.ok ? 'running' : summary.warning_poller || 'not running',
  })
  if (storeTiers(connectionId, summary.registration)) log.write('tiers filed for the first command')

  if (!summary.poller?.ok) return dormant(ownerPid, log, 'poller_not_running', { warning: summary.warning_poller })
  if (isWaitArmed(connectionId)) return dormant(ownerPid, log, 'already_listening', { connection_id: connectionId })

  writeListenerMarker(connectionId, { ownerPid, localId })
  let cursorFlag = summary.cursor_flag
  for (;;) {
    const { code, signal, error } = await runStream({ connectionId, ownerPid, cursorFlag, log })
    log.write('stream ended', { code, signal, error: error?.message })
    if (stopping || !pidAlive(ownerPid)) process.exit(0)
    if (code === EXIT_REARM) {
      // A rollover is routine: resume from the saved offset so nothing is lost.
      cursorFlag = '--pending'
      continue
    }
    if (code === EXIT_TERMINAL) return dormant(ownerPid, log, 'connection_ended', { connection_id: connectionId })
    return dormant(ownerPid, log, 'stream_failed', { connection_id: connectionId, code })
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  main().catch((e) => {
    // Still never stdout. A crash here must not wake anyone; it is logged and the
    // process stays dormant so the monitor does not end.
    const log = openLog(`crash-${process.pid}`)
    log.write('listener crashed', { error: e?.stack || String(e) })
    dormant(resolveClaudePid(process.env), log, 'crashed')
  })
}
