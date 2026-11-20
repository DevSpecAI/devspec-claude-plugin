/**
 * The room commands a turn has started, named to DevSpec at both ends of the turn.
 *
 * DevSpec starts a delivered room command only when the host says it has, with
 * `report_pickup` naming the command (`command_turn_id`, `command_message_id`): a
 * busy report keeps an activity alive but never starts one, and a bare pickup takes
 * whichever command happens to be newest (DevSpec item 6d767a58). So the plugin
 * names every command it hands to Claude: the one that starts a turn, and one
 * Claude Code hands over while a turn is already running (item 4cc685f1).
 *
 * A turn's end names what it finishes the same way (`report_complete` with the
 * command's turn and message), so a late completion never touches a command that
 * arrived after it (DevSpec item f908710b). A turn no command started (a prompt typed here, an automation
 * run, a background job's wake) names that instead: its local attempt, or
 * `command_turn_unbound`.
 *
 * The commands a turn has started are kept in one append-only file per connection,
 * `<connection>.turn-commands.jsonl`, written by whoever named the pickup (the
 * poller, the prompt hook) and read by whoever ends the turn (the Stop hook). It is
 * removed with the turn marker.
 *
 * Imports only Node built-ins.
 */

import fs from 'node:fs'
import path from 'node:path'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One command, as both reports name it. Null unless both ids are UUIDs. */
function commandIdentity(turnId, messageId) {
  return UUID.test(turnId ?? '') && UUID.test(messageId ?? '') ? { turnId, messageId } : null
}

export function turnCommandsPath(connectionId, dir) {
  return path.join(dir, `${connectionId}.turn-commands.jsonl`)
}

/**
 * The commands a canonical ingress hands over to run, oldest first: the ones in
 * `executeMessageIds` (a command already delivered is not handed over again).
 */
export function deliveredCommands(ingress, executeMessageIds) {
  const wanted = new Set(Array.isArray(executeMessageIds) ? executeMessageIds : [])
  const commands = Array.isArray(ingress?.commands) ? ingress.commands : []
  return commands
    .filter((command) => wanted.has(command?.message_id))
    .map((command) => commandIdentity(command?.delivery?.turn_id, command?.message_id))
    .filter(Boolean)
}

/**
 * The commands with these message ids, in the order given, from the inbox's
 * canonical command records (each holds the command's `delivery.turn_id`). A
 * message the inbox does not hold is left out.
 */
export function commandsInInbox(inboxText, messageIds) {
  const wanted = (Array.isArray(messageIds) ? messageIds : []).filter((id) => UUID.test(id ?? ''))
  if (wanted.length === 0) return []
  const turns = new Map()
  for (const line of String(inboxText || '').split('\n')) {
    if (!line.includes('canonical_commands')) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record?.type !== 'canonical_commands') continue
    for (const command of Array.isArray(record.ingress?.commands) ? record.ingress.commands : []) {
      if (wanted.includes(command?.message_id)) turns.set(command.message_id, command?.delivery?.turn_id)
    }
  }
  return wanted.map((messageId) => commandIdentity(turns.get(messageId), messageId)).filter(Boolean)
}

/** Add commands this turn has started. Returns false when they could not be written. */
export function recordTurnCommands(connectionId, commands, { dir }) {
  const lines = (Array.isArray(commands) ? commands : [])
    .map((command) => commandIdentity(command?.turnId, command?.messageId))
    .filter(Boolean)
    .map((command) => `${JSON.stringify({ turn_id: command.turnId, message_id: command.messageId })}\n`)
  if (!connectionId || lines.length === 0) return false
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(turnCommandsPath(connectionId, dir), lines.join(''), { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** The commands this turn has started, oldest first, each once. */
export function readTurnCommands(connectionId, { dir }) {
  let text = ''
  try {
    text = fs.readFileSync(turnCommandsPath(connectionId, dir), 'utf8')
  } catch {
    return []
  }
  const seen = new Set()
  const commands = []
  for (const line of text.split('\n')) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const command = commandIdentity(entry?.turn_id, entry?.message_id)
    if (!command || seen.has(command.messageId)) continue
    seen.add(command.messageId)
    commands.push(command)
  }
  return commands
}

export function clearTurnCommands(connectionId, { dir }) {
  if (!connectionId) return
  try {
    fs.rmSync(turnCommandsPath(connectionId, dir), { force: true })
  } catch {
    /* a stale file only names commands that are already closed */
  }
}

/** `report_pickup`'s arguments for starting exactly this command. */
export function pickupArguments(connectionId, command) {
  return { connection_id: connectionId, command_turn_id: command.turnId, command_message_id: command.messageId }
}

/**
 * `report_complete`'s arguments for each thing a turn finishes: every command it
 * started, by its turn and message, and the local attempt a prompt typed here
 * opened. A turn that started neither finishes an activity no command started.
 */
export function completionArguments({ connectionId, commands = [], localAttemptId = null, reason }) {
  const calls = commands.map((command) => ({
    connection_id: connectionId,
    command_turn_id: command.turnId,
    command_message_id: command.messageId,
    reason,
  }))
  if (localAttemptId) calls.push({ connection_id: connectionId, attempt_id: localAttemptId, reason })
  if (calls.length === 0) calls.push({ connection_id: connectionId, command_turn_unbound: true, reason })
  return calls
}
