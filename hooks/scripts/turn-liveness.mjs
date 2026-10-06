#!/usr/bin/env node
/**
 * Is this conversation's DevSpec turn still live? (item 9e8dda57)
 *
 * The turn marker (`<cid>.turn`, written at a command's pickup or a typed prompt,
 * cleared when the turn ends) is what the poller re-asserts Working from. It used to
 * expire one hour after the turn STARTED. Since the command stays open while its own
 * subagents and background jobs run (item beb0e005), long commands reached that hour
 * mid-work: DevSpec closed the open bubble empty ("No response") and the agent's real
 * answer arrived later as a separate message. Measured 2026-10-06 on three agents,
 * each closed at exactly 60 minutes (attempts e3263f60 and two others, reason
 * `turn_marker_cleared`).
 *
 * Liveness now comes from what Claude Code shows, not from a clock started at pickup:
 *
 * - **Held** (`held: true` on the marker, written by the Stop that kept the command
 *   open for this command's own background work): live. Claude Code wakes the agent
 *   when that work ends, and the next Stop rewrites or clears the marker. If Claude
 *   Code itself goes, the poller is anchored to it and takes the connection offline.
 * - **Running**: live while Claude Code keeps showing signs of life for this turn.
 *   Every tool call, the main agent's or a subagent's (whose hooks fire in the main
 *   session carrying `agent_id`), records one in `<cid>.turn-activity.json`.
 * - A running turn with no sign of life for `NO_SIGN_OF_LIFE_MS` is over: its end was
 *   never reported. That happens on Claude Code versions without the plugin API, where
 *   an interrupt runs no Stop hook.
 *
 * The activity record is a separate file, never a rewrite of the marker: a tool call
 * finishing beside the Stop that clears the marker must not bring it back. It names
 * the turn it belongs to (the marker's `startedAt`), so a previous turn's activity
 * never counts for the next one.
 *
 * Imports only Node built-ins and the plugin's own pure helpers (DEVELOPMENT.md).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { CONVERSATION_ID_ENV_VARS, LOCAL_ID_OVERRIDE_ENV_VAR } from './agent-identity.mjs'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'
import { bondPath } from './terminal-status.mjs'

/**
 * How long a running turn may go with no sign of life before its end is taken as
 * unreported. Not a bound on how long work may take: a tool call, a subagent's tool
 * call or a Stop that holds the command each resets it, and a held turn has none.
 * What it bounds is the longest stretch Claude Code spends inside one turn without
 * firing a single hook, which is one model response, well under an hour.
 */
export const NO_SIGN_OF_LIFE_MS = 60 * 60 * 1000

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function connectionsDir(home = os.homedir()) {
  return path.join(home, '.devspec', 'remote-control', 'connections')
}

export function turnMarkerFile(connectionId, dir) {
  return path.join(dir, `${connectionId}.turn`)
}

export function turnActivityPath(connectionId, dir) {
  return path.join(dir, `${connectionId}.turn-activity.json`)
}

/** The newest sign of life for `marker`'s turn: its start, or later activity of that same turn. */
export function lastSignOfLife(marker, activity) {
  const started = marker.startedAt
  const seen = activity?.turn === started && Number.isFinite(activity.at) ? activity.at : started
  return Math.max(started, seen)
}

/** Whether the turn `marker` describes is still live (see the file header). */
export function turnIsLive(marker, { activity = null, now = Date.now() } = {}) {
  if (!marker || typeof marker.startedAt !== 'number') return false
  if (marker.held === true) return true
  return now - lastSignOfLife(marker, activity) < NO_SIGN_OF_LIFE_MS
}

export function readTurnActivity(connectionId, dir) {
  try {
    const activity = readPrivateJson(turnActivityPath(connectionId, dir))
    return typeof activity?.turn === 'number' && typeof activity.at === 'number' ? activity : null
  } catch {
    return null
  }
}

/**
 * Record a sign of life for this connection's open turn. Reads the marker, never
 * writes it: with no turn open there is nothing to keep alive, and a turn that just
 * ended stays ended.
 */
export function recordTurnActivity(connectionId, { dir, now = Date.now() }) {
  if (!SAFE_ID.test(connectionId ?? '')) return false
  let marker = null
  try {
    marker = readPrivateJson(turnMarkerFile(connectionId, dir))
  } catch {
    return false
  }
  if (typeof marker?.startedAt !== 'number') return false
  try {
    writePrivateJson(turnActivityPath(connectionId, dir), { turn: marker.startedAt, at: now })
    return true
  } catch {
    return false
  }
}

/** The connection bonded to the conversation a hook fired in, or null. */
export function hookConnectionId(input, { env = process.env, home = os.homedir() } = {}) {
  let conversationId = null
  for (const name of [LOCAL_ID_OVERRIDE_ENV_VAR, ...CONVERSATION_ID_ENV_VARS]) {
    const value = typeof env?.[name] === 'string' ? env[name].trim() : ''
    if (SAFE_ID.test(value)) {
      conversationId = value
      break
    }
  }
  if (!conversationId) {
    const fromInput = typeof input?.session_id === 'string' ? input.session_id.trim() : ''
    conversationId = SAFE_ID.test(fromInput) ? fromInput : null
  }
  if (!conversationId) return null
  try {
    const connectionId = readPrivateJson(bondPath(home, conversationId))?.connection_id
    return SAFE_ID.test(connectionId ?? '') ? connectionId : null
  } catch {
    return null
  }
}

/** PostToolUse: a tool call finished, so this conversation's turn is alive. Silent always. */
export function touch(raw, { env = process.env, home = os.homedir(), now = Date.now() } = {}) {
  let input = null
  try {
    input = JSON.parse(raw || '{}')
  } catch {
    return false
  }
  const connectionId = hookConnectionId(input, { env, home })
  if (!connectionId) return false
  return recordTurnActivity(connectionId, { dir: connectionsDir(home), now })
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv[2] === 'touch') {
    let raw = ''
    try {
      raw = fs.readFileSync(0, 'utf8')
    } catch {
      /* no stdin: nothing to resolve */
    }
    try {
      touch(raw)
    } catch {
      /* a hook never blocks the agent */
    }
  }
  process.exit(0)
}
