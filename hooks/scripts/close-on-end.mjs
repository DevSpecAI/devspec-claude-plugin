/**
 * Ending an agent from DevSpec closes its Claude Code (item 973124bd).
 *
 * The owner ends an agent on the Agents page or in a session. Until now that ended the
 * connection and left Claude Code running in its terminal, so someone with many
 * terminals open had to hunt for the right tab and close it by hand. The owner's
 * decision (room 358f2225, 2026-10-06): End closes the program, straight away and even
 * mid-task.
 *
 * ## Why a terminate signal and not `/exit`
 *
 * Measured on Claude Code 2.1.291 with a probe plugin: a `/exit` run through the plugin
 * API (`$.command.run({ command: 'exit' })`) stops at Claude Code's own "Background work
 * is running — Exit and stop tasks / Stay" dialog whenever any background work runs, and
 * this plugin's listener is a monitor, so that is always. The process then waits for a
 * person at the terminal, which is the opposite of what End is for. SIGTERM is Claude
 * Code's ordinary graceful shutdown: SessionEnd hooks run, its background tasks are
 * stopped, the conversation stays resumable (measured 2026-10-04 and again here).
 *
 * ## Exactly when, and never otherwise
 *
 * - Only a person's End: the server's `end_reason` `ui`, which only the connection's
 *   owner can cause (DevSpecV2 `endConnection`). Not `/devspec.remote-stop` typed in
 *   this terminal (`local_stop`: the person is right here), not a detach, not a
 *   recoverable server end (a redeploy blip, an idle sweep).
 * - Only an end this process watched happen: the caller must have served the connection
 *   live first. A conversation resumed after its connection was ended must not close
 *   the moment it starts.
 * - Only the Claude Code that owns the connection, proved by ancestry: the pid this
 *   process descends from, matched to the connection's recorded owner. A conversation
 *   resumed in another window moved ownership there, and the old window stays open.
 * - Not on Windows. There `process.kill` is TerminateProcess: no SessionEnd, no
 *   graceful stop. Unverified, so not shipped; the terminal line still says
 *   "ended from DevSpec" there, as before.
 */

import { ownedByProcess, resolveClaudePid } from './startup-listener.mjs'

/** The server's word for an End a person made from DevSpec. */
export const PERSON_END_REASON = 'ui'

/**
 * Should this process close its Claude Code now? Pure: every input is passed in.
 *
 * @returns {{ close: boolean, reason: string }}
 */
export function closeOnEndDecision({ state, sawLive, claudePid, platform = process.platform, owns = ownedByProcess }) {
  if (!state || state.end_reason !== PERSON_END_REASON) return { close: false, reason: 'not_a_person_end' }
  if (!sawLive) return { close: false, reason: 'ended_before_this_process_served_it' }
  if (platform === 'win32') return { close: false, reason: 'unsupported_platform' }
  if (!Number.isInteger(claudePid) || claudePid <= 1) return { close: false, reason: 'no_claude_process' }
  if (!owns(state, claudePid)) return { close: false, reason: 'not_the_owner' }
  return { close: true, reason: 'person_ended_it' }
}

/**
 * Close this process's Claude Code if the decision says so. The pid is resolved by
 * ancestry at the moment of closing, never trusted from a file, so a recycled pid can
 * never be signalled.
 *
 * @returns {{ closed: boolean, reason: string, pid: number | null }}
 */
export function closeClaudeCodeOnEnd({
  state,
  sawLive,
  env = process.env,
  platform = process.platform,
  resolvePid = resolveClaudePid,
  owns = ownedByProcess,
  kill = (pid, signal) => process.kill(pid, signal),
}) {
  const claudePid = platform === 'win32' ? null : resolvePid(env)
  const decision = closeOnEndDecision({ state, sawLive, claudePid, platform, owns })
  if (!decision.close) return { closed: false, reason: decision.reason, pid: claudePid }
  try {
    kill(claudePid, 'SIGTERM')
    return { closed: true, reason: decision.reason, pid: claudePid }
  } catch (e) {
    return { closed: false, reason: `signal_failed: ${e?.code || e?.message || e}`, pid: claudePid }
  }
}
