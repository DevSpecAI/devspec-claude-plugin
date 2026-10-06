#!/usr/bin/env node
/**
 * Tell DevSpec when this agent is waiting for its owner in its terminal, and when it
 * no longer is (item acde245e; the server side is item 4918712f).
 *
 * Claude Code stops on prompts only a person at its terminal can answer: a permission
 * prompt, or an MCP server asking for input. An owner away from the terminal used to
 * find out hours later. This reports the wait on the connection
 * (heartbeat_connection `terminal_wait`), and DevSpec shows the agent as needing
 * attention and notifies its owner.
 *
 * ## Which hooks, measured on Claude Code 2.1.291 (2026-10-06)
 *
 * - `PermissionRequest` fires the moment the permission dialog is about to show, with
 *   the tool's name. Mode `request` only remembers that tool: it returns no decision,
 *   so the dialog shows exactly as it would without the plugin, and it never reads or
 *   sends the tool's input.
 * - `Notification` with `permission_prompt` arrived about 6 s later, carrying only
 *   "Claude needs your permission". That delay is Claude Code's own judgement that
 *   nobody is answering, and it is the trigger here (mode `notify`): someone at the
 *   terminal who answers straight away never gets a notification on their phone.
 *   The tool name comes from the `request` record.
 * - There is no hook for "the prompt was answered". Approving runs the tool and fires
 *   `PostToolUse` when it finishes. Mode `clear` runs on `PostToolUse`, the next
 *   prompt, `Stop` and `SessionEnd`, and does nothing unless a wait was reported. So an
 *   approved command that runs for minutes shows as waiting until it finishes.
 * - A denial fires no command hook at all: no PostToolUse, PostToolUseFailure,
 *   PermissionDenied or Stop, and no idle Notification within 75 s (measured on
 *   2.1.291). The plugin's function-hooks module (hooks/terminal-wait.ts) sees the
 *   denied `tool.call` settle and runs mode `clear`. On a build without that API, a
 *   denial clears at the next prompt.
 *
 * Every mode exits 0 whatever happens: a hook must never block the agent, and a lost
 * report only means DevSpec misses one wait.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mcpToolsCall } from './mcp-call.mjs'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import { loadState, resolveHookConversationId } from './mirror-turn.mjs'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

/** Notification types that mean a person is needed at the terminal. idle_prompt is not one: it fires on every idle turn end. */
export const WAITING_NOTIFICATION_KINDS = {
  permission_prompt: 'permission',
  worker_permission_prompt: 'permission',
  elicitation_dialog: 'input',
  elicitation_url_dialog: 'input',
  agent_needs_input: 'input',
}

/** The server's bound on a label (TERMINAL_WAIT_LABEL_MAX): a name, never content. */
export const LABEL_MAX = 200

export function waitStatePath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.terminal-wait.json`)
}

/**
 * A tool as a person knows it: built-ins keep their name ("Bash"), an MCP tool reads as
 * its server and tool ("mcp__supabase__execute_sql" → "Supabase · execute_sql").
 */
export function toolLabel(toolName) {
  const name = typeof toolName === 'string' ? toolName.trim() : ''
  if (!name) return null
  const parts = name.split('__')
  if (parts[0] !== 'mcp' || parts.length < 3) return name.slice(0, LABEL_MAX)
  // A plugin's server is named mcp__plugin_<plugin>_<server>__<tool>: keep the server.
  let server = parts[1]
  if (server.startsWith('plugin_')) server = server.slice('plugin_'.length).split('_').pop() || server
  server = server.replace(/[_-]+/g, ' ').trim()
  const pretty = server ? server[0].toUpperCase() + server.slice(1) : 'Tool'
  return `${pretty} · ${parts.slice(2).join('__')}`.slice(0, LABEL_MAX)
}

/** "X needs your input" → X. Anything else names nothing. */
export function labelFromMessage(message) {
  const m = typeof message === 'string' ? /^(.+?) needs your (?:input|attention)/i.exec(message.trim()) : null
  return m ? m[1].trim().slice(0, LABEL_MAX) : null
}

/**
 * What to report for a Notification, or null for one that is not a wait. Pure.
 *
 * @returns {{ kind: 'permission' | 'input', label: string } | null}
 */
export function waitFromNotification(notification, pending) {
  const kind = WAITING_NOTIFICATION_KINDS[notification?.notification_type]
  if (!kind) return null
  if (kind === 'permission') return { kind, label: pending?.label || 'a tool' }
  return { kind, label: labelFromMessage(notification?.message) || 'a connected tool' }
}

function parse(raw) {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}

function readWait(connectionId) {
  try {
    return readPrivateJson(waitStatePath(connectionId)) || {}
  } catch {
    return {}
  }
}

function writeWait(connectionId, value) {
  try {
    if (!value.pending && !value.reported) fs.rmSync(waitStatePath(connectionId), { force: true })
    else writePrivateJson(waitStatePath(connectionId), value)
  } catch {
    /* a lost record only means one wait goes unreported */
  }
}

async function report(state, connectionId, terminalWait) {
  let token = state.token
  let mcpUrl = state.mcp_url
  if (!token) {
    const auth = resolveDevspecMcpAuth(state.cwd || process.cwd())
    token = auth.token
    mcpUrl = mcpUrl || auth.mcp_url
  }
  if (!token) return false
  await mcpToolsCall({
    mcpUrl: mcpUrl || 'https://api.devspec.ai/api/mcp',
    token,
    name: 'heartbeat_connection',
    arguments: { connection_id: connectionId, agent_name: AGENT_NAME, status: 'live', terminal_wait: terminalWait },
  })
  return true
}

/**
 * One hook event. Exported so the decision logic is tested without a network: `send`
 * stands in for the heartbeat call.
 */
export async function handle(mode, raw, { state, send }) {
  const connectionId = state?.connection_id
  if (!connectionId) return { action: 'unbound' }
  const input = parse(raw)
  const current = readWait(connectionId)

  if (mode === 'request') {
    const label = toolLabel(input.tool_name)
    if (!label) return { action: 'none' }
    writeWait(connectionId, { ...current, pending: { label, at: new Date().toISOString() } })
    return { action: 'remembered', label }
  }

  if (mode === 'notify') {
    const wait = waitFromNotification(input, current.pending)
    if (!wait) return { action: 'none' }
    await send(wait)
    writeWait(connectionId, { pending: null, reported: { ...wait, at: new Date().toISOString() } })
    return { action: 'reported', wait }
  }

  if (mode === 'clear') {
    if (!current.pending && !current.reported) return { action: 'none' }
    if (current.reported) await send(null)
    writeWait(connectionId, {})
    return { action: current.reported ? 'cleared' : 'forgotten' }
  }
  return { action: 'none' }
}

async function main() {
  const mode = process.argv[2]
  try {
    const raw = fs.readFileSync(0, 'utf8')
    const state = loadState(resolveHookConversationId(raw))
    if (!state) return
    await handle(mode, raw, {
      state,
      send: (terminalWait) => report(state, state.connection_id, terminalWait),
    })
  } catch {
    /* never block the agent */
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main().finally(() => process.exit(0))
