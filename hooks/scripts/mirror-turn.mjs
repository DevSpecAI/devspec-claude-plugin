#!/usr/bin/env node
/**
 * DevSpec remote-control mirror hook (Stop / a prompt) — CONNECTION-NATIVE.
 * Resolves ONLY the connection bound to THIS local conversation — never a
 * machine-global "latest" pointer. Posts mechanically — no LLM tokens.
 *
 * user_prompt → busy/heartbeat + turn marker; and, for a prompt a person submitted,
 *               the owner's own turn plus a local_prompt bubble when attached
 *               (literal owner text). Run by the hooks module (hooks/local-prompt.ts)
 *               with Claude Code's origin for the prompt.
 * stop        → busy/heartbeat + turn marker only (NO assistant text)
 *
 * Answers are agent-canonical: skills call post_session_message({ connection_id }).
 * ADR b98a39a9 — no dual writers.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mcpToolsCall } from './mcp-call.mjs'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import { detectLocalId } from './remote-control-state.mjs'
import {
  STATE_OK,
  STATE_UNREADABLE,
  patchPrivateJson,
  readPrivateJson,
  readPrivateJsonResult,
  writePrivateJson,
} from './private-state.mjs'
import {
  activeContinuation,
  continuationIdentity,
  DELIVERED,
  stopInteractionDecision,
} from './interaction-events.mjs'
// The bridge owns clearing a resolved continuation; Stop is its other resolver.
import { clearStoredContinuation } from './devspec-question.mjs'
import { ownedByAnotherProcess, resolveClaudePid } from './startup-listener.mjs'
import {
  launchedBackgroundWork,
  outstandingBackgroundWorkFromFile,
  ownedOutstandingWork,
  parseBackgroundTasks,
} from './background-work.mjs'
import {
  DELEGATED_KINDS,
  delegatedChildren,
  delegationEvent,
  delegationText,
  deliveredPicture,
  ensureTrailState,
  latestDeliveredCommand,
  pictureKey,
  postLatest,
  recordDeliveredPicture,
  turnIdentity,
} from './delegation-trail.mjs'
import { localTurnScope, localTurnToComplete, startLocalTurn } from './local-turn.mjs'

// `background_launch` is the PostToolUse hook that records a background job a turn
// started (item beb0e005); everything else is a turn boundary.
const MODES = new Set(['user_prompt', 'stop', 'background_launch', 'subagent_stop'])
const mode = MODES.has(process.argv[2]) ? process.argv[2] : 'stop'
const LEGACY_STATE_PATH = path.join(os.homedir(), '.devspec', 'remote-control.json')
const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

// The poller stops treating a turn as live once its marker is this old
// (devspec-remote-poll.mjs MAX_TURN_MS); a background hold never outlives it.
const MAX_TURN_MS = 60 * 60 * 1000

// Turn marker — the connected agent is the SOLE authority for the "working" state.
// UserPromptSubmit (turn start) writes it; Stop (turn end) clears it. The long-lived
// poller reads it (by connection_id) to re-assert busy on heartbeats while a turn
// runs, so long turns stay "working" and the server's busy freshness doesn't decay.
/**
 * Merge a patch into this connection's own state file. Only an existing file: a
 * conversation bound through the legacy singleton has no per-connection file to
 * extend, and a file holding nothing but the patch would be a bond with no identity.
 * Losing a patch to a concurrent poller write is harmless here — Stop falls back to
 * the connection-scoped completion and the next start relearns its predecessor.
 */
function patchOwnState(connectionId, patch) {
  const file = path.join(CONNECTIONS_DIR, `${connectionId}.json`)
  if (!connectionId || !fs.existsSync(file)) return false
  return patchPrivateJson(file, { ...patch, updated_at: new Date().toISOString() })
}

export function turnMarkerPath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.turn`)
}
function readTurnMarker(connectionId, dir = CONNECTIONS_DIR) {
  if (!connectionId) return null
  try {
    const marker = readPrivateJson(turnMarkerPath(connectionId, dir))
    return typeof marker?.startedAt === 'number' ? marker : null
  } catch {
    return null
  }
}
function writeTurnMarker(connectionId) {
  if (!connectionId) return
  // A turn that is already live keeps its start. A held turn's start bounds which
  // background jobs belong to it (backgroundHoldDecision), so a wake-up prompt must
  // not move it past jobs that are still running.
  const existing = readTurnMarker(connectionId)
  const startedAt =
    existing && Date.now() - existing.startedAt < MAX_TURN_MS ? existing.startedAt : Date.now()
  try {
    fs.mkdirSync(CONNECTIONS_DIR, { recursive: true })
    fs.writeFileSync(turnMarkerPath(connectionId), JSON.stringify({ startedAt }), {
      mode: 0o600,
    })
  } catch {
    /* non-fatal — the immediate busy heartbeat below still fires */
  }
}

/**
 * The background jobs each turn launched (item beb0e005): one JSON line per launch,
 * `{ id, kind, turn, at }`, where `turn` is the marker's `startedAt` at the time.
 *
 * Appended, never rewritten: parallel tool calls finish together, and a
 * read-modify-write of one file would drop one of their ids. A line belongs to the
 * turn its `turn` names. When the poller picks up a new command it writes a new
 * `startedAt`, so an earlier command's jobs stop counting without anyone having to
 * clean them up. clearTurnMarker removes the file with the marker.
 */
export function ownedWorkPath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.turn-owned.jsonl`)
}

/**
 * Record that the open turn launched `launch` ({ id, kind }). Only an open, fresh
 * turn owns work: with no marker there is no command for the job to belong to.
 */
export function recordOwnedLaunch(connectionId, launch, { dir = CONNECTIONS_DIR, now = Date.now() } = {}) {
  if (!connectionId || !launch?.id) return false
  const marker = readTurnMarker(connectionId, dir)
  if (!marker || now - marker.startedAt >= MAX_TURN_MS) return false
  try {
    fs.mkdirSync(dir, { recursive: true })
    const line = { id: launch.id, kind: launch.kind, turn: marker.startedAt, at: new Date(now).toISOString() }
    if (launch.label) line.label = launch.label
    if (launch.model) line.model = launch.model
    if (launch.parent) line.parent = launch.parent
    fs.appendFileSync(ownedWorkPath(connectionId, dir), `${JSON.stringify(line)}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * Record that owned work ended, on the same append-only file (item d2cbd4c6).
 * Only work the open turn launched can end in it; anything else is ignored.
 */
export function recordOwnedEnd(connectionId, id, { status = 'completed', dir = CONNECTIONS_DIR, now = Date.now() } = {}) {
  const marker = readTurnMarker(connectionId, dir)
  if (!marker || now - marker.startedAt >= MAX_TURN_MS || typeof id !== 'string') return false
  const lines = readOwnedLines(connectionId, marker, dir)
  if (!lines.some((entry) => entry.id === id && typeof entry.ended !== 'string')) return false
  if (lines.some((entry) => entry.id === id && typeof entry.ended === 'string')) return false
  try {
    fs.appendFileSync(
      ownedWorkPath(connectionId, dir),
      `${JSON.stringify({ id, turn: marker.startedAt, ended: new Date(now).toISOString(), status })}\n`,
      { mode: 0o600 },
    )
    return true
  } catch {
    return false
  }
}

/** Every owned-work line the turn `marker` names, launches and ends alike. */
export function readOwnedLines(connectionId, marker, dir = CONNECTIONS_DIR) {
  if (!connectionId || typeof marker?.startedAt !== 'number') return []
  let text = ''
  try {
    text = fs.readFileSync(ownedWorkPath(connectionId, dir), 'utf8')
  } catch {
    return []
  }
  const lines = []
  for (const line of text.split('\n')) {
    try {
      const entry = JSON.parse(line)
      if (entry?.turn === marker.startedAt && typeof entry.id === 'string') lines.push(entry)
    } catch {
      /* a torn or foreign line is not a record */
    }
  }
  return lines
}

/** The ids the turn `marker` names launched, oldest first. */
export function readOwnedIds(connectionId, marker, dir = CONNECTIONS_DIR) {
  if (!connectionId || typeof marker?.startedAt !== 'number') return []
  let text = ''
  try {
    text = fs.readFileSync(ownedWorkPath(connectionId, dir), 'utf8')
  } catch {
    return []
  }
  const ids = []
  for (const line of text.split('\n')) {
    try {
      const entry = JSON.parse(line)
      if (entry?.turn === marker.startedAt && typeof entry.id === 'string' && typeof entry.ended !== 'string' && !ids.includes(entry.id)) ids.push(entry.id)
    } catch {
      /* a torn or foreign line is not a launch */
    }
  }
  return ids
}

/**
 * Does this Stop end the DevSpec command, or only pause it (item f4a79327)?
 *
 * Claude ends its turn to wait for work it started in the background (a subagent, a
 * background command, a workflow), and is woken again when that work finishes. The
 * command is not over: what Claude does after the wake is still the requester's work.
 * Reporting the turn complete here closed the command server-side, so every later
 * write lost its requester and was judged by the agent owner's role. While such work
 * is still running, keep the turn open; it ends when the agent posts its answer with
 * complete_turn (which clears the marker) or at a later Stop with nothing left running.
 *
 * What is still running comes from the host itself when it says (item beb0e005):
 * `backgroundTasks` is the Stop input's in-flight list, and `ownedIds` the jobs this
 * turn's own tool calls launched. A host that sends no list falls back to reading the
 * transcript, which sees only `run_in_background` launches since the turn began.
 *
 * Only while the marker is fresh: an absent marker means the agent already closed the
 * turn itself, and a stale one is a turn the poller has already let go.
 *
 * @returns {Array<object>|null} the outstanding jobs when the turn should stay open
 */
export function backgroundHoldDecision({
  marker,
  transcriptPath,
  backgroundTasks = null,
  ownedIds = [],
  now = Date.now(),
  readOutstanding = outstandingBackgroundWorkFromFile,
}) {
  if (!marker || typeof marker.startedAt !== 'number') return null
  if (now - marker.startedAt >= MAX_TURN_MS) return null
  const outstanding = Array.isArray(backgroundTasks)
    ? ownedOutstandingWork(backgroundTasks, ownedIds)
    : readOutstanding(transcriptPath, marker.startedAt)
  return outstanding.length > 0 ? outstanding : null
}

/**
 * PostToolUse for Bash / Agent / Workflow: if the call left work running in the
 * background, record it against this conversation's open turn. Silent either way;
 * the hook never blocks or changes a tool call.
 */
export function recordBackgroundLaunch(raw, { load = loadState, record = recordOwnedLaunch } = {}) {
  let input
  try {
    input = JSON.parse(raw || '{}')
  } catch {
    return false
  }
  const found = launchedBackgroundWork(input?.tool_name, input?.tool_response)
  if (!found) return false
  // Work a subagent started belongs to that subagent too: it is what the subagent is
  // still waiting on after it stops to report (item d2cbd4c6).
  const launch = typeof input?.agent_id === 'string' && input.agent_id ? { ...found, parent: input.agent_id } : found
  const state = load(resolveHookConversationId(raw))
  if (!state?.connection_id) return false
  const recorded = record(state.connection_id, launch)
  return recorded ? { state, launch } : false
}

/** The auth a hook posts with: the connection's own token and server, as main() uses. */
function hookAuth(state) {
  let token = state.token
  let mcpUrl = state.mcp_url
  if (!token) {
    const auth = resolveDevspecMcpAuth(state.cwd || process.cwd())
    token = auth.token
    mcpUrl = mcpUrl || auth.mcp_url
  }
  return token ? { token, mcpUrl: mcpUrl || 'https://api.devspec.ai/api/mcp' } : null
}

/**
 * Bring this turn's delegation group in the room's Activity up to date (item
 * d2cbd4c6). Posts nothing when the turn delegated nothing, when the connection is
 * not in a room, or when the turn's command identity cannot be established.
 * Failure is silent: Activity is a view, and the command does not depend on it.
 */
export async function updateDelegationTrail(state, {
  dir = CONNECTIONS_DIR,
  marker = readTurnMarker(state?.connection_id, dir),
  call = mcpToolsCall,
  auth = hookAuth(state || {}),
} = {}) {
  const connectionId = state?.connection_id
  if (!connectionId || !state.session_id || !marker || !auth) return { posted: 0 }
  const children = () => delegatedChildren(readOwnedLines(connectionId, marker, dir), marker.startedAt)
  if (children().length === 0) return { posted: 0 }
  const trail = ensureTrailState(connectionId, {
    dir,
    turn: marker.startedAt,
    resolveIdentity: () => {
      let inbox = ''
      try {
        inbox = fs.readFileSync(inboxPathFor(connectionId, dir), 'utf8')
      } catch {
        /* no delivered commands: only a local turn can be identified */
      }
      return turnIdentity({ state, marker, latestCommand: latestDeliveredCommand(inbox) })
    },
  })
  if (!trail) return { posted: 0 }
  return postLatest(connectionId, {
    dir,
    build: () => {
      const lines = readOwnedLines(connectionId, marker, dir)
      const event = delegationEvent(delegatedChildren(lines, marker.startedAt), { seq: trail.delegationSeq })
      return event ? { event, text: delegationText(lines, marker.startedAt) } : null
    },
    // Unchanged pictures are not re-sent (item 8ea07be1): after an answer, a repeat
    // can only open an empty bubble.
    isDelivered: (payload) => deliveredPicture(connectionId, { dir, turn: marker.startedAt }) === pictureKey(payload),
    onDelivered: (payload) => recordDeliveredPicture(connectionId, { dir, turn: marker.startedAt, key: pictureKey(payload) }),
    post: async ({ event, text }) => {
      try {
        await call({
          mcpUrl: auth.mcpUrl,
          token: auth.token,
          name: 'post_session_message',
          arguments: {
            connection_id: connectionId,
            agent_name: AGENT_NAME,
            phase: 'trail',
            message: text,
            trail_events: [event],
            ...trail.identity,
          },
          timeoutMs: 8_000,
        })
        return true
      } catch {
        return false
      }
    },
  })
}

/**
 * SubagentStop: a subagent this turn launched has finished. Record its end and bring
 * the delegation group up to date.
 */
export async function recordSubagentStop(raw, { load = loadState } = {}) {
  let input
  try {
    input = JSON.parse(raw || '{}')
  } catch {
    return false
  }
  const agentId = typeof input?.agent_id === 'string' ? input.agent_id : null
  if (!agentId) return false
  const state = load(resolveHookConversationId(raw))
  if (!state?.connection_id) return false
  if (subagentStillWaiting(state.connection_id, agentId, parseBackgroundTasks(raw))) return false
  if (!recordOwnedEnd(state.connection_id, agentId)) return false
  await updateDelegationTrail(state)
  return true
}

/**
 * Is owned work `id` still alive: in the host's in-flight list itself, or through
 * anything it started (recursively) that is?
 *
 * Measured 2026-10-05 on Claude Code 2.1.289: a subagent stops every time it reports,
 * including to say "my command is still running, I'll wait". While it waits, the
 * host lists the subagent's background command but NOT the subagent. So a subagent
 * has finished only when neither it nor anything it started is still listed.
 */
export function stillAlive(id, lines, listed) {
  const childrenOf = new Map()
  for (const entry of lines) {
    if (typeof entry.parent === 'string' && typeof entry.ended !== 'string') {
      if (!childrenOf.has(entry.parent)) childrenOf.set(entry.parent, [])
      childrenOf.get(entry.parent).push(entry.id)
    }
  }
  const seen = new Set()
  const visit = (current) => {
    if (seen.has(current)) return false
    seen.add(current)
    if (listed.has(current)) return true
    return (childrenOf.get(current) || []).some(visit)
  }
  return visit(id)
}

/**
 * A subagent's stop is final unless something it started is still running. It is
 * always listed itself at its own stop, so only its own work decides. A host that
 * sends no list cannot tell an interim stop from the last one, so it is taken as final.
 */
export function subagentStillWaiting(connectionId, agentId, backgroundTasks, { dir = CONNECTIONS_DIR } = {}) {
  if (!Array.isArray(backgroundTasks)) return false
  const marker = readTurnMarker(connectionId, dir)
  if (!marker) return false
  const listed = new Set(backgroundTasks.map((task) => task?.id).filter((taskId) => taskId !== agentId))
  return stillAlive(agentId, readOwnedLines(connectionId, marker, dir), listed)
}

/** The transcript path Claude Code passes every hook on stdin. */
export function parseTranscriptPath(raw) {
  try {
    const data = JSON.parse(raw || '{}')
    return typeof data.transcript_path === 'string' && data.transcript_path ? data.transcript_path : null
  } catch {
    return null
  }
}
export function clearTurnMarker(connectionId) {
  if (!connectionId) return
  try {
    fs.rmSync(turnMarkerPath(connectionId), { force: true })
    fs.rmSync(ownedWorkPath(connectionId), { force: true })
    fs.rmSync(path.join(CONNECTIONS_DIR, `${connectionId}.turn-trail.json`), { force: true })
  } catch {
    /* ignore */
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/**
 * The DevSpec connection to mirror for belongs to THIS local conversation. Resolve
 * its conversation id the SAME way remote-control-state.mjs `write` stamped it — via
 * the shared detectLocalId (probes whichever conversation-id env var THIS tool
 * exposes), then the hook stdin session_id. Tool-agnostic and SYMMETRIC with connect.
 */
export function resolveHookConversationId(hookInput, env = process.env) {
  const fromEnv = detectLocalId({}, env).local_id
  if (fromEnv) return fromEnv
  try {
    const parsed = JSON.parse(hookInput || '{}')
    if (typeof parsed.session_id === 'string' && parsed.session_id.trim()) {
      return parsed.session_id.trim()
    }
  } catch {
    /* fall through — fail closed below */
  }
  return null
}

/**
 * Choose the connection state bound to THIS conversation.
 *
 * Primary — a precise conversation bond: tools that expose a stable conversation id
 * (Claude/Grok/Codex, via detectLocalId) select the state whose local_id matches.
 * A machine-newer connection for a DIFFERENT conversation is never picked.
 *
 * Fallback — for tools that expose NO per-conversation id to their hooks (Cursor,
 * Antigravity): the single enabled connection for THIS agent. Safe ONLY because
 * "exactly one" means nothing to disambiguate; two+ concurrent connections of the
 * same agent fall closed (no mirror) rather than guess.
 */
export function selectBoundState(candidates, conversationId, agentName = null) {
  const enabled = candidates
    .filter(Boolean)
    .filter(({ raw }) => raw?.enabled === true && raw?.connection_id)

  const isMine = ({ raw }) =>
    !agentName ||
    String(raw.agent_name || '').toLowerCase() === String(agentName).toLowerCase()

  if (conversationId) {
    // The agent check matters as much as the id. A conversation id is unique to
    // its host, not across hosts, so matching on the id ALONE means a plugin
    // that somehow resolved a foreign id would be handed that host's live
    // connection — and then post, claim and disable as them (item 75f65461).
    // detectLocalId no longer returns foreign ids, so this is belt and braces;
    // it is also the half that keeps holding if an id arrives by another route.
    const bound = enabled
      .filter(isMine)
      .filter(({ raw }) => raw.local_id === conversationId)
      .sort((a, b) => b.mtime - a.mtime)[0]?.raw
    if (bound) return bound
  }

  if (agentName) {
    const mine = enabled.filter(
      ({ raw }) => String(raw.agent_name || '').toLowerCase() === String(agentName).toLowerCase(),
    )
    if (mine.length === 1) return mine[0].raw
  }

  return null
}

/**
 * Marker set by mark-explicit-reply.mjs (PostToolUse on the devspec
 * post_session_message tool) when the agent itself already posted a reply this
 * turn. Checked here so Stop never ALSO mirrors the turn's end-of-turn
 * narration as a second, redundant session message (item b9fb49a9 — the
 * "double post, real reply missing" symptom was this narration landing
 * alongside an explicit reply, not instead of one). Cleared unconditionally
 * once read so it can never leak into a later turn.
 */
export function explicitReplyMarkerPath(connectionId) {
  return path.join(CONNECTIONS_DIR, `${connectionId}.explicit-reply`)
}
export function consumeExplicitReplyMarker(connectionId) {
  if (!connectionId) return false
  const p = explicitReplyMarkerPath(connectionId)
  try {
    const existed = fs.existsSync(p)
    if (existed) fs.rmSync(p, { force: true })
    return existed
  } catch {
    return false
  }
}

/** Is a pid still running? EPERM means alive and not ours. */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !!e && e.code === 'EPERM'
  }
}

/**
 * Why did this Stop fail to find its connection, when the failure is one we can
 * NAME? (item 3b88955e.) An unbound Stop is ordinary — most conversations on a
 * machine are not connected to DevSpec, and they must stay silent. But two shapes
 * are real faults, and both present to the driver as a turn that never ends:
 *
 *  - a state file that exists and cannot be read (a torn read against a writer);
 *  - a state file whose bond is GONE (no local_id, so it can never match any
 *    conversation) while its poller is still alive and still holding a turn open.
 *
 * Only the second needs the liveness and marker checks: a wiped file for a dead
 * connection harms nobody and would otherwise warn in every terminal on the box.
 *
 * Returns a one-line reason, or null when there is nothing honest to say.
 */
export function stopBondDiagnostic(dir = CONNECTIONS_DIR) {
  let names = []
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return null
  }
  const unreadable = []
  const wiped = []
  for (const name of names) {
    const connectionId = name.slice(0, -'.json'.length)
    const result = readPrivateJsonResult(path.join(dir, name))
    if (result.status === STATE_UNREADABLE) {
      unreadable.push(connectionId)
      continue
    }
    if (result.status !== STATE_OK || !result.value) continue
    if (result.value.local_id) continue
    if (!fs.existsSync(path.join(dir, `${connectionId}.turn`))) continue
    const pollPid = Number.parseInt(
      (() => {
        try {
          return fs.readFileSync(path.join(dir, `${connectionId}.poll.pid`), 'utf8').trim()
        } catch {
          return ''
        }
      })(),
      10,
    )
    if (processAlive(pollPid)) wiped.push(connectionId)
  }
  if (unreadable.length > 0) {
    return (
      `state file unreadable for ${unreadable.join(', ')} — this turn cannot be ended ` +
      'from here; the connection must reconnect'
    )
  }
  if (wiped.length > 0) {
    return (
      `state file has lost its bond for ${wiped.join(', ')} (no local_id) while a live ` +
      'poller holds its turn open — that connection will show Working until it reconnects'
    )
  }
  return null
}

export function loadState(conversationId) {
  // Gather every candidate (legacy singleton + per-connection files) but NEVER
  // trust "most recent" — selectBoundState keeps only THIS conversation's state.
  const candidates = []
  try {
    if (fs.existsSync(LEGACY_STATE_PATH)) {
      const raw = readPrivateJson(LEGACY_STATE_PATH)
      if (raw) candidates.push({ raw, mtime: fs.statSync(LEGACY_STATE_PATH).mtimeMs })
    }
  } catch {
    /* continue with per-connection state */
  }
  try {
    if (fs.existsSync(CONNECTIONS_DIR)) {
      for (const file of fs.readdirSync(CONNECTIONS_DIR).filter((f) => f.endsWith('.json'))) {
        try {
          const p = path.join(CONNECTIONS_DIR, file)
          const raw = readPrivateJson(p)
          if (raw) candidates.push({ raw, mtime: fs.statSync(p).mtimeMs })
        } catch {
          /* ignore an incomplete or concurrently-replaced state file */
        }
      }
    }
  } catch {
    /* selection below fails closed when no readable matching state exists */
  }
  return selectBoundState(withoutConnectionsOwnedElsewhere(candidates), conversationId, AGENT_NAME)
}

/**
 * Drop live connections another Claude Code process owns (item 7e35d818). When this
 * conversation was resumed in another window, the conversation id is shared, so the
 * window it moved away from would otherwise keep mirroring its prompts into the room,
 * ending the new window's turns, and blocking on a listener it no longer needs.
 * Injectable for tests; a process that cannot place itself keeps every candidate.
 */
export function withoutConnectionsOwnedElsewhere(candidates, { myPid = resolveClaudePid(process.env), ownedElsewhere = ownedByAnotherProcess } = {}) {
  if (!myPid) return candidates
  return candidates.filter(({ raw } = {}) => raw?.enabled !== true || !ownedElsewhere(raw, myPid))
}

function extractLastText(hookInput, which) {
  let data
  try {
    data = JSON.parse(hookInput || '{}')
  } catch {
    return null
  }

  if (which === 'user_prompt') {
    return (
      data.prompt ||
      data.user_prompt ||
      data.message ||
      data.text ||
      data.content ||
      (typeof data.input === 'string' ? data.input : null) ||
      null
    )
  }

  if (typeof data.last_assistant_message === 'string') return data.last_assistant_message
  if (typeof data.assistant_message === 'string') return data.assistant_message
  if (typeof data.response === 'string') return data.response
  if (typeof data.output === 'string') return data.output
  const msgs = data.transcript || data.messages
  if (Array.isArray(msgs)) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m && (m.role === 'assistant' || m.type === 'assistant')) {
        const c = m.content
        if (typeof c === 'string' && c.trim()) return c
        if (Array.isArray(c)) {
          const text = c
            .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
            .map((b) => b.text || '')
            .join('\n')
            .trim()
          if (text) return text
        }
      }
    }
  }
  return null
}

/**
 * The origins, in Claude Code's own closed set (`prompt.submit`'s `e.origin.kind`),
 * of a prompt the person running this Claude Code submitted: typed at the terminal
 * (`composer`), sent through Claude Code's Remote Control from a phone or the web
 * (`bridge`), or the turn of an SDK host such as `claude -p` (`sdk`).
 *
 * Nothing else is the owner's words, and the room must never show it as if it were
 * (item dd1a8325): a scheduled or /loop firing (`scheduled-trigger`), a background
 * task's notification, which is how DevSpec's own wake stream arrives
 * (`task-notification`), another session, a channel, an unclassified turn, and any
 * kind added after this list was written. The stamp is the engine's, never read from
 * the text: a /loop firing carries exactly the text that was typed to start it.
 */
const PROMPT_ORIGINS_OF_A_PERSON = new Set(['composer', 'bridge', 'sdk'])

/** True only when the hooks module passed an origin that names a person (above). */
export function promptCameFromAPerson(hookInput) {
  try {
    const kind = JSON.parse(hookInput || '{}')?.origin?.kind
    return typeof kind === 'string' && PROMPT_ORIGINS_OF_A_PERSON.has(kind)
  } catch {
    return false
  }
}

const REMOTE_STATUS_BANNER = '━━━ DevSpec Remote Control ━━━'

/**
 * Strip the terminal status block agents often paste into Stop output.
 * Removes from the banner header through the trailing rule line.
 */
export function stripRemoteControlBanner(text) {
  const t = String(text ?? '')
  const start = t.indexOf(REMOTE_STATUS_BANNER)
  if (start < 0) return t
  const afterHeader = t.slice(start + REMOTE_STATUS_BANNER.length)
  // Prefer the unicode rule line used in skills; fall back to ASCII dashes.
  const ruleMatch = afterHeader.match(/\n[─-]{3,}\s*\n?/)
  let end = start + REMOTE_STATUS_BANNER.length
  if (ruleMatch && typeof ruleMatch.index === 'number') {
    end += ruleMatch.index + ruleMatch[0].length
  } else {
    // No rule line — drop from banner to end of that paragraph block.
    const nextBlank = afterHeader.search(/\n\s*\n/)
    end = nextBlank >= 0 ? start + REMOTE_STATUS_BANNER.length + nextBlank : t.length
  }
  return `${t.slice(0, start)}${t.slice(end)}`.replace(/^\s+|\s+$/g, '')
}

/**
 * True when Stop (or agent) text is operational chrome that must not become a
 * session chat bubble. Fail open for ambiguous / real replies.
 */
export function isOperationalChrome(text) {
  let t = String(text ?? '').trim()
  if (!t) return true

  if (/^🔌?\s*\*{0,2}Local agent disconnected\*{0,2}\.?\s*$/i.test(t)) return true
  if (/^You're connected to .+ agent on their local machine\.?\s*$/i.test(t)) return true
  if (/^Connected and waiting for your next command\b/i.test(t) && t.length < 280) return true

  if (t.includes(REMOTE_STATUS_BANNER)) {
    t = stripRemoteControlBanner(t).trim()
    if (!t) return true
    if (/^Connected and waiting for your next command\b/i.test(t) && t.length < 280) return true
    if (/^🔌?\s*\*{0,2}Local agent disconnected\*{0,2}\.?\s*$/i.test(t)) return true
    if (/^You're connected to .+ agent on their local machine\.?\s*$/i.test(t)) return true
    // Banner plus a tiny leftover (e.g. "Open: Agents page") — still chrome.
    if (t.length < 80 && /^(Agent|Connection|Session|Status|Open|Stop with):/m.test(t)) return true
  }

  return false
}

/*
 * ─── Listener enforcement (items 8b4ceaa3 + d655b2a4) ──────────────────────────
 *
 * Delivery used to be contingent on the model remembering to re-arm a one-shot
 * listener at the end of every turn. Miss it once — trivially easy in a turn that
 * also did six writes and a long reply — and the agent went permanently deaf while
 * every external signal still said it was fine: the poller heartbeating, the Agents
 * page showing Live and available, the inbox quietly filling up.
 *
 * The original v0.4.0 design never had this failure because ONE process both
 * heartbeated and woke the agent, so losing the waker also lost the heartbeat and the
 * chip went Disconnected — loud, and impossible to misread. Splitting liveness onto a
 * keeper-managed poller (item e254c6fb) fixed "Live drops while the agent works" and
 * left the wake channel with no keeper at all. So the thing still reporting Live is no
 * longer the thing that wakes you.
 *
 * This is the missing keeper. Stop already fires at the end of every turn and already
 * owns connection state, and a Stop hook can REFUSE the stop and hand the model a
 * reason — so it can enforce mechanically what the skill could previously only ask
 * for. Note what this deliberately does NOT do: it does not spawn the listener
 * itself. A hook-spawned wait is not harness-managed, so its exit could never wake
 * the model — proven by accident on item d655b2a4 (a detached wait survived, consumed
 * the inbox, and woke nobody, which is strictly worse than no listener at all).
 * Blocking makes the AGENT arm it, in the one way that actually wakes this host.
 *
 * Item be0a929a then found the other half of that lesson. Harness-managed was the right
 * requirement; TURN-scoped was the accident. A tracked background task is reaped at turn
 * end, so the agent could comply perfectly and still be blocked on the next turn, for
 * ever. The fix keeps this hook exactly as it is and changes what it points at: a
 * `--stream` arm under Monitor is still harness-managed (its stdout reaches the model)
 * but is not tied to the turn, so one arm satisfies every subsequent Stop. Harness-managed
 * is not detached — that distinction is what makes it safe here.
 *
 * The host serves one of two Monitor schemas. With `persistent`, one arm lasts the whole
 * session. Without it (`timeout_ms` capped, "re-arm at expiry"), `persistent: true` is
 * accepted and silently discarded, so the arm dies at its deadline and this block is how
 * the agent learns to re-arm — which is correct, and is why the way out must NEVER name a
 * background task. That fallback used to be written here and is verbatim the be0a929a
 * configuration; on this host it is a loop, not a fallback.
 */

function inboxPathFor(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.inbox.jsonl`)
}

function waitPidPathFor(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.wait.pid`)
}

/** EPERM = the pid exists and is not ours. Same probe the poller uses for its owner. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !!e && e.code === 'EPERM'
  }
}

/**
 * Is a listener armed for this connection right now?
 *
 * Proved with a live pid, never with the file's mere existence: a wait killed by
 * SIGKILL leaves its pidfile behind, and believing a stale file would reproduce the
 * exact bug this exists to catch.
 */
export function isListenerArmed(connectionId, dir = CONNECTIONS_DIR) {
  if (!connectionId) return false
  try {
    const pid = Number.parseInt(fs.readFileSync(waitPidPathFor(connectionId, dir), 'utf8').trim(), 10)
    return pidAlive(pid)
  } catch {
    return false
  }
}

/**
 * How many owner commands are sitting in the inbox that no listener has consumed?
 *
 * `inbox_byte_offset` is the wait's cursor, so anything past it has been delivered by
 * the poller and read by nobody. Advisory entries are ignored on purpose — they never
 * warranted a wake, so they must not hold a turn open either.
 */
export function countUnreadOwnerCommands(connectionId, offset, dir = CONNECTIONS_DIR) {
  if (!connectionId) return 0
  const file = inboxPathFor(connectionId, dir)
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    return 0
  }
  const from = Number.isInteger(offset) && offset >= 0 ? offset : size
  if (size <= from) return 0
  let text = ''
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(size - from)
      fs.readSync(fd, buf, 0, size - from, from)
      text = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return 0
  }
  const lastNl = text.lastIndexOf('\n')
  if (lastNl === -1) return 0
  let count = 0
  for (const line of text.slice(0, lastNl + 1).split('\n')) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      if (obj?.type === 'canonical_commands') {
        const ids = Array.isArray(obj.execute_message_ids)
          ? obj.execute_message_ids
          : Array.isArray(obj.ingress?.command_message_ids)
            ? obj.ingress.command_message_ids
            : []
        count += ids.length
      } else if (obj?.type === 'canonical_control' || obj?.type === 'automation_run') {
        count++
      } else if (obj?.type === 'interaction_answer' && obj.disposition === DELIVERED) {
        // Not a command, but a person is waiting on it just as directly.
        count++
      }
    } catch {
      /* skip garbage */
    }
  }
  return count
}

/**
 * `stop_hook_active` is true when this Stop is itself the result of a previous Stop
 * hook block. Blocking again from there is how you build an infinite loop, so we
 * refuse to — the harness would override us anyway and log a warning.
 */
export function parseStopHookActive(hookInput) {
  try {
    return JSON.parse(hookInput || '{}').stop_hook_active === true
  } catch {
    return false
  }
}

/** Bounded wait so a listener the agent armed moments ago is not called missing. */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Probe for an armed listener, tolerating the spawn race.
 *
 * The agent arms the wait as a background task and can finish its turn before that
 * process has written its pidfile. A single probe would read "no listener", block a
 * turn that did everything right, and cost a model turn to no purpose — so give the
 * spawn a moment before believing it. Cheap: only the already-failing path pays, and
 * the Stop hook's budget is 30s.
 */
export async function listenerArmedWithGrace(
  connectionId,
  { attempts = 4, delayMs = 250, dir = CONNECTIONS_DIR, probe = isListenerArmed } = {},
) {
  for (let i = 0; i < attempts; i++) {
    if (probe(connectionId, dir)) return true
    if (i < attempts - 1) await sleep(delayMs)
  }
  return false
}

/**
 * Should this Stop be refused? Returns a `reason` string, or null to let the turn end.
 *
 * The decision hinges on ONE thing: is a listener armed? If one is, the turn may end
 * freely — anything unread is that listener's job, and it will wake the agent again by
 * exiting. We block only when nothing is listening, and the reason we give depends on
 * whether mail is already stranded:
 *   - stranded mail — commands the poller delivered and nobody read. This is the
 *     2026-07-30 incident verbatim: the owner posted twice, concluded the tooling had
 *     died, and everything was healthy except that nobody was listening.
 *   - nothing yet — the turn is ending with nothing watching, so the NEXT command is
 *     the one that would vanish.
 */
export function decideStopBlock({ connectionId, inboxOffset, stopHookActive, armed, dir = CONNECTIONS_DIR } = {}) {
  if (!connectionId) return null
  // Already blocked once this turn — say nothing and let the agent stop. The harness
  // would force the stop through anyway and log a warning.
  if (stopHookActive) return null
  // A listener is on watch: not our problem to solve, and blocking would be noise.
  if (armed) return null

  const unread = countUnreadOwnerCommands(connectionId, inboxOffset, dir)

  // The remediation must name the SESSION-SCOPED arm, never the turn-scoped one.
  // Pointing the agent at a tracked background task is what made this block
  // unterminable on a host that reaps at turn end (item be0a929a): it complied, got
  // reaped, and was blocked again — one model turn per lap, forever. The `--stream`
  // arm is made once and outlives the turn, so the very next Stop passes cleanly.
  // Note this changes only the WAY OUT of the block. The decision above is untouched:
  // a turn ending with nothing listening is still refused, exactly as 8b4ceaa3 shipped.
  const rearm =
    'node "$CLAUDE_PLUGIN_ROOT/hooks/scripts/devspec-remote-wait.mjs" ' +
    `--connection-id ${connectionId} --owner-pid "$PPID" --stream --pending` +
    '\nArm it with the Monitor tool — NEVER as a background task, which this host reaps ' +
    'at turn end (item be0a929a). It prints one JSON line per owner command and keeps ' +
    'watching. If Monitor has a persistent property, pass persistent: true and one arm ' +
    'lasts the session. If it has not, pass the largest timeout_ms it allows and arm ' +
    'again with --stream --pending each time it expires.'

  if (unread > 0) {
    return (
      `DevSpec remote control: ${unread} owner command(s) are sitting unread in this ` +
      `connection's inbox with no listener armed to consume them. Nothing is broken — ` +
      `the poller delivered them correctly; you simply never saw them. Do not stop. ` +
      `Arm the wake stream, then read and act on what it hands you:\n${rearm}`
    )
  }

  return (
    'DevSpec remote control: this turn is ending with NO wake listener armed, so the ' +
    'next command your owner sends would land in the inbox and never reach you — ' +
    'while the Agents page keeps showing you as Live and available. Do not stop. ' +
    `Arm the wake stream first:\n${rearm}`
  )
}

/**
 * Prepare agent Stop text for mirroring: strip known chrome; return null to skip.
 */
export function prepareAgentMirrorText(text) {
  let t = String(text ?? '').trim()
  if (!t) return null
  if (t.includes(REMOTE_STATUS_BANNER)) t = stripRemoteControlBanner(t).trim()
  if (!t || isOperationalChrome(t)) return null
  return t.slice(0, 12000)
}

async function main() {
  const raw = readStdin()
  if (mode === 'background_launch') {
    try {
      const recorded = recordBackgroundLaunch(raw)
      if (recorded && DELEGATED_KINDS.has(recorded.launch.kind)) await updateDelegationTrail(recorded.state)
    } catch {
      /* a launch we could not record only means the turn may close early */
    }
    process.exit(0)
  }
  if (mode === 'subagent_stop') {
    try {
      await recordSubagentStop(raw)
    } catch {
      /* Activity is a view; the command never depends on it */
    }
    process.exit(0)
  }
  const conversationId = resolveHookConversationId(raw)
  const state = loadState(conversationId)
  if (!state) {
    // Unbound is normal and silent. A NAMED fault is not: say it once, so a turn
    // that will not end has a cause someone can read instead of a spinner.
    if (mode === 'stop') {
      const reason = stopBondDiagnostic()
      if (reason) process.stderr.write(`[devspec-remote] stop could not bind: ${reason}\n`)
    }
    process.exit(0)
  }

  // The module ends a turn for DevSpec itself when no Stop hook ran for it (an
  // interrupt, a denied prompt), and this record is how it knows one did (item
  // cbf3d758, control-relay.mjs).
  if (mode === 'stop' && state.connection_id) {
    try {
      writePrivateJson(path.join(CONNECTIONS_DIR, `${state.connection_id}.stop-hook.json`), { at: new Date().toISOString() })
    } catch {
      /* a missing record only means the module ends this turn a second time, harmlessly */
    }
  }

  let token = state.token
  let mcpUrl = state.mcp_url
  if (!token) {
    const auth = resolveDevspecMcpAuth(state.cwd || process.cwd())
    token = auth.token
    mcpUrl = mcpUrl || auth.mcp_url
  }
  if (!token) process.exit(0) // silent — skill still posts instructionally

  mcpUrl = mcpUrl || 'https://api.devspec.ai/api/mcp'
  // Identity is a fixed property of THIS plugin — never trust state/args for it.
  const agentName = AGENT_NAME
  const connectionId = state.connection_id
  const sessionId = state.session_id || null // null = sessionless (no room to mirror into)
  const localId = state.local_id || null

  const text = extractLastText(raw, mode)
  const fromAPerson = mode === 'user_prompt' && promptCameFromAPerson(raw)

  // Consume any explicit-reply marker so it cannot bleed into a later turn.
  // Agent answers are skill-posted (ADR b98a39a9); Stop no longer mirrors full
  // assistant text as a primary path — dual writers caused wrong-voice dupes
  // and silent misses when bonding failed.
  if (mode === 'stop') consumeExplicitReplyMarker(connectionId)

  // Refuse a stop that would leave this connection deaf (items 8b4ceaa3, d655b2a4).
  // Decided BEFORE the turn-lifecycle writes below, because a blocked stop is not a
  // turn end: clearing busy here would tell the driver the agent finished while it is
  // still going, which is the bug 68f7b30c already fixed once from the other side.
  // Short-circuit before the grace probe when we already know we will not block —
  // no reason to spend 750ms on a turn whose outcome is settled.
  const stopHookActive = mode === 'stop' ? parseStopHookActive(raw) : false
  const blockReason =
    mode === 'stop' && connectionId && !stopHookActive
      ? decideStopBlock({
          connectionId,
          inboxOffset: state.inbox_byte_offset,
          stopHookActive,
          armed: await listenerArmedWithGrace(connectionId),
        })
      : null

  // A Stop that only pauses the command for background work keeps the turn open
  // (item f4a79327). Decided here, with the block, for the same reason: it is not a
  // turn end, so busy stays on and nothing is reported complete.
  const turnMarker = mode === 'stop' && connectionId && !blockReason ? readTurnMarker(connectionId) : null
  const backgroundHold = turnMarker
    ? backgroundHoldDecision({
        marker: turnMarker,
        transcriptPath: parseTranscriptPath(raw),
        backgroundTasks: parseBackgroundTasks(raw),
        ownedIds: readOwnedIds(connectionId, turnMarker),
      })
    : null
  if (backgroundHold) {
    process.stderr.write(
      `[devspec-remote] command kept open: ${backgroundHold.length} background job(s) still running\n`,
    )
  }
  // Delegated work the host no longer lists has ended; the group says so before the
  // turn's records are cleared (item d2cbd4c6).
  const hostList = turnMarker ? parseBackgroundTasks(raw) : null
  if (turnMarker && Array.isArray(hostList)) {
    try {
      const listed = new Set(hostList.map((task) => task?.id))
      const lines = readOwnedLines(connectionId, turnMarker)
      for (const child of delegatedChildren(lines, turnMarker.startedAt)) {
        if (child.status === 'running' && !stillAlive(child.id, lines, listed)) recordOwnedEnd(connectionId, child.id)
      }
      await updateDelegationTrail(state, { marker: turnMarker })
    } catch {
      /* Activity is a view; the turn's end never depends on it */
    }
  }

  try {
    // A prompt typed at this terminal opens the owner's own turn, admitted with the
    // connection capability BEFORE the model starts, so every write it makes names
    // the owner as the person who asked (item 718825fc, local-turn.mjs). Nothing
    // else does: a room command carries its own requester, a background wake
    // continues the turn that is already open, and a scheduled firing was asked for
    // by nobody at this moment.
    if (fromAPerson && connectionId && sessionId && text && String(text).trim()) {
      const scope = localTurnScope(state, sessionId)
      if (scope) {
        const admitted = await startLocalTurn({
          scope,
          previousAttemptId: state.local_turn?.attempt_id ?? null,
          call: (args) => mcpToolsCall({
            mcpUrl,
            token,
            connectionCapability: state.connection_capability,
            name: 'report_pickup',
            arguments: args,
          }),
        })
        if (admitted) patchOwnState(connectionId, { local_turn: admitted })
      }
    }

    // LOCAL PROMPT only: mirror owner text typed in the terminal into the room
    // when attached (two-sided transcript). Agent Stop text is NOT posted here —
    // the skill must post_session_message the direct answer (prefer connection_id).
    if (fromAPerson && sessionId && text && String(text).trim()) {
      const cleaned = String(text).trim().slice(0, 12000)
      if (cleaned) {
        const postArgs = {
          message: cleaned,
          agent_name: agentName,
          turn_kind: 'local_prompt',
        }
        // Prefer connection_id so reattach is server-resolved (delivery contract).
        if (connectionId) postArgs.connection_id = connectionId
        else postArgs.session_id = sessionId
        await mcpToolsCall({
          mcpUrl,
          token,
          name: 'post_session_message',
          arguments: postArgs,
        })
      }
    }

    // Turn lifecycle → "working" authority. user_prompt starts a turn (busy:true +
    // marker so the poller re-asserts); stop ends it (busy:false + clear marker).
    // Marker is keyed by connection_id (the poller reads it by connection_id).
    // A blocked stop keeps the turn OPEN — the agent is about to re-arm and carry on.
    // So does a stop that is waiting on the agent's own background work.
    const turnActive = mode === 'user_prompt' || !!blockReason || !!backgroundHold
    if (turnActive) writeTurnMarker(connectionId)
    else clearTurnMarker(connectionId)

    // Busy heartbeat — one connection-native path (attached or sessionless). The
    // server broadcasts agent_status for the attached session, so no session-keyed
    // heartbeat is needed.
    if (connectionId) {
      await mcpToolsCall({
        mcpUrl,
        token,
        name: 'heartbeat_connection',
        arguments: {
          connection_id: connectionId,
          agent_name: agentName,
          status: 'live',
          busy: turnActive,
        },
      })
      // End the activity attempt immediately on Stop. The poller also emits
      // report_complete when the marker disappears, but that waits for the next
      // long-poll tick — so Working / dots linger for seconds after the answer has
      // already landed. Calling it here drops them as soon as the turn ends, and
      // means a healthy Stop no longer depends on the poller to finish the turn.
      //
      // An exact directed-question attempt is the ONE case the generic call must not
      // touch: closing an attempt from outside its claim generation is how other hosts
      // sealed empty "No response" bubbles. It gets its own exact completion below,
      // and only once its answer has actually reached the model.
      if (!turnActive) {
        const stopDecision = stopInteractionDecision({
          continuation: activeContinuation(state.interaction_continuation, {
            connectionId,
            sessionId,
          }),
          inboxByteOffset: state.inbox_byte_offset,
        })
        // 'hold' completes nothing at all: the answer is still in flight, and closing
        // the connection's current attempt now would close THAT one. The window is the
        // wait's poll interval (sub-second), and its cost is bounded — the delivery
        // wakes the model immediately and that turn's end completes exactly — whereas
        // sealing an attempt whose answer the model never saw is unrecoverable.
        if (stopDecision.action !== 'hold') {
          // A terminal turn this connection admitted closes exactly; anything else
          // keeps the connection-scoped completion it always had.
          const localAttempt = localTurnToComplete(state.local_turn, sessionId)
          try {
            await mcpToolsCall({
              mcpUrl,
              token,
              ...(stopDecision.action === 'complete'
                ? { connectionCapability: state.connection_capability }
                : {}),
              name: 'report_complete',
              arguments: stopDecision.action === 'complete'
                ? {
                    connection_id: connectionId,
                    attempt_id: stopDecision.continuation.attempt_id,
                    reason: 'turn_end',
                    ...continuationIdentity(stopDecision.continuation),
                  }
                : localAttempt
                  ? { connection_id: connectionId, attempt_id: localAttempt, reason: 'turn_end' }
                  : { connection_id: connectionId, reason: 'turn_end' },
            })
            if (stopDecision.action === 'complete') clearStoredContinuation(connectionId)
          } catch {
            /* non-fatal — the poller's marker-driven backstop still runs */
          }
          // The turn is over whether or not the completion landed: never carry it
          // into the next one.
          if (state.local_turn) patchOwnState(connectionId, { local_turn: null })
        }
      }
    }
  } catch (e) {
    process.stderr.write(`[devspec-remote] ${e instanceof Error ? e.message : String(e)}\n`)
  }

  // Decision control goes on stdout with exit 0 — deliberately NOT exit 2. The hook
  // is registered as `node mirror-turn.mjs stop || true`, and that `|| true` would
  // swallow an exit-2 block entirely, so the JSON form is the only one that actually
  // works here. It is also the better contract: `reason` reaches the model as a
  // system message it can act on.
  if (blockReason) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason }) + '\n')
  }
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
