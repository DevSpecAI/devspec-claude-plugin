/**
 * The one size limit on text this plugin posts into a DevSpec room.
 *
 * DevSpec's post_session_message accepts a message of at most 100,000 characters and
 * refuses anything longer (`message` in the tool's input schema; ROOM_MESSAGE_MAX on
 * the server). That is the only ceiling: the plugin used to cut mirrored prompts at
 * 12,000 characters and directed-question replies at 12,000, silently, for no reason
 * the server shared (item 9a4c0d6a).
 *
 * Where an agent makes the post itself, it sends the text whole and the server's
 * refusal tells it the limit. Where a hook posts on a person's behalf and nobody
 * would see a refusal (the typed-prompt mirror), the text is fitted here instead,
 * and says so in the message: the room is never shown a cut message as if it were whole.
 *
 * Imports nothing.
 */

/** post_session_message's own limit, in JavaScript string length (UTF-16 code units). */
export const ROOM_MESSAGE_MAX_CHARS = 100_000

/**
 * The text whole when the room accepts it, otherwise as much as fits followed by a
 * visible note saying how much is missing and why.
 */
export function fitRoomMessage(text) {
  const value = String(text ?? '')
  if (value.length <= ROOM_MESSAGE_MAX_CHARS) return value
  // Sized for the worst case first, so the note's own length is known exactly.
  const noteFor = (omitted) =>
    `\n\n[${omitted.toLocaleString('en-US')} more characters are not shown: a room message holds at most ` +
    `${ROOM_MESSAGE_MAX_CHARS.toLocaleString('en-US')} characters.]`
  let keep = ROOM_MESSAGE_MAX_CHARS - noteFor(value.length).length
  // Never split a surrogate pair.
  const code = value.charCodeAt(keep - 1)
  if (code >= 0xd800 && code <= 0xdbff) keep -= 1
  return value.slice(0, keep) + noteFor(value.length - keep)
}
