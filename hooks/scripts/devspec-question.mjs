#!/usr/bin/env node
/**
 * Capability-safe bridge for asking one person a directed question, and for finishing
 * the turn their answer opens (item 54b63e47).
 *
 * Claude Code cannot add a header learned at connect time to a later native MCP call,
 * and the server requires the exact-connection capability for BOTH sides of this
 * feature: `manage_directed_question` (so an agent can only manage its OWN questions)
 * and the exact event-bound continuation (so only the connection the answer was
 * addressed to can finish it). Connect already stores that capability in mode-0600
 * connection state, so this bridge injects it mechanically — the same shape as
 * devspec-plan.mjs, and deliberately just as narrow: only these two operations are
 * reachable here, never the poll/heartbeat/delivery verbs the pump owns.
 *
 *   node devspec-question.mjs describe --connection-id <uuid>
 *   node devspec-question.mjs use      --connection-id <uuid> --input '<JSON>'
 *   node devspec-question.mjs status   --connection-id <uuid>
 *   node devspec-question.mjs respond  --connection-id <uuid> --message '<reply>'
 *
 * `respond` exists because an answer arrives inside its own exact attempt. Replying
 * through the ordinary session path would leave that attempt open and the room showing
 * Working with nothing working — the failure this whole channel was built to end. One
 * `respond` call stores the reply and completes the exact attempt in the same request.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mcpToolsCall, mcpToolsList } from './mcp-call.mjs'
import { clearTurnMarker } from './devspec-remote-wait.mjs'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import {
  activeContinuation,
  continuationIdentity,
  INTERACTION_EVENT_CONTRACT_URI,
} from './interaction-events.mjs'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOOL = 'manage_directed_question'
const COMMANDS = new Set(['describe', 'use', 'status', 'respond'])
const ACTIONS = new Set(['create', 'list', 'get', 'cancel'])
const PROPERTIES = new Set([
  'action', 'question_id', 'client_request_id', 'response_kind', 'prompt', 'options',
  'allow_custom', 'keep_turn', 'provenance_ref', 'expected_revision',
])
const RESPONSE_KINDS = new Set(['text', 'single_select', 'multi_select'])
const MAX_PROMPT_CODE_POINTS = 4000
const MAX_OPTION_CODE_POINTS = 200
const MAX_OPTIONS = 20
const MAX_REPLY_CHARS = 12_000

export function parseArgs(argv) {
  const out = { command: null, connectionId: null, input: null, message: null, keepTurn: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!out.command && COMMANDS.has(arg)) out.command = arg
    else if (arg === '--connection-id' || arg === '--connection_id') out.connectionId = argv[++index]
    else if (arg === '--input' || arg === '--json') out.input = argv[++index]
    else if (arg === '--message' || arg === '--reply') out.message = argv[++index]
    // Maps onto manage_directed_question keep_turn so host and server cannot disagree.
    else if (arg === '--keep-turn' || arg === '--keep_turn') out.keepTurn = true
  }
  return out
}

/**
 * Asking is a turn boundary.
 *
 * Waiting for a person is not working, but the turn used to stay open across the wait,
 * so the room showed Working while nothing worked — and, worse, the open attempt is
 * exactly what stops the answer's exact reply channel being claimed, so the answer
 * could not be delivered until the turn happened to end. Measured 2026-08-26: 63
 * minutes, 40 of them with the agent idle (item 79c4aa63).
 *
 * So a successful ask ends the turn by default. The answer then starts a fresh turn,
 * which is what the server already models — the continuation opens its own attempt.
 *
 * `--keep-turn` is for the genuine other case: asking something and carrying on with
 * other work. It sets keep_turn on the create so the server leaves the turn open.
 *
 * The server ends the turn inside the create, so this host only stops CLAIMING it.
 * Generic completion belongs to Stop and the poller; see the boundary block below.
 *
 * Never while holding a continuation: releasing the marker there would let Stop
 * generically complete the exact interaction attempt from outside its claim
 * generation, which is the second-writer failure that produced empty sealed
 * bubbles elsewhere.
 */
/** Keep host flag and tool argument on the same create payload. */
export function directedQuestionToolArguments(input, { keepTurn } = {}) {
  if (input?.action === 'create' && keepTurn) return { ...input, keep_turn: true }
  return input
}

export function askTurnBoundaryPlan({ action, keepTurn, continuation, result } = {}) {
  if (action !== 'create') return { endTurn: false, reason: 'not an ask' }
  if (keepTurn) return { endTurn: false, reason: 'caller has more work this turn' }
  if (continuation) return { endTurn: false, reason: 'an exact interaction attempt is open' }
  if (result?.question?.status !== 'pending') {
    return { endTurn: false, reason: 'no pending question was created' }
  }
  return { endTurn: true, reason: 'asked and stopped' }
}

function codePoints(value) {
  return Array.from(String(value)).length
}

/**
 * Reject locally what the server would reject anyway, so a malformed question costs a
 * clear message instead of a round trip. The bounds are the server's — never widen
 * them here; a local rule that is looser than the server's is just a confusing error
 * in a different place.
 */
export function validateDirectedQuestionArguments(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: `${TOOL} input must be a JSON object` }
  }
  if (!ACTIONS.has(input.action)) return { ok: false, error: `unknown ${TOOL} action` }
  const unknown = Object.keys(input).find((key) => !PROPERTIES.has(key))
  if (unknown) return { ok: false, error: `unknown ${TOOL} property: ${unknown}` }

  if (input.action === 'create') {
    if (typeof input.client_request_id !== 'string' || !UUID.test(input.client_request_id)) {
      return { ok: false, error: 'create requires a caller-generated UUID client_request_id' }
    }
    if (!RESPONSE_KINDS.has(input.response_kind)) {
      return { ok: false, error: 'create requires response_kind text, single_select or multi_select' }
    }
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
      return { ok: false, error: 'create requires a non-empty prompt' }
    }
    if (codePoints(input.prompt) > MAX_PROMPT_CODE_POINTS) {
      return { ok: false, error: `prompt must be at most ${MAX_PROMPT_CODE_POINTS} characters` }
    }
    const selectKind = input.response_kind !== 'text'
    if (selectKind) {
      if (!Array.isArray(input.options) || input.options.length < 2) {
        return { ok: false, error: 'select questions require at least two options' }
      }
      if (input.options.length > MAX_OPTIONS) {
        return { ok: false, error: `at most ${MAX_OPTIONS} options` }
      }
      if (input.options.some((option) => typeof option !== 'string' || !option.trim())) {
        return { ok: false, error: 'every option must be a non-empty string' }
      }
      if (input.options.some((option) => codePoints(option) > MAX_OPTION_CODE_POINTS)) {
        return { ok: false, error: `options must be at most ${MAX_OPTION_CODE_POINTS} characters` }
      }
      const trimmed = input.options.map((option) => option.trim())
      if (new Set(trimmed).size !== trimmed.length) {
        return { ok: false, error: 'options must be distinct' }
      }
    } else {
      if (Object.hasOwn(input, 'options')) {
        return { ok: false, error: 'a text question takes no options' }
      }
      if (Object.hasOwn(input, 'allow_custom')) {
        return { ok: false, error: 'allow_custom applies only to select questions' }
      }
    }
    if (Object.hasOwn(input, 'allow_custom') && typeof input.allow_custom !== 'boolean') {
      return { ok: false, error: 'allow_custom must be a boolean' }
    }
    if (Object.hasOwn(input, 'keep_turn') && typeof input.keep_turn !== 'boolean') {
      return { ok: false, error: 'keep_turn must be a boolean' }
    }
    if (Object.hasOwn(input, 'provenance_ref') &&
        (typeof input.provenance_ref !== 'string' || !UUID.test(input.provenance_ref))) {
      return { ok: false, error: 'provenance_ref must be a full UUID' }
    }
    return { ok: true }
  }

  if (input.action === 'list') {
    const extra = Object.keys(input).find((key) => key !== 'action')
    return extra ? { ok: false, error: `list takes no ${extra}` } : { ok: true }
  }

  if (typeof input.question_id !== 'string' || !UUID.test(input.question_id)) {
    return { ok: false, error: `${input.action} requires a full question_id UUID` }
  }
  if (input.action === 'cancel' &&
      (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1)) {
    return { ok: false, error: 'cancel requires the current expected_revision' }
  }
  return { ok: true }
}

export function readQuestionConnectionState(connectionId, dir = CONNECTIONS_DIR) {
  if (typeof connectionId !== 'string' || !UUID.test(connectionId)) {
    throw new Error('missing or invalid --connection-id')
  }
  const state = readPrivateJson(path.join(dir, `${connectionId}.json`))
  if (!state) throw new Error('connection state is unavailable or unreadable')
  if (state.connection_id !== connectionId || state.enabled === false) {
    throw new Error('connection state is unavailable or disabled')
  }
  if (!state.session_id) {
    throw new Error('a directed question needs an attached DevSpec session — there is nobody to ask')
  }
  if (!state.token || !state.mcp_url) throw new Error('connection MCP authentication is unavailable')
  if (!state.connection_capability) {
    throw new Error(
      'this connection has no question capability; reconnect with the current plugin so ' +
      'register_connection negotiates it',
    )
  }
  return state
}

export function questionRequestOptions(state) {
  return {
    mcpUrl: state.mcp_url,
    token: state.token,
    connectionCapability: state.connection_capability,
    timeoutMs: 30_000,
  }
}

/** Drop the resolved continuation without disturbing concurrently-written fields. */
export function clearStoredContinuation(connectionId, dir = CONNECTIONS_DIR) {
  const statePath = path.join(dir, `${connectionId}.json`)
  const prev = readPrivateJson(statePath)
  if (!prev) return
  writePrivateJson(statePath, {
    ...prev,
    interaction_continuation: null,
    updated_at: new Date().toISOString(),
  })
}

/**
 * The exact-attempt final post. `command_turn_unbound` says this reply belongs to no
 * owner command (it belongs to an answer), `attempt_id` plus the event identity names
 * the exact attempt, and `complete_turn` closes it in the same request so Working
 * clears with the bubble rather than seconds later.
 */
export function respondArguments({ connectionId, continuation, message }) {
  return {
    connection_id: connectionId,
    message,
    agent_name: AGENT_NAME,
    attempt_id: continuation.attempt_id,
    command_turn_unbound: true,
    complete_turn: true,
    ...continuationIdentity(continuation),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.command) throw new Error('expected describe, use, status or respond')
  const state = readQuestionConnectionState(args.connectionId)
  const options = questionRequestOptions(state)
  const continuation = activeContinuation(state.interaction_continuation, {
    connectionId: args.connectionId,
    sessionId: state.session_id,
  })

  if (args.command === 'describe') {
    const tools = await mcpToolsList(options)
    const tool = tools.find((candidate) => candidate?.name === TOOL)
    if (!tool) throw new Error(`server did not advertise ${TOOL}`)
    process.stdout.write(JSON.stringify(tool, null, 2) + '\n')
    return
  }

  if (args.command === 'status') {
    process.stdout.write(JSON.stringify({
      connection_id: args.connectionId,
      session_id: state.session_id,
      contract: INTERACTION_EVENT_CONTRACT_URI,
      awaiting_reply: Boolean(continuation),
      question_id: continuation?.question_id ?? null,
    }, null, 2) + '\n')
    return
  }

  if (args.command === 'respond') {
    if (!continuation) {
      throw new Error(
        'no answered question is waiting on a reply for this connection. Post an ordinary ' +
        'answer with post_session_message instead.',
      )
    }
    const raw = args.message ?? fs.readFileSync(0, 'utf8')
    const message = String(raw).trim()
    if (!message) throw new Error('respond requires a non-empty --message (or stdin)')
    const result = await mcpToolsCall({
      ...options,
      name: 'post_session_message',
      arguments: respondArguments({
        connectionId: args.connectionId,
        continuation,
        message: message.slice(0, MAX_REPLY_CHARS),
      }),
    })
    // Only after the server stored the reply and completed the attempt: keeping it
    // would make the Stop hook complete an attempt that is already done.
    clearStoredContinuation(args.connectionId)
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return
  }

  const raw = args.input ?? fs.readFileSync(0, 'utf8')
  let input
  try {
    input = JSON.parse(raw)
  } catch {
    throw new Error('use requires valid JSON via --input or stdin')
  }
  const validation = validateDirectedQuestionArguments(input)
  if (!validation.ok) throw new Error(validation.error)
  const result = await mcpToolsCall({
    ...options,
    name: TOOL,
    arguments: directedQuestionToolArguments(input, { keepTurn: args.keepTurn }),
  })

  const boundary = askTurnBoundaryPlan({
    action: input.action,
    keepTurn: args.keepTurn,
    continuation,
    result,
  })
  if (boundary.endTurn) {
    // The server closes the asking turn inside the create, so all this host has to do
    // is stop claiming it: clear the marker, or the poller observes a true→true tick
    // and keepalives the attempt the server just closed.
    //
    // It deliberately does not complete the turn itself. Measured on a live Claude Code
    // connection 2026-08-27: the server closed the generic attempt 67ms after the card
    // existed, naming `directed_question_asked`, and this host's extra report_complete
    // was a pure no-op — one attempt row, no phantom, no empty sealed bubble. Cursor
    // (f23030e) and Grok (edc5157) had already dropped theirs; keeping one here only
    // bought a redundant round trip per ask and a second writer on a row it does not own.
    //
    // Dropping it does not leave the turn unguarded. Stop completes an ordinary turn end
    // with `turn_end` and the poller completes on the marker transition, so a server
    // without the ask-ends-turn change still gets its turn closed — one layer later, by
    // the two mechanisms that already own generic completion.
    clearTurnMarker(args.connectionId)
  }
  process.stdout.write(JSON.stringify({ ...result, turn_ended: boundary.endTurn }, null, 2) + '\n')
}

const isMain = Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`devspec-question: ${error?.message || String(error)}\n`)
    process.exit(1)
  })
}
