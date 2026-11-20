/**
 * Tell DevSpec when Anthropic refuses this Claude Code for usage, so its check jobs
 * go to another agent (item 4cc685f1; the served contract's
 * `semantics.check_job.usage_refusal` in devspec://product/remote-ingress-contract).
 *
 * Claude Code runs the `StopFailure` hook instead of `Stop` when an error from
 * Anthropic's service ends a turn (turn-failure.mjs). Its `error` is a fixed reason,
 * and `rate_limit` is the one that means Anthropic refused the account for usage: a
 * plan's usage limit, or a usage 429. Nothing else counts, and a usage percentage on
 * its own never does: some accounts keep working past 100% of a reported window.
 *
 * The refusal says when it lifts only in Claude Code's rendered text ("resets 3pm"),
 * which is not a time anything can read reliably, so the report is a bounded
 * cool-off. While it is ahead DevSpec offers this agent no check job and hands back
 * any it holds; the agent still shows online. It is sent with every status update
 * while it stands (the turn's end heartbeat, every poll), and as null once a turn
 * succeeds. A refusal that outlasts the cool-off is reported again by the next turn
 * it refuses.
 *
 * Pure: no Node built-ins.
 */

/**
 * How long a refusal that gave no time is reported for. Long enough that a refused
 * agent is not offered check after check it cannot rule; short enough that an agent
 * whose limit lifted is not kept from checks for long when nothing else runs a turn
 * that would clear it.
 */
export const USAGE_REFUSAL_COOL_OFF_MS = 15 * 60 * 1000

/** Whether a turn failure (parseTurnFailure) is Anthropic refusing the account for usage. */
export function isUsageRefusal(failure) {
  return failure?.reason === 'rate_limit'
}

/** The time a refusal at `nowMs` is reported until. */
export function usageRefusedUntil(nowMs) {
  return new Date(nowMs + USAGE_REFUSAL_COOL_OFF_MS).toISOString()
}

/** The stored refusal, when it is a time still ahead of `nowMs`; otherwise null. */
export function standingRefusal(stored, nowMs) {
  const untilMs = typeof stored === 'string' ? Date.parse(stored) : Number.NaN
  return Number.isFinite(untilMs) && untilMs > nowMs ? new Date(untilMs).toISOString() : null
}

/**
 * The `usage_refused_until` argument a status update carries: the standing refusal
 * while it stands; null once, when one was sent before and it has since been
 * cleared or has passed; and nothing at all otherwise, which leaves DevSpec's record
 * as it is.
 */
export function usageRefusalArguments(stored, lastSent, nowMs) {
  const standing = standingRefusal(stored, nowMs)
  if (standing) return { usage_refused_until: standing }
  return lastSent ? { usage_refused_until: null } : {}
}
