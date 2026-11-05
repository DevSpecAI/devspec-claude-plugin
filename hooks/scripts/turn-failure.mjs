/**
 * Tell the room when Claude Code could not answer a command at all (item b6a38d81).
 *
 * When an error from Anthropic's service ends a turn (signed out, a usage limit, an
 * outage, a billing problem…), Claude Code runs the documented `StopFailure` hook
 * INSTEAD of `Stop` (since 2.1.78; hooks reference). The model never ran, so it never
 * posts an answer, and every end-of-turn step this plugin takes hung off Stop: the
 * room showed nothing at all while the error sat in a terminal the person driving
 * from DevSpec cannot see. Observed 2026-10-30: "Login expired · Please run /login"
 * in the terminal, silence in the room.
 *
 * The hook input carries a fixed reason (`error`: authentication_failed, rate_limit,
 * billing_error, server_error, … unknown) and Claude Code's own rendered error text
 * (`last_assistant_message`, e.g. "Login expired · Please run /login"). The text is
 * passed through as Claude Code wrote it, never reworded per reason: those messages
 * already say what to do, and Anthropic adds and changes them (Ali, 2026-10-30). The
 * reason is shown only when there is no text, so no failure is ever silent.
 *
 * This is the one case a hook answers a room command (decision 89485860 keeps answers
 * agent-canonical): it fires only when the model produced no answer for the turn.
 *
 * Imports nothing, so the module and the tests can load it as they like.
 */

/**
 * The failure as Claude Code reported it, or null when the input is not a
 * StopFailure at all. Every field is untrusted text from the hook's stdin.
 */
export function parseTurnFailure(raw) {
  let data
  try {
    data = JSON.parse(raw || '{}')
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || data.hook_event_name !== 'StopFailure') return null
  const clean = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
  return {
    reason: clean(data.error) ?? 'unknown',
    text: clean(data.last_assistant_message),
    details: clean(data.error_details),
  }
}

/**
 * Quote text as a Markdown block, line by line, so the room shows Claude Code's own
 * words apart from ours whatever they contain.
 */
function quote(text) {
  return text.split(/\r?\n/).map((line) => `> ${line}`.trimEnd()).join('\n')
}

/**
 * What the room is told. Claude Code's text whole and as written; when it gave none,
 * the reason and any detail it did give.
 */
export function turnFailureMessage(failure, agentName) {
  const said = failure.text ?? failure.details
  const lead = said
    ? `${agentName} couldn't answer this. It said:\n\n${quote(said)}`
    : `${agentName} couldn't answer this (\`${failure.reason}\`).`
  return `${lead}\n\nAnything it asks you to do happens in ${agentName} on the computer it's running on. Once that's sorted, send your message again.`
}
