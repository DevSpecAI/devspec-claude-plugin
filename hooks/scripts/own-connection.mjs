/**
 * The connection this Claude Code conversation is, stamped on Claude's own DevSpec
 * calls (item 718825fc).
 *
 * DevSpec decides who asked for a write from the connection that made it: the
 * command live on it, or the turn the owner typed at its terminal. Claude Code's
 * MCP client sends no connection identity of its own, so a write said nothing
 * about where it came from unless the model remembered to pass connection_id —
 * and in a turn typed at the terminal no skill tells it to. Pi stamps its
 * connection on every call; this does the same for Claude Code, from the bond the
 * plugin already holds for this conversation.
 *
 * connection_id is attribution, never authority: the server accepts only a
 * connection the token owner owns in this project, and judges what it may do.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENT_NAME } from './agent-identity.mjs'
import { readPrivateJson } from './private-state.mjs'
import { ownedByAnotherProcess, resolveClaudePid } from './startup-listener.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Calls whose SUBJECT is a connection (attach this one, end that one, report on
// this attempt): the model names it on purpose, and a default would aim them.
const CONNECTION_SUBJECT = /(?:^|_)connection(?:_|$)|^report_(?:pickup|keepalive|complete)$/

/**
 * The live connection bound to exactly this conversation, or null. Never another
 * conversation's, never one a resumed window now owns, and never a guess between
 * two: ambiguity stamps nothing, which leaves the call as the model wrote it.
 */
export function ownConnectionId(conversationId, { home = os.homedir(), env = process.env, myPid = undefined, ownedElsewhere = ownedByAnotherProcess } = {}) {
  if (typeof conversationId !== 'string' || !conversationId) return null
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  let files
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith('.json'))
  } catch {
    return null
  }
  const claudePid = myPid === undefined ? resolveClaudePid(env) : myPid
  const ids = new Set()
  for (const file of files) {
    let state
    try {
      state = readPrivateJson(path.join(dir, file))
    } catch {
      continue
    }
    if (!state || state.enabled !== true || state.local_id !== conversationId) continue
    if (String(state.agent_name || '').toLowerCase() !== AGENT_NAME.toLowerCase()) continue
    if (typeof state.connection_id !== 'string' || !UUID.test(state.connection_id)) continue
    if (claudePid && ownedElsewhere(state, claudePid)) continue
    ids.add(state.connection_id)
  }
  return ids.size === 1 ? [...ids][0] : null
}

/**
 * The call with this conversation's connection added, or the call unchanged. A
 * call that already names a connection or a room is left as written: on some tools
 * a connection outranks a named room, and that choice is the model's to make.
 */
export function withOwnConnection(toolName, args, connectionId) {
  if (!connectionId || !args || typeof args !== 'object' || CONNECTION_SUBJECT.test(toolName)) return args
  if (args.connection_id !== undefined || args.session_id !== undefined) return args
  return { ...args, connection_id: connectionId }
}
