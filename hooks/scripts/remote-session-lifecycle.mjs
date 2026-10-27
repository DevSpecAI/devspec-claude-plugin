#!/usr/bin/env node
/**
 * Session-boundary bookkeeping for the listener Claude Code starts with the session
 * (item b7ef1fe2). Registered as a SessionStart hook.
 *
 *   session-start — when the conversation changed underneath a running listener
 *                   (`/clear`, `/resume`), move that listener's connection onto the
 *                   new conversation.
 *
 * The plugin settings the listener connects with are filed, and removed at
 * SessionEnd, by `session-env-credentials.mjs` (item 4d40407b).
 *
 * Always exit 0: a session must never fail to start over DevSpec bookkeeping. The one
 * thing SessionStart puts on stdout is a two-sentence note for the model, and only where
 * the listener will connect (see startupNote): measured on 2026-09-23, a model woken by
 * a DevSpec message with nothing to say where it came from answered it in the terminal,
 * where the person who sent it will never look.
 */

import fs from 'node:fs'
import { AGENT_NAME } from './agent-identity.mjs'
import { pluginSettingsFromHookEnv } from './plugin-settings.mjs'
import { findProjectPin, gitRemoteOrigin } from './devspec-scope.mjs'
import { readConversationProject } from './conversation-project.mjs'
import { rebondConnectionToConversation, reportConnectionEnded } from './remote-control-state.mjs'
import {
  CONVERSATION_SWITCH_REASONS,
  findStartupListenerForOwner,
  resolveClaudePid,
  writeListenerMarker,
} from './startup-listener.mjs'
import { isEntryPoint } from './entry-point.mjs'

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
  const result = { rebonded: null }
  if (!sessionId) return result

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
export function startupNote({ env = process.env, cwd = process.cwd(), localId = null } = {}) {
  const config = pluginSettingsFromHookEnv(env)
  if (!config) return null
  if (/^(false|0|no|off)$/i.test(String(config.connect_at_startup ?? '').trim())) return null
  let selected = false
  try { selected = readConversationProject(localId, { endpoint: config.mcp_url })?.status === 'selected' } catch {}
  if (!gitRemoteOrigin(cwd) && !findProjectPin(cwd) && !selected) return null
  return (
    'DevSpec: your team can send this session work from DevSpec. Their messages arrive as ' +
    '"DevSpec" monitor events, and an owner_message there is a real request from the person ' +
    'it names, who cannot see this terminal: load the devspec-remote-command skill once per ' +
    'conversation and answer them in DevSpec with post_session_message.'
  )
}

const isMain = isEntryPoint(import.meta.url)

if (isMain) {
  try {
    const mode = process.argv[2]
    const payload = process.stdin.isTTY ? {} : readPayload()
    if (mode === 'session-start') {
      const started = onSessionStart(payload)
      const scopeChanged = started.rebonded?.reason === 'project_scope_mismatch'
      if (scopeChanged) await reportConnectionEnded(started.rebonded.connection_id, { timeoutMs: 3000 })
      const note = scopeChanged
        ? 'DevSpec did not reuse the previous remote connection because this conversation has another project. Reconnect with /devspec:devspec.remote; do not answer through the previous connection.'
        : startupNote({ cwd: typeof payload.cwd === 'string' ? payload.cwd : process.cwd(), localId: payload.session_id })
      if (note) {
        process.stdout.write(
          JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note } }) + '\n',
        )
      }
    }
  } catch {
    /* never block a session over bookkeeping */
  }
  process.exit(0)
}
