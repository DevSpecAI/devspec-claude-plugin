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
 * ## A folder that is not linked YET keeps watching (item fa9b809b)
 *
 * A greenfield folder often becomes a DevSpec folder mid-session: the agent writes the
 * `.devspec/project.json` pin once the person names the project, or adds an `origin`
 * that DevSpec already tracks. So when the only reason to stand down is that the
 * folder names no project, the listener waits — silently, on a few stat calls every
 * few seconds, never git or the network — and connects the moment that changes. Every
 * other reason to stand down (switched off, no key, a refused key) stays dormant.
 *
 * ## Once connected, it keeps the connection — and only its own (item 7e35d818)
 *
 * After connecting, the listener SERVES the connection for as long as Claude Code runs:
 * a reconcile loop that, while this process owns an enabled connection, keeps exactly
 * one wake reader armed and the poller running. A poller that dies while the terminal
 * is open (killed, crashed, swept by the server after a missed heartbeat) is repaired
 * by connecting this conversation again, which brings the same connection back in
 * place. Nothing else in the plugin may end a connection: a person ending it, the
 * session closing, or the owning process going are the only ends.
 *
 * Ownership is the connection state's `owner_pid`, which connect writes. Resuming the
 * same conversation in another window (`claude --resume <id>`) connects it from there
 * and so moves it: this listener's stream stands down silently, its loop stops arming
 * and repairing, and the new window's listener takes the wake. A conversation id is
 * unique to one conversation, so a different window can never take over by accident.
 *
 * One reader per inbox: two readers race one byte-offset cursor. If something of this
 * process already holds the wake (a Monitor armed by `/devspec.remote`), the listener
 * does not arm a second reader; the wait itself refuses to start beside another.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connect, ConnectError } from './devspec-remote-connect.mjs'
import { closeClaudeCodeOnEnd } from './close-on-end.mjs'
import { findProjectPin, folderLinkFingerprint, gitRemoteOrigin } from './devspec-scope.mjs'
import { conversationProjectFingerprint, readConversationProject } from './conversation-project.mjs'
import { EXIT_REARM, EXIT_SUPERSEDED, waitHolderPid } from './devspec-remote-wait.mjs'
import { storeTiers } from './instruction-tiers.mjs'
import { readPrivateJsonResult, STATE_OK } from './private-state.mjs'
import { detectLocalId, pollerRunning, recordConnectionEvent } from './remote-control-state.mjs'
import {
  ownedByAnotherProcess,
  ownedByProcess,
  readOwnedConnectionPointer,
  removeOwnerListenerFiles,
  resolveClaudePid,
  STARTUP_DIR,
  startupFilePath,
  writeListenerMarker,
  writeOwnerListenerStatus,
} from './startup-listener.mjs'

export { resolveClaudePid }

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const WAIT_SCRIPT = path.join(THIS_DIR, 'devspec-remote-wait.mjs')
const LISTEN_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'listen')
const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

/** How often a serving listener reconciles the wake reader and the poller. */
export const SERVE_TICK_MS = 5_000
/** A poller found missing on this many consecutive ticks is repaired. */
export const POLLER_MISSES_BEFORE_REPAIR = 2
/** Wait before each repeated repair; reset once the poller has stayed up a while. */
export const REPAIR_BACKOFF_MS = [0, 60_000, 120_000, 300_000, 900_000]
const REPAIR_STABLE_MS = 10 * 60_000
/** A stream that ends this soon after arming, for no known reason, was a failure. */
const STREAM_FAST_FAIL_MS = 10_000
const STREAM_RETRY_MS = [5_000, 30_000, 120_000]
/** How often a dormant listener looks for a connection this process made by hand. */
const DORMANT_WATCH_MS = 2_000

/** Retry schedule for a server that gave no verdict (down, redeploying, offline laptop). */
export const UNREACHABLE_RETRY_MS = [5_000, 30_000, 120_000, 600_000]
/** How long to wait for the SessionStart hook's startup file when env carries no key. */
const STARTUP_FILE_WAIT_MS = 20_000
const OWNER_POLL_MS = 5_000
/** How often an unlinked folder is re-checked: a handful of stat calls, nothing else. */
export const LINK_WATCH_MS = 3_000

/** Failures that are answers, not outages: never retried as they stand. */
const TERMINAL_REASONS = new Set([
  'folder_not_linked',
  'register_refused',
  'auth',
  'server_scope_unproven',
  'bad_args',
  'node_version',
])

/**
 * The answers a change to the folder itself can overturn. `folder_not_linked` is "this
 * folder names no project"; `register_refused` is the server declining the project the
 * folder named (a remote DevSpec does not track, a pin to a project this key cannot
 * see), which a new pin or remote can fix just as well. The rest are about the key or
 * the install, and nothing in the folder changes them.
 */
export const WAIT_FOR_LINK_REASONS = new Set(['folder_not_linked', 'register_refused'])

/** Does anything in this folder name a DevSpec project right now? */
function folderNamesProject(cwd) {
  return Boolean(findProjectPin(cwd) || gitRemoteOrigin(cwd))
}

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
async function dormant(ownerPid, log, reason, detail = {}, { serveContext = null } = {}) {
  log.write('dormant', { reason, ...detail })
  // With a context to serve in, a dormant listener still keeps any connection this
  // process makes by hand (`/devspec.remote`): it follows the owner pointer connect
  // writes, and serves what it finds exactly as if it had connected it itself.
  const watching = Boolean(serveContext && ownerPid)
  if (ownerPid) writeOwnerListenerStatus(ownerPid, watching ? 'watching' : 'dormant', { reason })
  const watch = ownerPid || process.ppid
  while (pidAlive(watch)) {
    await sleep(watching ? DORMANT_WATCH_MS : OWNER_POLL_MS)
    if (!watching || stopping) continue
    const connectionId = readOwnedConnectionPointer(ownerPid)
    const state = connectionId ? readConnectionState(connectionId) : null
    if (state && classifyConnection(state, ownerPid) === 'mine') {
      log.write('serving a connection this session made', { connection_id: connectionId })
      return serve({ ...serveContext, connectionId, cursorFlag: '--pending', localId: state.local_id || serveContext.localId })
    }
  }
  log.write('owner gone — exiting', { owner_pid: watch })
  if (ownerPid) removeOwnerListenerFiles(ownerPid)
  process.exit(0)
}

function readConnectionState(connectionId, dir = CONNECTIONS_DIR) {
  const read = readPrivateJsonResult(path.join(dir, `${connectionId}.json`))
  return read.status === STATE_OK ? read.value : null
}

/**
 * Whose is this connection, from this process's side? The whole ownership policy:
 *   mine       — enabled, not ended from DevSpec, and this process owns it
 *   ended      — a person ended it (UI End, /devspec.remote-stop) or its owner exited
 *   superseded — another live Claude Code process owns it (resumed elsewhere)
 *   not_mine   — anything else, e.g. never this process's
 */
export function classifyConnection(state, ownerPid, { owns = ownedByProcess, ownedElsewhere = ownedByAnotherProcess } = {}) {
  if (!state) return 'not_mine'
  if (state.enabled === false || state.ended_from_ui === true || state.end_reason === 'ui') return 'ended'
  if (ownedElsewhere(state, ownerPid)) return 'superseded'
  return owns(state, ownerPid) ? 'mine' : 'not_mine'
}

/**
 * One reconcile decision for a serving listener, as data (unit-tested): arm a reader?
 * repair the poller? Only ever for a connection this process owns.
 */
export function reconcileStep({ standing, streaming, waitHeld, pollerUp, misses = 0, now = Date.now(), repairNotBefore = 0, streamNotBefore = 0 }) {
  if (standing !== 'mine') return { arm: false, repair: false, misses: 0 }
  const nextMisses = pollerUp ? 0 : misses + 1
  return {
    arm: !streaming && !waitHeld && now >= streamNotBefore,
    repair: !pollerUp && nextMisses >= POLLER_MISSES_BEFORE_REPAIR && now >= repairNotBefore,
    misses: nextMisses,
  }
}

/**
 * Wait, silently, until the folder could name a project it did not name before.
 *
 * Resolves `true` once the stat fingerprint has changed AND the real lookup (pin, or
 * `git remote get-url origin`) finds something, so git runs only after a relevant file
 * actually moved. Resolves `false` when the owner goes, so the caller exits. A change
 * that still names nothing (a `git init` with no remote yet, a half-written pin) just
 * becomes the new baseline and the watch carries on.
 */
export async function waitForFolderLink(
  cwd,
  {
    ownerAlive,
    fingerprint = folderLinkFingerprint,
    namesProject = folderNamesProject,
    sleepFn = sleep,
    watchMs = LINK_WATCH_MS,
    log = { write: () => {} },
  } = {},
) {
  let last = fingerprint(cwd)
  for (;;) {
    await sleepFn(watchMs)
    if (!ownerAlive()) return false
    const now = fingerprint(cwd)
    if (now === last) continue
    last = now
    if (namesProject(cwd)) {
      log.write('folder changed and now names a project — connecting')
      return true
    }
    log.write('folder changed but still names no project — still waiting')
  }
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
  const handle = { connectionId, startedAt: Date.now(), result: null, child: null, done: null }
  handle.done = new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [WAIT_SCRIPT, '--connection-id', connectionId, '--owner-pid', String(ownerPid), '--stream', cursorFlag],
      { stdio: ['ignore', 'inherit', log.fd === 'ignore' ? 'ignore' : log.fd] },
    )
    handle.child = child
    currentChild = child
    const finish = (result) => {
      if (currentChild === child) currentChild = null
      if (!handle.result) handle.result = result
      resolve(handle.result)
    }
    child.on('exit', (code, signal) => finish({ code, signal }))
    child.on('error', (error) => finish({ code: null, signal: null, error }))
  })
  return handle
}

/**
 * Keep this process's connection alive and heard, for as long as Claude Code runs.
 * See the header. Never returns while the owner lives; exits when it goes.
 */
async function serve({ connectionId, ownerPid, cwd, localId, connectEnv, log, cursorFlag }) {
  let current = connectionId
  let nextFlag = cursorFlag || '--pending'
  let stream = null
  let misses = 0
  let repairs = 0
  let repairNotBefore = 0
  let pollerUpSince = null
  let streamFailures = 0
  let streamNotBefore = 0
  let lastStanding = null
  // Connections this process has served live, and those whose end it already acted on.
  // A person's End closes Claude Code only when this process watched it happen
  // (close-on-end.mjs, item 973124bd).
  const servedLive = new Set()
  const endHandled = new Set()

  const setStanding = (standing, state) => {
    if (`${standing}:${current}` === lastStanding) return
    lastStanding = `${standing}:${current}`
    log.write('standing', { standing, connection_id: current })
    // The per-connection marker says which listener serves this connection: what
    // SessionStart uses to rebond it after /clear, and what SessionEnd keeps it for.
    if (standing === 'mine') writeListenerMarker(current, { ownerPid, localId: state?.local_id || localId })
    const status = standing === 'mine' ? 'serving' : standing
    writeOwnerListenerStatus(ownerPid, status, { connectionId: current, localId })
  }

  for (;;) {
    if (stopping) return
    if (!pidAlive(ownerPid)) {
      log.write('owner gone — exiting', { owner_pid: ownerPid })
      removeOwnerListenerFiles(ownerPid)
      process.exit(0)
    }

    // Follow the connection this process most recently connected: a `/devspec.remote
    // --force-new` replaces it, and a repair can come back with a new id.
    const pointed = readOwnedConnectionPointer(ownerPid)
    if (pointed && pointed !== current) {
      const next = readConnectionState(pointed)
      if (next && classifyConnection(next, ownerPid) === 'mine') {
        log.write('following this session to a new connection', { from: current, to: pointed })
        if (stream) stream.child?.kill('SIGTERM')
        current = pointed
        nextFlag = '--pending'
        misses = 0
      }
    }

    const state = readConnectionState(current)
    const standing = classifyConnection(state, ownerPid)
    setStanding(standing, state)
    if (standing === 'mine') servedLive.add(current)
    if (standing === 'ended' && !endHandled.has(current)) {
      endHandled.add(current)
      const outcome = closeClaudeCodeOnEnd({ state, sawLive: servedLive.has(current) })
      log.write(outcome.closed ? 'ended from DevSpec — closing Claude Code' : 'ended — Claude Code stays open', {
        connection_id: current,
        reason: outcome.reason,
        claude_pid: outcome.pid,
      })
      if (outcome.closed) recordConnectionEvent(current, 'closed_claude_code_on_end', { claude_pid: outcome.pid })
    }
    const pollerUp = standing === 'mine' ? pollerRunning(current) : false
    if (pollerUp) {
      pollerUpSince ??= Date.now()
      if (Date.now() - pollerUpSince >= REPAIR_STABLE_MS) repairs = 0
    } else pollerUpSince = null

    const step = reconcileStep({
      standing,
      streaming: Boolean(stream),
      waitHeld: waitHolderPid(current) !== null,
      pollerUp,
      misses,
      repairNotBefore,
      streamNotBefore,
    })
    misses = step.misses

    if (step.arm) {
      stream = runStream({ connectionId: current, ownerPid, cursorFlag: nextFlag, log })
      nextFlag = '--pending'
      log.write('stream armed', { connection_id: current })
    }

    if (step.repair) {
      repairNotBefore = Date.now() + REPAIR_BACKOFF_MS[Math.min(repairs + 1, REPAIR_BACKOFF_MS.length - 1)]
      repairs += 1
      misses = 0
      log.write('poller is gone while this session lives — reconnecting', { connection_id: current, attempt: repairs })
      recordConnectionEvent(current, 'poller_repair_started', { owner_pid: ownerPid, attempt: repairs })
      try {
        const repaired = await connect(
          { startup: true, ownerPid, cwd: state?.cwd || cwd, localId: state?.local_id || localId, env: connectEnv },
          { onRetryMessage: (message) => log.write('retry', { detail: message.trim() }) },
        )
        recordConnectionEvent(repaired.connection_id, 'poller_repaired', {
          owner_pid: ownerPid,
          from_connection_id: current,
          bond_action: repaired.bond_action,
          poller: repaired.poller?.ok ? 'running' : repaired.warning_poller || 'not running',
        })
        log.write('repaired', { connection_id: repaired.connection_id, poller: repaired.poller?.ok ? 'running' : repaired.warning_poller })
        if (repaired.connection_id !== current) {
          if (stream) stream.child?.kill('SIGTERM')
          current = repaired.connection_id
          nextFlag = repaired.cursor_flag || '--pending'
        }
      } catch (e) {
        const reason = e instanceof ConnectError ? e.reason : 'unexpected'
        log.write('repair failed', { reason, error: e?.message })
        recordConnectionEvent(current, 'poller_repair_failed', { reason })
      }
    }

    // Sleep until the next tick, or until the stream ends — whichever comes first.
    const tick = sleep(SERVE_TICK_MS)
    const ended = stream ? await Promise.race([tick.then(() => null), stream.done]) : (await tick, null)
    if (ended && stream) {
      const { code, signal, error } = ended
      const lived = Date.now() - stream.startedAt
      stream = null
      log.write('stream ended', { code, signal, error: error?.message, lived_ms: lived })
      if (stopping || !pidAlive(ownerPid)) continue
      if (code === EXIT_REARM || code === EXIT_SUPERSEDED) {
        // A rollover re-arms on the next tick from the saved offset; a stand-down is
        // decided by ownership, not by this exit.
        streamFailures = 0
      } else if (lived < STREAM_FAST_FAIL_MS) {
        streamNotBefore = Date.now() + STREAM_RETRY_MS[Math.min(streamFailures, STREAM_RETRY_MS.length - 1)]
        streamFailures += 1
      } else streamFailures = 0
    }
  }
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
  writeOwnerListenerStatus(ownerPid, 'connecting', { localId })

  const config = await readStartupConfig(localId, { env })
  const connectEnv = envWithStartupConfig(env, config)
  const serveContext = { ownerPid, cwd, localId, connectEnv, log }
  if (!localId) return dormant(ownerPid, log, 'no_conversation_id', {}, { serveContext })
  if (!connectAtStartupEnabled(env, config?.connect_at_startup)) {
    return dormant(ownerPid, log, 'turned_off', {}, { serveContext })
  }

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
      if (WAIT_FOR_LINK_REASONS.has(reason)) {
        log.write('waiting for this folder to name a project', { reason })
        writeOwnerListenerStatus(ownerPid, 'waiting_for_link', { localId, reason })
        const linked = await waitForFolderLink(cwd, {
          ownerAlive: () => pidAlive(ownerPid), log,
          fingerprint: dir => `${folderLinkFingerprint(dir)}|${conversationProjectFingerprint(localId)}`,
          namesProject: dir => {
            try { return folderNamesProject(dir) || readConversationProject(localId)?.status === 'selected' }
            catch { return false }
          },
        })
        if (!linked) {
          log.write('owner gone — exiting', { owner_pid: ownerPid })
          process.exit(0)
        }
        attempt = -1
        continue
      }
      if (TERMINAL_REASONS.has(reason)) return dormant(ownerPid, log, reason, {}, { serveContext })
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
  if (!summary.poller?.ok) log.write('poller not running yet', { warning: summary.warning_poller })

  // From here the listener serves the connection: one reader, a running poller, and a
  // clean hand-over when the conversation is resumed in another window. A wake already
  // held by this process (a Monitor from `/devspec.remote`) is left alone; one held by a
  // window this conversation was resumed AWAY from stands itself down within seconds,
  // because connect has just made this process the owner.
  return serve({ ...serveContext, connectionId, cursorFlag: summary.cursor_flag })
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
