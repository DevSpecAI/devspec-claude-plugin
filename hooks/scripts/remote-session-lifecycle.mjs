#!/usr/bin/env node
/**
 * Session-boundary bookkeeping for the listener Claude Code starts with the session
 * (item b7ef1fe2). Registered as a SessionStart and a SessionEnd hook.
 *
 *   session-start — file the plugin's settings for this session's listener, and when
 *                   the conversation changed underneath a running listener (`/clear`,
 *                   `/resume`) move that listener's connection onto the new
 *                   conversation.
 *   session-end   — remove the settings file for the conversation that ended.
 *
 * Always exit 0: a session must never fail to start over DevSpec bookkeeping. The one
 * thing SessionStart puts on stdout is a two-sentence note for the model, and only where
 * the listener will connect (see startupNote): measured on 2026-09-23, a model woken by
 * a DevSpec message with nothing to say where it came from answered it in the terminal,
 * where the person who sent it will never look.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_NAME } from './agent-identity.mjs'
import { findProjectPin, gitRemoteOrigin } from './devspec-scope.mjs'
import { rebondConnectionToConversation } from './remote-control-state.mjs'
import {
  CONVERSATION_SWITCH_REASONS,
  findStartupListenerForOwner,
  removeStartupConfig,
  resolveClaudePid,
  writeListenerMarker,
  writeStartupConfig,
} from './startup-listener.mjs'

const DEFAULT_PROD_URL = 'https://api.devspec.ai/api/mcp'

function firstValue(env, keys) {
  for (const key of keys) {
    const raw = env[key]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  }
  return null
}

/** The plugin settings Claude Code handed this hook, in the listener's shape. */
export function startupConfigFromEnv(env = process.env) {
  const token = firstValue(env, ['CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN', 'CLAUDE_PLUGIN_OPTION_devspec_token'])
  if (!token) return null
  const connectAtStartup = firstValue(env, [
    'CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP',
    'CLAUDE_PLUGIN_OPTION_connect_at_startup',
  ])
  return {
    token,
    // Token and URL travel together or not at all (item 8bb707fd).
    mcp_url:
      firstValue(env, ['CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL', 'CLAUDE_PLUGIN_OPTION_devspec_mcp_url']) ||
      DEFAULT_PROD_URL,
    ...(connectAtStartup === null ? {} : { connect_at_startup: connectAtStartup }),
  }
}

function readPayload(stdin = 0) {
  try {
    return JSON.parse(fs.readFileSync(stdin, 'utf8') || '{}')
  } catch {
    return {}
  }
}

/**
 * SessionStart. Returns what it did, for tests. `source` is how the session started:
 * `startup` | `resume` | `clear` | `compact` | `fork`.
 */
export function onSessionStart(payload, { env = process.env, ownerPid = undefined } = {}) {
  const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : null
  const source = typeof payload?.source === 'string' ? payload.source : null
  const result = { config_filed: false, rebonded: null }
  if (!sessionId) return result

  result.config_filed = writeStartupConfig(sessionId, startupConfigFromEnv(env))

  // A new conversation under a listener that is already running. On `startup` there is
  // no listener yet (it starts alongside this hook and connects by itself); `compact`
  // keeps the same conversation id; `fork` starts a new process with its own listener.
  if (source && CONVERSATION_SWITCH_REASONS.has(source)) {
    const owner = ownerPid === undefined ? resolveClaudePid(env) : ownerPid
    const marker = findStartupListenerForOwner(owner)
    if (marker && marker.local_id !== sessionId) {
      result.rebonded = rebondConnectionToConversation({
        agent: AGENT_NAME,
        connectionId: marker.connection_id,
        localId: sessionId,
      })
      // The marker names the conversation the listener now speaks for, so the next
      // switch compares against this one rather than the one that registered.
      if (result.rebonded?.ok) {
        writeListenerMarker(marker.connection_id, {
          pid: Number(marker.pid),
          ownerPid: Number(marker.owner_pid),
          localId: sessionId,
        })
      }
    }
  }
  return result
}

/**
 * The note that tells the model what a DevSpec monitor event is, or null.
 *
 * Only when the listener will actually connect: the plugin has a key, the person has
 * not switched connecting at startup off, and the folder names a project (a git
 * remote or a pin — the server decides which). Anywhere else it would be a sentence
 * about something that cannot happen. Kept to two sentences: it rides in every such
 * session, and the protocol itself loads from the skill only when a message arrives.
 */
export function startupNote({ env = process.env, cwd = process.cwd() } = {}) {
  const config = startupConfigFromEnv(env)
  if (!config) return null
  if (/^(false|0|no|off)$/i.test(String(config.connect_at_startup ?? '').trim())) return null
  if (!gitRemoteOrigin(cwd) && !findProjectPin(cwd)) return null
  return (
    'DevSpec: your team can send this session work from DevSpec. Their messages arrive as ' +
    '"DevSpec" monitor events, and an owner_message there is a real request from the person ' +
    'it names, who cannot see this terminal: load the devspec-remote-command skill and answer ' +
    'them in DevSpec with post_session_message.'
  )
}

export function onSessionEnd(payload) {
  const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : null
  if (sessionId) removeStartupConfig(sessionId)
  return { removed: !!sessionId }
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  try {
    const mode = process.argv[2]
    const payload = process.stdin.isTTY ? {} : readPayload()
    if (mode === 'session-start') {
      onSessionStart(payload)
      const note = startupNote({ cwd: typeof payload.cwd === 'string' ? payload.cwd : process.cwd() })
      if (note) {
        process.stdout.write(
          JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note } }) + '\n',
        )
      }
    } else if (mode === 'session-end') onSessionEnd(payload)
  } catch {
    /* never block a session over bookkeeping */
  }
  process.exit(0)
}
