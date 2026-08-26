#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import {
  activeContinuation,
  answerSummary,
  buildInteractionAnswerEvents,
  classifyContinuationStart,
  continuationDelivered,
  continuationIdentity,
  DELIVERED,
  interactionActivityPlan,
  interactionAnswerRecord,
  interactionEventsNegotiable,
  interactionNegotiationArguments,
  INTERACTION_ANSWER_RECORD_TYPE,
  INTERACTION_EVENT_CONTRACT_URI,
  scanPersistedInteractionEventIds,
  stopInteractionDecision,
  validateInteractionAnswerRecord,
  validateInteractionEvent,
} from './interaction-events.mjs'
import {
  clearStoredContinuation,
  questionRequestOptions,
  readQuestionConnectionState,
  respondArguments,
  validateDirectedQuestionArguments,
} from './devspec-question.mjs'
import { countUnconsumedCommands, scanPersistedInboxRecords } from './devspec-remote-poll.mjs'
import { parseInboxBatches } from './devspec-remote-wait.mjs'
import { countUnreadOwnerCommands } from './mirror-turn.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const WAIT_SCRIPT = path.join(HERE, 'devspec-remote-wait.mjs')
const QUESTION_SCRIPT = path.join(HERE, 'devspec-question.mjs')
const MIRROR_SCRIPT = path.join(HERE, 'mirror-turn.mjs')
const POLL_SCRIPT = path.join(HERE, 'devspec-remote-poll.mjs')

const CONNECTION = '10000000-0000-4000-8000-000000000001'
const SIBLING = '10000000-0000-4000-8000-0000000000ff'
const SESSION = '20000000-0000-4000-8000-000000000002'
const OTHER_SESSION = '20000000-0000-4000-8000-0000000000ff'
const EVENT = '30000000-0000-4000-8000-000000000003'
const RESPONSE = '40000000-0000-4000-8000-000000000004'
const QUESTION = '50000000-0000-4000-8000-000000000005'
const CLAIM = '60000000-0000-4000-8000-000000000006'
const ATTEMPT = '70000000-0000-4000-8000-000000000007'
const LOCAL_ID = '80000000-0000-4000-8000-000000000008'

function source(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

function event(overrides = {}) {
  return {
    kind: 'devspec.interaction_event',
    version: 1,
    event_id: EVENT,
    response_id: RESPONSE,
    question_id: QUESTION,
    origin_connection_id: CONNECTION,
    source_session_id: SESSION,
    response_kind: 'single_select',
    answer: 'Feature works correctly',
    answered_at: '2026-08-26T16:00:00.000Z',
    claim_token: CLAIM,
    lease_expires_at: '2026-08-26T16:00:30.000Z',
    ...overrides,
  }
}

function continuation(overrides = {}) {
  return {
    event_id: EVENT,
    response_id: RESPONSE,
    claim_token: CLAIM,
    question_id: QUESTION,
    attempt_id: ATTEMPT,
    connection_id: CONNECTION,
    session_id: SESSION,
    started_at: '2026-08-26T16:00:01.000Z',
    inbox_offset_after: 512,
    ...overrides,
  }
}

function record(overrides = {}) {
  return {
    ...interactionAnswerRecord({
      connectionId: CONNECTION,
      sessionId: SESSION,
      event: event(),
      attemptId: ATTEMPT,
      disposition: DELIVERED,
    }),
    ...overrides,
  }
}

/** A HOME with one connection state file, as connect would have written it. */
function stateHome(state = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-interaction-'))
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${CONNECTION}.json`), JSON.stringify({
    enabled: true,
    connection_id: CONNECTION,
    session_id: SESSION,
    agent_name: 'Claude Code',
    local_id: LOCAL_ID,
    token: 'dvs_test_token',
    mcp_url: 'http://127.0.0.1:1/mcp',
    connection_capability: 'dvsc_hidden',
    ...state,
  }), { mode: 0o600 })
  return { home, dir }
}

/**
 * Async spawn, not spawnSync: the stub MCP server below lives in THIS process, and a
 * synchronous child would block the event loop that has to answer its requests.
 */
function run(script, args, { home, input = '', localId = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: {
        ...process.env,
        HOME: home,
        ...(localId ? { DEVSPEC_REMOTE_LOCAL_ID: localId } : {}),
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
    child.stdin.end(input)
  })
}

async function stubMcp(handler) {
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', async () => {
      const parsed = JSON.parse(body)
      requests.push({ parsed, capability: request.headers['x-devspec-connection-capability'] })
      const result = (await handler(parsed)) ?? { content: [{ type: 'text', text: '{"ok":true}' }] }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// Criterion 832d8e6c — advertise v1 only when the adapter is active.
describe('interaction event negotiation', () => {
  it('negotiates only with the capability both the claim and the continuation need', () => {
    const ready = { enabled: true, connection_id: CONNECTION, connection_capability: 'dvsc' }
    assert.equal(interactionEventsNegotiable(ready), true)
    assert.deepEqual(interactionNegotiationArguments(ready), { interaction_event_version: 1 })

    for (const unready of [
      null,
      {},
      { enabled: true, connection_id: CONNECTION },
      { enabled: true, connection_id: CONNECTION, connection_capability: '' },
      { enabled: false, connection_id: CONNECTION, connection_capability: 'dvsc' },
      { enabled: true, connection_id: 'not-a-uuid', connection_capability: 'dvsc' },
    ]) {
      assert.equal(interactionEventsNegotiable(unready), false)
      // Omitted, not falsified: an unaware poll neither wakes nor consumes an event.
      assert.deepEqual(interactionNegotiationArguments(unready), {})
    }
  })

  it('sends the negotiation and the capability header on the same poll, or neither', () => {
    const poll = source('hooks/scripts/devspec-remote-poll.mjs')
    assert.match(poll, /const negotiatesInteraction = Object\.keys\(interactionArgs\)\.length > 0/)
    assert.match(poll, /\.\.\.\(negotiatesInteraction \? \{ connectionCapability \} : \{\}\)/)
    assert.match(poll, /const ack = negotiatesInteraction \? pendingInteractionAck : null/)
  })
})

// Criterion 99792e2c — the exact connection and waiting workflow only.
describe('exact targeting', () => {
  it('accepts this connection and source session, and only those', () => {
    assert.equal(validateInteractionEvent(event(), {
      connectionId: CONNECTION, sessionId: SESSION,
    }).ok, true)

    const sibling = validateInteractionEvent(event({ origin_connection_id: SIBLING }), {
      connectionId: CONNECTION, sessionId: SESSION,
    })
    assert.equal(sibling.ok, false)
    assert.match(sibling.error, /exact connection/)

    const foreignSession = validateInteractionEvent(event({ source_session_id: OTHER_SESSION }), {
      connectionId: CONNECTION, sessionId: SESSION,
    })
    assert.equal(foreignSession.ok, false)
    assert.match(foreignSession.error, /source session/)

    // A replacement connection is a different connection: it inherits nothing.
    assert.equal(validateInteractionEvent(event(), {
      connectionId: SIBLING, sessionId: SESSION,
    }).ok, false)
  })

  it('rejects malformed and unsupported payloads before any effect', () => {
    const cases = [
      [{}, /exactly match/],
      [event({ version: 2 }), /version/],
      [event({ kind: 'devspec.owner_message' }), /kind/],
      [event({ response_kind: 'poll' }), /response_kind/],
      [event({ answer: '   ' }), /empty|bound/],
      [event({ answer: 'x'.repeat(201) }), /bound/],
      [event({ response_kind: 'multi_select', answer: [] }), /bounded array/],
      [event({ response_kind: 'multi_select', answer: ['a', 'a'] }), /distinct/],
      [event({ answered_at: 'yesterday' }), /answered_at/],
      [event({ claim_token: 'nope' }), /claim_token/],
      [{ ...event(), extra: true }, /exactly match/],
    ]
    for (const [candidate, pattern] of cases) {
      const result = validateInteractionEvent(candidate, {
        connectionId: CONNECTION, sessionId: SESSION,
      })
      assert.equal(result.ok, false, JSON.stringify(candidate).slice(0, 60))
      assert.match(result.error, pattern)
    }
    // A 4000-code-point text answer is the server's bound, not an error.
    assert.equal(validateInteractionEvent(
      event({ response_kind: 'text', answer: 'x'.repeat(4000) }),
      { connectionId: CONNECTION, sessionId: SESSION },
    ).ok, true)
  })

  it('never delivers an answer as a command, room message or authority', () => {
    const [answer, wake] = buildInteractionAnswerEvents(record(), { inboxFile: '/tmp/inbox' })
    assert.equal(answer.type, 'question_answer')
    assert.equal(answer.authoritative, false)
    assert.equal(answer.executable, false)
    assert.equal(answer.authority, 'mechanical_response_only')
    assert.equal(answer.authoritative_source, INTERACTION_EVENT_CONTRACT_URI)
    assert.match(answer.note, /not a command/)
    assert.match(answer.note, /devspec-question\.mjs" respond/)
    assert.equal(wake.type, 'wake')
    assert.equal(wake.reason, 'directed_question_answer')
    assert.equal(wake.executable, false)
    const encoded = JSON.stringify(buildInteractionAnswerEvents(record()))
    assert.doesNotMatch(encoded, /owner_message|playbook_run|canonical_control|project_scope/)
  })
})

// Criterion 09fcd309 — durable dedupe, and ACK after durable application.
describe('durable application and dedupe', () => {
  it('indexes only newline-terminated records', () => {
    const complete = JSON.stringify(record()) + '\n'
    assert.deepEqual([...scanPersistedInteractionEventIds(complete)], [EVENT])
    // A torn final line is not durable identity: the answer must be re-applied.
    assert.deepEqual([...scanPersistedInteractionEventIds(JSON.stringify(record()))], [])
    assert.deepEqual([...scanPersistedInteractionEventIds('')], [])
    assert.deepEqual([...scanPersistedInteractionEventIds('{bad json}\n')], [])
    // The poller's one-pass index carries it, so a restart recovers the same identity.
    assert.deepEqual([...scanPersistedInboxRecords(complete).interactionEventIds], [EVENT])
  })

  it('applies then acknowledges, and acknowledges a redelivery without re-applying', () => {
    const poll = source('hooks/scripts/devspec-remote-poll.mjs')
    // Dedupe is checked before the continuation start, so a redelivered event never
    // opens a second attempt.
    const apply = poll.slice(poll.indexOf('async function applyInteractionEvent'))
    const dedupe = apply.indexOf('persistedInbox.interactionEventIds.has')
    const start = apply.indexOf("name: 'report_pickup'")
    const persist = apply.indexOf('appendDurableRecord(connectionId, record)')
    const ack = apply.indexOf('pendingInteractionAck = {\n      event_id: event.event_id')
    assert.ok(dedupe > -1 && start > dedupe, 'dedupe must precede the continuation start')
    assert.ok(persist > start, 'persistence must follow the continuation start')
    assert.ok(ack > persist, 'the ACK must follow durable persistence')
  })

  it('releases an attempt it could not persist instead of holding the answer hostage', () => {
    const poll = source('hooks/scripts/devspec-remote-poll.mjs')
    assert.match(poll, /interaction_pre_persistence_failure: true/)
    assert.match(poll, /releaseUnappliedContinuation\(event, decision\.attemptId\)/)
  })

  it('applies only the start outcomes the contract permits', () => {
    assert.deepEqual(classifyContinuationStart({ outcome: 'started', attempt_id: ATTEMPT }), {
      action: 'apply', outcome: 'started', attemptId: ATTEMPT,
    })
    // Already applied or terminal: record it so redelivery is inert, never execute it.
    assert.equal(classifyContinuationStart({ outcome: 'already_acked' }).action, 'settle')
    assert.equal(classifyContinuationStart({ outcome: 'terminal_same_claim' }).action, 'settle')
    for (const outcome of [
      'blocked_by_activity', 'blocked_by_attachment', 'stale_generation',
      'recovery_requires_reclaim', 'source_session_unavailable',
    ]) {
      assert.equal(classifyContinuationStart({ outcome }).action, 'wait', outcome)
    }
    // Fails closed: an unknown or attempt-less outcome waits for redelivery.
    assert.equal(classifyContinuationStart({ outcome: 'invented' }).action, 'wait')
    assert.equal(classifyContinuationStart({ outcome: 'started' }).action, 'wait')
    assert.equal(classifyContinuationStart(null).action, 'wait')
  })

  it('drives the whole loop: negotiate, claim, start, persist, then acknowledge', async () => {
    let served = 0
    const stub = await stubMcp(async (parsed) => {
      const call = parsed.params ?? {}
      if (call.name === 'poll_connection') {
        served++
        const first = served === 1
        // Everything after the delivery is idle. Hold briefly so a stub that answers
        // instantly does not turn the poller's loop into a spin during the test.
        if (!first) await new Promise((resolve) => setTimeout(resolve, 150))
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(first
              ? {
                  connection_id: CONNECTION,
                  session_id: SESSION,
                  changed: true,
                  interaction_event_version: 1,
                  interaction_events: [event()],
                  commands: [],
                  owner_ambient: [],
                  room_context: [],
                  dispatches: [],
                }
              : {
                  connection_id: CONNECTION,
                  session_id: SESSION,
                  changed: false,
                  interaction_event_version: 1,
                  interaction_events: [],
                }),
          }],
        }
      }
      if (call.name === 'report_pickup') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ outcome: 'started', attempt_id: ATTEMPT, phase: 'working' }),
          }],
        }
      }
      return { content: [{ type: 'text', text: '{}' }] }
    })
    const { home, dir } = stateHome({ mcp_url: stub.url })
    const child = spawn(process.execPath, [POLL_SCRIPT, '--connection-id', CONNECTION], {
      env: { ...process.env, HOME: home },
    })
    child.stdout.resume()
    child.stderr.resume()
    try {
      const deadline = Date.now() + 15_000
      const ackedPolls = () => stub.requests.filter(
        (entry) => entry.parsed.params?.name === 'poll_connection' &&
          entry.parsed.params.arguments.interaction_event_ack,
      )
      while (ackedPolls().length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      const polls = stub.requests.filter((e) => e.parsed.params?.name === 'poll_connection')
      const pickups = stub.requests.filter((e) => e.parsed.params?.name === 'report_pickup')
      assert.equal(polls[0].parsed.params.arguments.interaction_event_version, 1)
      assert.equal(polls[0].capability, 'dvsc_hidden', 'the claim needs the capability header')
      assert.equal(pickups.length, 1, 'exactly one attempt per answer')
      assert.equal(pickups[0].capability, 'dvsc_hidden')
      assert.deepEqual(pickups[0].parsed.params.arguments, {
        connection_id: CONNECTION,
        interaction_event_version: 1,
        interaction_event_id: EVENT,
        interaction_response_id: RESPONSE,
        interaction_claim_token: CLAIM,
      })

      const acked = ackedPolls()
      assert.equal(acked.length >= 1, true, 'the answer must be acknowledged')
      assert.deepEqual(acked[0].parsed.params.arguments.interaction_event_ack, {
        event_id: EVENT,
        response_id: RESPONSE,
        claim_token: CLAIM,
      })

      // The ACK followed a durable record, and the continuation is on file for the
      // reply bridge and the Stop hook to find.
      const inbox = fs.readFileSync(path.join(dir, `${CONNECTION}.inbox.jsonl`), 'utf8')
      const written = inbox.trim().split('\n').map((line) => JSON.parse(line))
      assert.deepEqual(written.map((r) => r.type), [INTERACTION_ANSWER_RECORD_TYPE])
      assert.equal(written[0].disposition, DELIVERED)
      assert.equal(written[0].attempt_id, ATTEMPT)
      const state = JSON.parse(fs.readFileSync(path.join(dir, `${CONNECTION}.json`), 'utf8'))
      assert.equal(state.interaction_continuation.attempt_id, ATTEMPT)
      assert.equal(state.interaction_continuation.inbox_offset_after, inbox.length)
    } finally {
      child.kill('SIGKILL')
      await stub.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('acknowledges a redelivery after a crash without opening a second attempt', async () => {
    // The crash window: the record is durable, the ACK never went out. The server
    // redelivers with a FRESH claim token, and the host must settle it, not re-run it.
    const redelivered = event({ claim_token: '60000000-0000-4000-8000-0000000000ff' })
    const stub = await stubMcp(async (parsed) => {
      const call = parsed.params ?? {}
      if (call.name !== 'poll_connection') return { content: [{ type: 'text', text: '{}' }] }
      const acking = Boolean(call.arguments.interaction_event_ack)
      if (acking) await new Promise((resolve) => setTimeout(resolve, 150))
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            connection_id: CONNECTION,
            session_id: SESSION,
            changed: !acking,
            interaction_event_version: 1,
            interaction_events: acking ? [] : [redelivered],
            commands: [],
            owner_ambient: [],
            room_context: [],
            dispatches: [],
          }),
        }],
      }
    })
    const { home, dir } = stateHome({ mcp_url: stub.url })
    fs.writeFileSync(
      path.join(dir, `${CONNECTION}.inbox.jsonl`),
      JSON.stringify(record()) + '\n',
    )
    const child = spawn(process.execPath, [POLL_SCRIPT, '--connection-id', CONNECTION], {
      env: { ...process.env, HOME: home },
    })
    child.stdout.resume()
    child.stderr.resume()
    try {
      const deadline = Date.now() + 15_000
      const acks = () => stub.requests.filter(
        (entry) => entry.parsed.params?.arguments?.interaction_event_ack,
      )
      while (acks().length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.deepEqual(acks()[0].parsed.params.arguments.interaction_event_ack, {
        event_id: EVENT,
        response_id: RESPONSE,
        claim_token: redelivered.claim_token,
      })
      assert.equal(
        stub.requests.filter((e) => e.parsed.params?.name === 'report_pickup').length,
        0,
        'a redelivered answer must not open another attempt',
      )
      const inbox = fs.readFileSync(path.join(dir, `${CONNECTION}.inbox.jsonl`), 'utf8')
      assert.equal(inbox.trim().split('\n').length, 1, 'and must not be applied twice')
    } finally {
      child.kill('SIGKILL')
      await stub.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('wakes only on a delivered record for this connection', () => {
    assert.equal(validateInteractionAnswerRecord(record(), CONNECTION), true)
    for (const broken of [
      record({ connection_id: SIBLING }),
      record({ disposition: 'already_acknowledged' }),
      record({ disposition: 'terminal_generation' }),
      record({ disposition: 'invented' }),
      record({ attempt_id: null }),
      record({ authoritative_source: 'devspec://product/remote-ingress-contract' }),
      record({ interaction_event_version: 2 }),
      record({ event: event({ origin_connection_id: SIBLING }) }),
      record({ session_id: OTHER_SESSION }),
      record({ type: 'canonical_commands' }),
    ]) {
      assert.equal(validateInteractionAnswerRecord(broken, CONNECTION), false,
        JSON.stringify(broken).slice(0, 80))
    }
  })

  it('counts a delivered answer as unread work, and a settled one as nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-unread-'))
    try {
      const inbox = path.join(dir, `${CONNECTION}.inbox.jsonl`)
      fs.writeFileSync(inbox, JSON.stringify(record()) + '\n' +
        JSON.stringify(record({ disposition: 'already_acknowledged' })) + '\n')
      assert.equal(countUnconsumedCommands(CONNECTION, 0, dir), 1)
      assert.equal(countUnreadOwnerCommands(CONNECTION, 0, dir), 1)
      assert.equal(countUnconsumedCommands(CONNECTION, fs.statSync(inbox).size, dir), 0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// Criterion d28b9981 — detach/reattach and revival pass; siblings fail closed.
describe('continuation identity across attachment changes', () => {
  it('survives a detached moment and a same-row reattach', () => {
    assert.deepEqual(activeContinuation(continuation(), {
      connectionId: CONNECTION, sessionId: SESSION,
    }), continuation())
    // Detached: still held, so a reattach to the same session resumes it.
    assert.deepEqual(activeContinuation(continuation(), {
      connectionId: CONNECTION, sessionId: null,
    }), continuation())
  })

  it('fails closed for another session, another connection, or a malformed record', () => {
    assert.equal(activeContinuation(continuation(), {
      connectionId: CONNECTION, sessionId: OTHER_SESSION,
    }), null)
    assert.equal(activeContinuation(continuation(), {
      connectionId: SIBLING, sessionId: SESSION,
    }), null)
    assert.equal(activeContinuation(continuation({ attempt_id: 'nope' }), {
      connectionId: CONNECTION, sessionId: SESSION,
    }), null)
    assert.equal(activeContinuation(null, { connectionId: CONNECTION, sessionId: SESSION }), null)
  })

  it('drops the stored continuation when the connection reattaches elsewhere', () => {
    const poll = source('hooks/scripts/devspec-remote-poll.mjs')
    assert.match(poll, /liveState\.interaction_continuation\.session_id !== sessionId/)
    assert.match(poll, /patchState\(\{ interaction_continuation: null \}\)/)
  })

  it('lets only the exact writer touch an open interaction attempt', () => {
    const held = continuation()
    assert.deepEqual(interactionActivityPlan({ verb: 'keepalive', continuation: held }),
      { kind: 'exact_keepalive' })
    // pickup/complete from the generic turn path is the empty-bubble failure mode.
    assert.equal(interactionActivityPlan({ verb: 'pickup', continuation: held }).kind, 'suppress')
    assert.equal(interactionActivityPlan({ verb: 'complete', continuation: held }).kind, 'suppress')
    // With nothing open, the ordinary turn verbs are unchanged.
    assert.deepEqual(interactionActivityPlan({ verb: 'pickup', continuation: null }),
      { kind: 'generic', verb: 'pickup' })
  })

  it('holds completion until the answer has actually reached the model', () => {
    assert.equal(continuationDelivered(continuation(), 511), false)
    assert.equal(continuationDelivered(continuation(), 512), true)
    assert.equal(continuationDelivered(continuation({ inbox_offset_after: null }), 9_999), false)
    assert.equal(stopInteractionDecision({ continuation: null }).action, 'none')
    assert.equal(stopInteractionDecision({
      continuation: continuation(), inboxByteOffset: 10,
    }).action, 'hold')
    assert.equal(stopInteractionDecision({
      continuation: continuation(), inboxByteOffset: 600,
    }).action, 'complete')
  })
})

describe('answer rendering', () => {
  it('summarises every response kind without losing the verbatim answer', () => {
    assert.equal(answerSummary(event({ response_kind: 'text', answer: 'do the second one' })),
      'do the second one')
    assert.equal(answerSummary(event()), 'Feature works correctly')
    assert.equal(answerSummary(event({ response_kind: 'multi_select', answer: ['a', 'b'] })), 'a, b')
    const [delivered] = buildInteractionAnswerEvents(
      record({ event: event({ response_kind: 'multi_select', answer: ['a', 'b'] }) }),
    )
    assert.deepEqual(delivered.answer, ['a', 'b'])
    assert.equal(delivered.answer_summary, 'a, b')
  })

  it('names the exact identity every continuation operation is bound to', () => {
    assert.deepEqual(continuationIdentity(event()), {
      interaction_event_id: EVENT,
      interaction_response_id: RESPONSE,
      interaction_claim_token: CLAIM,
    })
  })
})

// Criterion ba71cba2 — the wake stream and the reply bridge, driven for real.
describe('wake stream delivery', () => {
  it('streams one answer to the monitor and advances its cursor', () => {
    const { home, dir } = stateHome({ inbox_byte_offset: 0 })
    try {
      const inbox = path.join(dir, `${CONNECTION}.inbox.jsonl`)
      fs.writeFileSync(inbox, JSON.stringify(record()) + '\n')
      const child = spawnSync(process.execPath, [
        WAIT_SCRIPT, '--connection-id', CONNECTION, '--pending',
      ], { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 20_000 })
      assert.equal(child.status, 0, child.stderr)
      const events = child.stdout.trim().split('\n').map((line) => JSON.parse(line))
      assert.deepEqual(events.map((e) => e.type), ['question_answer', 'wake'])
      assert.equal(events[0].question_id, QUESTION)
      assert.equal(events[0].answer, 'Feature works correctly')
      assert.equal(events[0].session_id, SESSION)
      const state = JSON.parse(fs.readFileSync(path.join(dir, `${CONNECTION}.json`), 'utf8'))
      assert.equal(state.inbox_byte_offset, fs.statSync(inbox).size)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('drops a sibling or non-delivered record without waking anyone', () => {
    const lines = [
      JSON.stringify(record({ connection_id: SIBLING })),
      JSON.stringify(record({ event: event({ origin_connection_id: SIBLING }) })),
      JSON.stringify(record({ disposition: 'terminal_generation' })),
    ]
    assert.deepEqual(parseInboxBatches(lines, CONNECTION), [])
    assert.deepEqual(
      parseInboxBatches([JSON.stringify(record())], CONNECTION).map((r) => r.type),
      [INTERACTION_ANSWER_RECORD_TYPE],
    )
  })
})

describe('question bridge', () => {
  it('needs an attached, enabled, capability-bearing connection', () => {
    const { home, dir } = stateHome()
    try {
      const state = readQuestionConnectionState(CONNECTION, dir)
      assert.deepEqual(questionRequestOptions(state), {
        mcpUrl: state.mcp_url,
        token: state.token,
        connectionCapability: state.connection_capability,
        timeoutMs: 30_000,
      })
      const statePath = path.join(dir, `${CONNECTION}.json`)
      fs.writeFileSync(statePath, JSON.stringify({ ...state, session_id: null }))
      assert.throws(() => readQuestionConnectionState(CONNECTION, dir), /nobody to ask/)
      fs.writeFileSync(statePath, JSON.stringify({ ...state, connection_capability: null }))
      assert.throws(() => readQuestionConnectionState(CONNECTION, dir), /question capability/)
      fs.writeFileSync(statePath, JSON.stringify({ ...state, enabled: false }))
      assert.throws(() => readQuestionConnectionState(CONNECTION, dir), /disabled/)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('guards the question payload the way the server does', () => {
    const create = {
      action: 'create',
      client_request_id: EVENT,
      response_kind: 'single_select',
      prompt: 'Which one?',
      options: ['A', 'B'],
      allow_custom: true,
    }
    assert.equal(validateDirectedQuestionArguments(create).ok, true)
    assert.equal(validateDirectedQuestionArguments({ ...create, client_request_id: 'x' }).ok, false)
    assert.equal(validateDirectedQuestionArguments({ ...create, options: ['A'] }).ok, false)
    assert.equal(validateDirectedQuestionArguments({ ...create, options: ['A', 'A'] }).ok, false)
    assert.equal(validateDirectedQuestionArguments({ ...create, prompt: '  ' }).ok, false)
    assert.equal(validateDirectedQuestionArguments({
      action: 'create', client_request_id: EVENT, response_kind: 'text', prompt: 'Why?',
    }).ok, true)
    assert.equal(validateDirectedQuestionArguments({
      action: 'create', client_request_id: EVENT, response_kind: 'text', prompt: 'Why?',
      options: ['A', 'B'],
    }).ok, false)
    assert.equal(validateDirectedQuestionArguments({ action: 'list' }).ok, true)
    assert.equal(validateDirectedQuestionArguments({ action: 'get', question_id: QUESTION }).ok, true)
    assert.equal(validateDirectedQuestionArguments({ action: 'cancel', question_id: QUESTION }).ok, false)
    assert.equal(validateDirectedQuestionArguments({
      action: 'cancel', question_id: QUESTION, expected_revision: 2,
    }).ok, true)
    // Caller identity is never an argument here.
    for (const forged of ['connection_id', 'origin_connection_id', 'responder_user_id', 'token']) {
      assert.equal(validateDirectedQuestionArguments({ action: 'list', [forged]: 'x' }).ok, false)
    }
  })

  it('completes the exact attempt in the same request as the reply', async () => {
    const stub = await stubMcp(() => ({
      content: [{ type: 'text', text: JSON.stringify({ posted: true }) }],
    }))
    const { home, dir } = stateHome({
      mcp_url: stub.url,
      interaction_continuation: continuation(),
    })
    try {
      const child = await run(QUESTION_SCRIPT, [
        'respond', '--connection-id', CONNECTION, '--message', 'Answer received.',
      ], { home })
      assert.equal(child.status, 0, child.stderr)
      assert.equal(stub.requests.length, 1)
      assert.equal(stub.requests[0].capability, 'dvsc_hidden')
      const call = stub.requests[0].parsed.params
      assert.equal(call.name, 'post_session_message')
      assert.deepEqual(call.arguments, {
        connection_id: CONNECTION,
        message: 'Answer received.',
        agent_name: 'Claude Code',
        attempt_id: ATTEMPT,
        command_turn_unbound: true,
        complete_turn: true,
        interaction_event_id: EVENT,
        interaction_response_id: RESPONSE,
        interaction_claim_token: CLAIM,
      })
      // Resolved: Stop must not then complete an attempt that is already done.
      const state = JSON.parse(fs.readFileSync(path.join(dir, `${CONNECTION}.json`), 'utf8'))
      assert.equal(state.interaction_continuation, null)
      assert.equal(state.token, 'dvs_test_token', 'clearing must not drop other fields')
    } finally {
      await stub.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('refuses to respond when nothing is waiting, and reports what is', async () => {
    const { home } = stateHome()
    try {
      const refused = spawnSync(process.execPath, [
        QUESTION_SCRIPT, 'respond', '--connection-id', CONNECTION, '--message', 'hi',
      ], { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 20_000 })
      assert.equal(refused.status, 1)
      assert.match(refused.stderr, /no answered question is waiting/)

      const status = spawnSync(process.execPath, [
        QUESTION_SCRIPT, 'status', '--connection-id', CONNECTION,
      ], { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 20_000 })
      assert.equal(status.status, 0, status.stderr)
      const parsed = JSON.parse(status.stdout)
      assert.equal(parsed.awaiting_reply, false)
      assert.equal(parsed.question_id, null)
      assert.doesNotMatch(status.stdout, /dvs_test_token|dvsc_hidden/)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('clears a resolved continuation idempotently', () => {
    const { home, dir } = stateHome({ interaction_continuation: continuation() })
    try {
      clearStoredContinuation(CONNECTION, dir)
      clearStoredContinuation(CONNECTION, dir)
      const state = JSON.parse(fs.readFileSync(path.join(dir, `${CONNECTION}.json`), 'utf8'))
      assert.equal(state.interaction_continuation, null)
      assert.equal(state.connection_id, CONNECTION)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('turn end', () => {
  async function runStop(stateOverrides) {
    const stub = await stubMcp(() => ({ content: [{ type: 'text', text: '{"ok":true}' }] }))
    const { home, dir } = stateHome({ mcp_url: stub.url, ...stateOverrides })
    try {
      const child = await run(MIRROR_SCRIPT, ['stop'], {
        home,
        localId: LOCAL_ID,
        input: JSON.stringify({ session_id: LOCAL_ID, stop_hook_active: true }),
      })
      assert.equal(child.status, 0, child.stderr)
      const calls = stub.requests.map((entry) => entry.parsed.params)
      const state = JSON.parse(fs.readFileSync(path.join(dir, `${CONNECTION}.json`), 'utf8'))
      return { calls, state, requests: stub.requests }
    } finally {
      await stub.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  }

  it('completes an open continuation through its own claim generation', async () => {
    const { calls, requests, state } = await runStop({
      interaction_continuation: continuation({ inbox_offset_after: 10 }),
      inbox_byte_offset: 10,
    })
    const complete = calls.find((call) => call.name === 'report_complete')
    assert.deepEqual(complete.arguments, {
      connection_id: CONNECTION,
      attempt_id: ATTEMPT,
      reason: 'turn_end',
      interaction_event_id: EVENT,
      interaction_response_id: RESPONSE,
      interaction_claim_token: CLAIM,
    })
    const completeRequest = requests.find(
      (entry) => entry.parsed.params.name === 'report_complete',
    )
    assert.equal(completeRequest.capability, 'dvsc_hidden')
    assert.equal(state.interaction_continuation, null)
  })

  it('never generically completes an attempt it does not own', async () => {
    // Answer still in flight (the cursor has not reached the record): completing now
    // would close the attempt before the model ever saw the answer.
    const { calls, state } = await runStop({
      interaction_continuation: continuation({ inbox_offset_after: 900 }),
      inbox_byte_offset: 10,
    })
    assert.equal(calls.some((call) => call.name === 'report_complete'), false)
    assert.ok(state.interaction_continuation, 'the continuation must survive to its own turn')
  })

  it('leaves ordinary turn ends exactly as they were', async () => {
    const { calls } = await runStop({})
    const complete = calls.find((call) => call.name === 'report_complete')
    assert.deepEqual(complete.arguments, { connection_id: CONNECTION, reason: 'turn_end' })
  })
})

describe('directed-question policy surfaces', () => {
  const skill = source('skills/devspec-directed-question/SKILL.md')
  const remote = source('commands/devspec.remote.md')

  it('teaches asking one person and finishing the turn their answer opens', () => {
    assert.match(skill, /devspec-question\.mjs" describe/)
    assert.match(skill, /devspec-question\.mjs" respond/)
    assert.match(skill, /client_request_id/)
    assert.match(skill, /single_select|multi_select/)
    // The command points at the skill; the skill owns the bridge invocation, so the
    // idle command never carries a script path that can drift.
    assert.match(remote, /`devspec-directed-question` skill/)
    assert.doesNotMatch(remote, /devspec-question\.mjs/)
    assert.match(remote, /never a way to hand judgement work back/)
  })

  it('points at the served contract instead of restating server authority', () => {
    assert.match(skill, /devspec:\/\/product\/interaction-event-contract/)
    // A question is never a way to hand work back: that rule is the owner's, and it
    // is the one thing this feature could quietly undermine.
    assert.match(skill, /decision that is genuinely theirs/)
    assert.doesNotMatch(skill, /dvsc_|connection_capability:/)
  })

  it('keeps the on-demand skill small enough to load without thinking about it', () => {
    assert.ok(Buffer.byteLength(skill) < 3_600, `skill is ${Buffer.byteLength(skill)} bytes`)
  })
})
