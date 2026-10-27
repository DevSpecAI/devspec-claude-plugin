/**
 * A room post that answers a DevSpec notice (item 8ad9f857; the server half is
 * item 8885423d).
 *
 * A notice about this agent's own work is not a command, so the post that tells
 * the person about it is no command's answer: post_session_message with
 * `system_notice_ids` stores it as a reply to those notices, bound to no turn.
 * Without them the server files the post under the agent's last command.
 *
 * Which notices a post answers only the model knows, so the plugin never adds one.
 * The wake hands it each notice's exact id in the call to make (`replyLine`), so
 * it copies them from the notice in front of it rather than from memory. What the
 * plugin does to the call is mechanical:
 *
 * - A conversation whose tool list was fixed before the server took this argument
 *   has no type for it, and Claude Code hands the ids over as one string, which
 *   the server refuses. They go out as the array the server takes, when every part
 *   is a notice id; anything else is left for the server to refuse with its reason.
 * - It names no request (`request_ref`): a notice reply is speech, never
 *   provenance, and is not the request the turn happens to serve.
 * - Its `complete_turn` ends nothing here either (mark-explicit-reply.mjs), as on
 *   the server: the command a turn carries still waits for its own answer.
 *
 * The rules are the served remote ingress contract's `semantics.notice_reply`.
 * Imports only Node built-ins (DEVELOPMENT.md).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const NOTICE_REPLY_RULES = 'devspec://product/remote-ingress-contract (semantics.notice_reply)'

/** Whether a post_session_message call is a reply to DevSpec notices. */
export function isNoticeReply(args) {
  return Boolean(args) && typeof args === 'object' && args.system_notice_ids !== undefined && args.system_notice_ids !== null
}

/**
 * The ids as the array the server takes: from an array, a JSON array written as
 * a string, or ids separated by commas or spaces. An exact repeat is sent once,
 * because the server refuses a repeated id. Anything that is not wholly notice ids
 * comes back unchanged.
 */
export function normalizeNoticeIds(value) {
  let parts = value
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.startsWith('[')) {
      try {
        parts = JSON.parse(text)
      } catch {
        return value
      }
    } else {
      parts = text.split(/[\s,]+/).filter(Boolean)
    }
  }
  if (!Array.isArray(parts) || parts.length === 0) return value
  const ids = parts.map((part) => (typeof part === 'string' ? part.trim() : part))
  if (!ids.every((id) => typeof id === 'string' && UUID.test(id))) return value
  return [...new Set(ids)]
}

/** A notice reply's arguments as they go to DevSpec. */
export function prepareNoticeReply(args) {
  const { request_ref: _request, ...rest } = args
  return { ...rest, system_notice_ids: normalizeNoticeIds(args.system_notice_ids) }
}

/**
 * The line every notice the model is handed carries: the exact call that tells the
 * person about it in the room, and what that post is and is not.
 */
export function replyLine(noticeIds) {
  return [
    `To tell the person in your room, reply to this notice: post_session_message with your message and "system_notice_ids": ${JSON.stringify(noticeIds)},`,
    'and no turn fields such as local_turn (one post may answer several notices: list every one it is about, and no other).',
    'It is your own message, labelled as a reply to the notice. It is no command\'s answer: it opens, answers and completes no turn, complete_turn has no effect on it, and a command you are working on still needs its own answer.',
    'If DevSpec refuses it, the result says why; not_attached means you are in no room, so tell the person at your terminal instead.',
    `Rules: ${NOTICE_REPLY_RULES}.`,
  ].join(' ')
}
