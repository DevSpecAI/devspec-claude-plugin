#!/usr/bin/env node
/**
 * PostToolUse hook (matcher: post_session_message, under either DevSpec server name) — records that
 * the agent already posted an explicit reply into the session THIS turn, so the
 * Stop hook (mirror-turn.mjs) knows to skip mirroring the turn's own end-of-turn
 * narration as a second, redundant session message (item b9fb49a9).
 *
 * ALSO clears the `<connection_id>.turn` marker when the post declared
 * `complete_turn: true` (item 55d1bac8). The marker is host-observed liveness and
 * the poller re-asserts busy from it every tick, so without this an agent that
 * declares completion leaves two writers disagreeing: the completed attempt reads
 * Idle, the next keepalive reads Working, and the indicator oscillates at the poll
 * cadence until the marker ages out up to an hour later. Cursor fixed the same
 * thing in 265d2c45; this is the Claude Code half.
 *
 * Purely mechanical, no LLM tokens. Never blocks or reports failure back to the
 * tool call — a missing/unreadable state file just means no marker is written,
 * and Stop falls back to its normal mirror behavior.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { devspecToolVerb } from './devspec-tool-name.mjs'
import { appendRequestEvent, commandsAnsweredNow, readRequestState } from './requests.mjs'
import {
  resolveHookConversationId,
  loadState,
  explicitReplyMarkerPath,
  clearTurnMarker,
} from './mirror-turn.mjs'

// A verb, not a tool name: this plugin's own server delivers the tool as
// mcp__plugin_devspec_devspec__post_session_message, and matching only
// mcp__devspec__… meant this never ran on a plugin install (ddc40cc8).
const TARGET_VERB = 'post_session_message'

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function toolNameFrom(raw) {
  try {
    const data = JSON.parse(raw || '{}')
    return data.tool_name || data.toolName || null
  } catch {
    return null
  }
}

/**
 * Did this post declare the turn finished? Only an explicit boolean true counts —
 * a missing or malformed field must never be read as completion, because clearing
 * the marker wrongly would show Idle while the agent is still working. Exported
 * for tests.
 */
export function declaresCompleteTurn(raw) {
  try {
    const data = JSON.parse(raw || '{}')
    const input = data.tool_input || data.toolInput || {}
    return input.complete_turn === true
  } catch {
    return false
  }
}

/**
 * Record that the turn's room commands were answered. Exported for tests;
 * `dir` defaults to where the request log lives.
 */
export function markCommandsAnswered(connectionId, { dir = path.join(os.homedir(), '.devspec', 'remote-control', 'connections') } = {}) {
  try {
    const ids = commandsAnsweredNow(readRequestState(connectionId, { dir }))
    for (const id of ids) appendRequestEvent(connectionId, { op: 'answered', id }, { dir })
    return ids
  } catch {
    return [] // never fails the post: an unmarked command only stays open longer
  }
}

async function main() {
  const raw = readStdin()
  if (devspecToolVerb(toolNameFrom(raw)) !== TARGET_VERB) process.exit(0)

  const conversationId = resolveHookConversationId(raw)
  const state = loadState(conversationId)
  const connectionId = state?.connection_id
  if (!connectionId) process.exit(0)

  try {
    fs.mkdirSync(path.dirname(explicitReplyMarkerPath(connectionId)), { recursive: true })
    fs.writeFileSync(explicitReplyMarkerPath(connectionId), `${Date.now()}\n`, { mode: 0o600 })
  } catch {
    /* non-fatal — worst case Stop also mirrors the turn's narration */
  }

  // The agent said this turn is over, so stop the poller re-asserting that it is
  // not. Deliberately AFTER the explicit-reply marker: that one must be written
  // even if this throws, since Stop depends on it.
  if (declaresCompleteTurn(raw)) {
    clearTurnMarker(connectionId)
    // ...and the room commands this turn carries have their final answer, so the
    // next Stop may finish them once their work is done (item 984ca8b4). Until
    // then a command stays open: work it still owes is still that person's.
    markCommandsAnswered(connectionId)
  }

  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
