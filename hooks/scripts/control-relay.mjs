/**
 * The owner's controls from DevSpec, carried out by Claude Code (item cbf3d758).
 *
 * The owner presses Stop, picks a thinking level, compacts or clears in DevSpec. The server
 * stamps a CONTROL verb on the connection, the poller receives it, and something has
 * to act on it inside Claude Code. A command hook cannot: hooks run only when Claude
 * Code calls them. The plugin's function-hooks module can (`$.turn.abort` cancels the
 * running turn; `$.command.run` runs `/effort`, `/compact` and `/clear` exactly as if
 * the owner had typed them in that terminal), so the poller hands the control to the module
 * through one small file and the module hands it back, carried out, through
 * heartbeat_connection `control_ack`.
 *
 * Switching model is not carried out. Claude Code asks for confirmation in its own
 * terminal before switching a conversation whose history is cached, and nobody is at
 * that terminal to answer when the owner is steering from DevSpec, so the plugin does
 * not report `set_model` and DevSpec does not offer it.
 *
 *   poller ── <cid>.control.json ──▶ module ── devspec-control.mjs ack ──▶ DevSpec
 *   module ── <cid>.controls.json (what it carries out, refreshed) ──▶ poller
 *                                         └─ poll_connection control_verbs ──▶ DevSpec
 *
 * DevSpec offers a control only to an agent that reported it, and the module writes
 * that report only while it is loaded and ticking. So an older Claude Code, an older
 * plugin or a `-p` run reports none and is offered none. A control that arrives
 * anyway (a page that had not refreshed yet) is acknowledged by the poller unacted
 * on, so the connection's one control slot is never held.
 *
 * Pure: no Node built-ins, because the module imports it too.
 */

const REMOTE_DIR = '.devspec/remote-control'

/** The verbs this plugin carries out. */
export const CARRIED_CONTROLS = Object.freeze(['abort', 'set_thinking', 'compact', 'clear'])

/** Claude Code's effort levels, which DevSpec calls thinking levels. */
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])

/**
 * How old the module's report may be before the poller treats the module as gone.
 * The module rewrites it every CONTROL_TICK_MS, so this is many missed ticks, not one.
 */
export const CARRIED_FRESH_MS = 30_000

/** How often the module looks for a control. */
export const CONTROL_TICK_MS = 1_000

/** How often the module rewrites its report: well inside CARRIED_FRESH_MS. */
export const CARRIED_REFRESH_MS = 10_000

/**
 * A control older than this is handed back, never carried out. Stop means "the turn
 * running now"; one left over from before a reload or a failed ack must not cut off
 * a turn the owner never meant, nor compact a conversation they have moved on from.
 */
export const CONTROL_STALE_MS = 60_000

/** The control waiting for the module, written by the poller. */
export function pendingControlPath(home, connectionId) {
  return `${home}/${REMOTE_DIR}/connections/${connectionId}.control.json`
}

/** What the module carries out, and when it last said so. */
export function carriedControlsPath(home, connectionId) {
  return `${home}/${REMOTE_DIR}/connections/${connectionId}.controls.json`
}

function parseJson(text) {
  if (typeof text !== 'string' || !text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * When the Stop hook last ran for this connection (mirror-turn.mjs stop records it).
 * Claude Code runs no Stop hook for a turn that is interrupted (Esc, Stop from
 * DevSpec) or ends on a denied permission prompt, and the Stop hook is what tells
 * DevSpec a turn ended; the module reads this to know when it has to (measured on
 * 2.1.291: the Stop hook of a normal turn runs a few milliseconds before turn.complete).
 */
export function stopHookPath(home, connectionId) {
  return `${home}/${REMOTE_DIR}/connections/${connectionId}.stop-hook.json`
}

/**
 * How long the module waits for the StopFailure hook's record after a turn that an
 * error from Anthropic's service ended (item b6a38d81). That hook tells the room and
 * ends the turn itself, writing the same record as Stop first thing, but it is a
 * separate process Claude Code starts as the turn ends without waiting on it, so its
 * record can land just after turn.complete. The wait covers a node process starting
 * on a busy machine; the module ends the turn only if the record never comes, which
 * is a configuration where command hooks do not run at all.
 */
export const STOP_FAILURE_GRACE_MS = 10_000

/** Whether the Stop hook ran at or after `sinceMs`, from its record. */
export function stopHookRanSince(text, sinceMs) {
  const at = Date.parse(parseJson(text)?.at ?? '')
  return Number.isFinite(at) && at >= sinceMs
}

/** The pending control file as the module reads it, or null. */
export function parsePendingControl(text) {
  const value = parseJson(text)
  if (!value || typeof value.id !== 'string' || !value.id || typeof value.verb !== 'string') return null
  const receivedAt = typeof value.received_at === 'string' ? Date.parse(value.received_at) : NaN
  const thinking = typeof value.args?.thinking === 'string' ? value.args.thinking : null
  return {
    id: value.id,
    verb: value.verb,
    thinking,
    receivedAtMs: Number.isFinite(receivedAt) ? receivedAt : null,
  }
}

/**
 * The Claude Code slash command that carries a control out, as `$.command.run` takes
 * it, or null for one that is not a command (Stop cancels the turn instead) or that
 * Claude Code cannot do (a thinking level it has no effort for, such as `off`).
 */
export function commandForControl(control) {
  if (control?.verb === 'compact') return { command: 'compact', args: '' }
  // A new conversation in the same process; the plugin carries this connection over
  // to it (startup-listener.mjs), so the agent stays in its room (item 6beb89c6).
  if (control?.verb === 'clear') return { command: 'clear', args: '' }
  if (control?.verb === 'set_thinking' && EFFORT_LEVELS.includes(control.thinking)) {
    return { command: 'effort', args: control.thinking }
  }
  return null
}

/** Whether the module should still carry a control out, rather than only hand it back. */
export function controlIsCurrent(control, nowMs) {
  return control?.receivedAtMs != null && nowMs - control.receivedAtMs <= CONTROL_STALE_MS
}

/** The module's report, written each tick. */
export function carriedControlsRecord(nowIso) {
  return JSON.stringify({ verbs: CARRIED_CONTROLS, at: nowIso })
}

/**
 * The verbs a loaded module carries out, from its report: [] when there is no fresh
 * report (no module, an older Claude Code, or one that has stopped ticking), and
 * null when the file is there but could not be read, which is a write in progress
 * rather than an answer, so the caller keeps what it knew.
 */
export function carriedControls(text, nowMs) {
  if (typeof text !== 'string' || !text) return []
  const value = parseJson(text)
  if (value === null) return null
  const at = typeof value?.at === 'string' ? Date.parse(value.at) : NaN
  if (!Number.isFinite(at) || nowMs - at > CARRIED_FRESH_MS || !Array.isArray(value.verbs)) return []
  return CARRIED_CONTROLS.filter((verb) => value.verbs.includes(verb))
}
