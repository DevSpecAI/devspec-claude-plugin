#!/usr/bin/env node
/**
 * PostToolUse hook (matcher: mcp__devspec__post_session_message) — records that
 * the agent already posted an explicit reply into the session THIS turn, so the
 * Stop hook (mirror-turn.mjs) knows to skip mirroring the turn's own end-of-turn
 * narration as a second, redundant session message (item b9fb49a9).
 *
 * Purely mechanical, no LLM tokens. Never blocks or reports failure back to the
 * tool call — a missing/unreadable state file just means no marker is written,
 * and Stop falls back to its normal mirror behavior.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveHookConversationId, loadState, explicitReplyMarkerPath } from './mirror-turn.mjs'

const TARGET_TOOL = 'mcp__devspec__post_session_message'

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

async function main() {
  const raw = readStdin()
  if (toolNameFrom(raw) !== TARGET_TOOL) process.exit(0)

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
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
