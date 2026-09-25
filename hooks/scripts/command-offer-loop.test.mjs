#!/usr/bin/env node
/**
 * The real poller against a stub server, through a whole command handoff (item
 * a11d27fa): an answer is applied and acknowledged, a message arrives held behind it,
 * and the very next poll hands the question's turn over so the message is delivered.
 * Run: node --test hooks/scripts/command-offer-loop.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  REMOTE_INGRESS_ROOM_CONTEXT_CONTRACT_VERSION,
  REMOTE_INGRESS_ROOM_CONTEXT_POLICY_VERSION,
} from './remote-ingress-v1.mjs'
import { buildCanonicalCommandEvents, parseInboxBatches } from './devspec-remote-wait.mjs'

const POLL_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'devspec-remote-poll.mjs')

const CONNECTION = '10000000-0000-4000-8000-000000000001'
const SESSION = '20000000-0000-4000-8000-000000000002'
const EVENT = '30000000-0000-4000-8000-000000000003'
const RESPONSE = '40000000-0000-4000-8000-000000000004'
const QUESTION = '50000000-0000-4000-8000-000000000005'
const CLAIM = '60000000-0000-4000-8000-000000000006'
const ATTEMPT = '70000000-0000-4000-8000-000000000007'
const LOCAL_ID = '80000000-0000-4000-8000-000000000008'
const ATTACHMENT = '90000000-0000-4000-8000-000000000009'
const OWNER = 'a0000000-0000-4000-8000-00000000000a'
const LABEL = 'Claude Code · Careful Moth'

const id = (n) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const order = (n) => ({ sequence: n, created_at: new Date(Date.UTC(2026, 8, 25, 15, 0, n)).toISOString(), message_id: id(n) })
const HELD = id(9)

function answerEvent() {
  return {
    kind: 'devspec.interaction_event', version: 1, event_id: EVENT, response_id: RESPONSE,
    question_id: QUESTION, origin_connection_id: CONNECTION, source_session_id: SESSION,
    response_kind: 'single_select', answer: 'Ship it', answered_at: '2026-09-25T15:00:00.000Z',
    claim_token: CLAIM, lease_expires_at: '2026-09-25T15:00:30.000Z',
  }
}

function command(n) {
  return {
    message_id: id(n),
    order: order(n),
    content: { mode: 'full', body: 'also check the logs', complete: true },
    attachments: [],
    requester: { user_id: OWNER, display_name: 'Ali Price' },
    authority: { kind: 'owner', mode: 'owner', requested_by_user_id: OWNER, connection_owner_user_id: OWNER, decision_source: 'server' },
    project_scope: null,
    addressee: { connection_id: CONNECTION, agent_name: 'Claude Code', codename: 'Careful Moth', label: LABEL },
    delivery: {
      provenance_ref: 'c0000000-0000-4000-8000-00000000000c',
      turn_id: 'd0000000-0000-4000-8000-00000000000d',
      primary_provenance_ref: 'c0000000-0000-4000-8000-00000000000c',
      is_primary: true,
    },
  }
}

/**
 * What the server sends while it holds a message back: the page is marked as retried,
 * and its next_cursor continues the live read FORWARDS. Taken as a history cursor it
 * is refused on every poll after, which wedged the poller before 0.32.5.
 */
const HELD_WINDOW = {
  truncated: true,
  has_more: true,
  next_cursor: 'after:held-page',
  omission_reason: 'delivery_retry',
  // As the live server sends it: the window spans the held message, none returned.
  fetch_id: `session:${SESSION}:messages`,
  source_window: { start: order(9), end: order(9) },
}

/** A legal 1.6.0 page: the held message as a live command, or a quiet room update. */
function page(envelopeId, commands, windowOverrides = {}) {
  const live = commands.length > 0
  const rows = live ? commands : []
  return {
    kind: 'devspec.remote_ingress',
    schema_version: 1,
    contract_version: REMOTE_INGRESS_ROOM_CONTEXT_CONTRACT_VERSION,
    policy_version: REMOTE_INGRESS_ROOM_CONTEXT_POLICY_VERSION,
    envelope_id: envelopeId,
    connection: { connection_id: CONNECTION, agent_name: 'Claude Code', codename: 'Careful Moth', label: LABEL },
    wake: live
      ? { kind: 'conversational_command', active: true, reason_id: 'command_available' }
      : { kind: 'advisory_update', active: false, reason_id: 'advisory_context_changed' },
    delivery_state: 'live',
    command_message_ids: commands.map((c) => c.message_id),
    commands,
    control: null,
    context: { human_context: [], agent_context: [], ai_context: [], system_context: [] },
    system_notices: [],
    room_context: {
      version: 1,
      messages: rows.map((row) => ({
        message_id: row.message_id,
        addressee: { kind: 'connection', connection_id: CONNECTION, label: LABEL },
        attachments: [],
        state: 'final',
      })),
      coverage: null,
    },
    window: {
      policy_version: REMOTE_INGRESS_ROOM_CONTEXT_POLICY_VERSION,
      returned: rows.length,
      total_known: null,
      source_window: { start: rows[0]?.order ?? null, end: rows.at(-1)?.order ?? null },
      truncated: false,
      has_more: false,
      next_cursor: null,
      fetch_id: null,
      omission_reason: null,
      ...windowOverrides,
    },
  }
}

function offer() {
  return {
    version: 1, connection_id: CONNECTION, source_session_id: SESSION, attachment_id: ATTACHMENT,
    source_message_id: HELD, blocking_attempt_id: ATTEMPT, attachments: [],
  }
}

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const base = { connection_id: CONNECTION, session_id: SESSION, speech_attachment_id: ATTACHMENT }
const until = async (condition, ms = 15_000) => {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  return condition()
}

/**
 * The server's side, as migration 985 behaves: while the answer holds the connection,
 * a message is only ever OFFERED, and only to a poll that negotiated offers; a poll
 * carrying the readiness gets the message delivered. `deliverOnReady:false` is a server
 * that refuses the readiness (its answer not yet recorded as applied, say).
 */
async function stubServer({ question = true, deliverOnReady = true } = {}) {
  const requests = []
  const world = { answerServed: !question, held: false, delivered: false }
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', async () => {
      const parsed = JSON.parse(body)
      const call = parsed.params ?? {}
      const args = call.arguments ?? {}
      requests.push({ name: call.name, args, capability: request.headers['x-devspec-connection-capability'] })
      let result = text({})
      if (call.name === 'report_pickup') result = text({ outcome: 'started', attempt_id: ATTEMPT, phase: 'working' })
      if (call.name === 'poll_connection' && args.catch_up_cursor && !String(args.catch_up_cursor).startsWith('before:')) {
        // The server's own refusal (tool-executors: a catch-up cursor must read backwards).
        result = { isError: true, content: [{ type: 'text', text: 'catch_up_cursor has the wrong direction.' }] }
      } else if (call.name === 'poll_connection') {
        const offers = args.command_offer_version === 1
          ? { command_offer_version: 1, command_offer: null, command_handoff_stale: false }
          : {}
        if (!world.answerServed) {
          world.answerServed = true
          result = text({ ...base, changed: true, interaction_event_version: 1, interaction_events: [answerEvent()] })
        } else if (world.held && !world.delivered && (!question || (args.command_handoff_ready && deliverOnReady))) {
          world.delivered = true
          result = text({ ...base, ...offers, changed: true, ingress: page('e0000000-0000-4000-8000-000000000002', [command(9)]), dispatches: [] })
        } else if (world.held && !world.delivered && (question || offers.command_offer_version)) {
          // Held behind the question: offered to a poll that negotiated offers, and on a
          // retried page either way, exactly as the server holds it.
          result = text({
            ...base,
            ...offers,
            ...(offers.command_offer_version ? { command_offer: offer() } : {}),
            changed: true,
            ingress: page('e0000000-0000-4000-8000-000000000001', [], HELD_WINDOW),
            dispatches: [],
          })
        } else {
          await new Promise((resolve) => setTimeout(resolve, 150))
          result = text({ ...base, ...offers, changed: false, interaction_event_version: 1, interaction_events: [] })
        }
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    requests,
    world,
    polls: () => requests.filter((entry) => entry.name === 'poll_connection'),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function startPoller(stub, extraState = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-handoff-'))
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${CONNECTION}.json`), JSON.stringify({
    enabled: true, connection_id: CONNECTION, session_id: SESSION, agent_name: 'Claude Code',
    local_id: LOCAL_ID, token: 'dvs_test_token', mcp_url: stub.url, connection_capability: 'dvsc_hidden',
    // The wait stream has flushed everything written so far: the answer reaches the
    // model as soon as it lands. The not-yet-flushed case is a unit test.
    inbox_byte_offset: 1_000_000_000,
    ...extraState,
  }), { mode: 0o600 })
  const child = spawn(process.execPath, [POLL_SCRIPT, '--connection-id', CONNECTION], { env: { ...process.env, HOME: home } })
  let stderr = ''
  child.stdout.resume()
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const read = (name) => {
    try { return fs.readFileSync(path.join(dir, name), 'utf8') } catch { return '' }
  }
  return {
    state: () => JSON.parse(read(`${CONNECTION}.json`) || '{}'),
    inbox: () => read(`${CONNECTION}.inbox.jsonl`).split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    turnMarked: () => fs.readdirSync(dir).some((name) => name.startsWith(CONNECTION) && /turn/.test(name)),
    stderr: () => stderr,
    stop: () => { child.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }) },
  }
}

describe('a message sent while Claude works on an answer (item a11d27fa)', () => {
  it('is handed the question\'s turn on the very next poll, and delivered once', async () => {
    const stub = await stubServer()
    const poller = startPoller(stub)
    try {
      assert.ok(await until(() => stub.polls().some((p) => p.args.interaction_event_ack)), 'the answer was acknowledged')
      assert.equal(poller.state().interaction_continuation?.attempt_id, ATTEMPT)

      stub.world.held = true
      assert.ok(await until(() => poller.inbox().some((r) => r.type === 'canonical_commands')), poller.stderr())
      const polls = stub.polls()
      const firstOffer = polls.findIndex((p) => p.args.command_offer_version === 1 && stub.world.held)
      const ready = polls.filter((p) => p.args.command_handoff_ready)
      assert.equal(ready.length, 1, 'one readiness')
      assert.deepEqual(ready[0].args.command_handoff_ready, {
        source_message_id: HELD,
        attempt_id: ATTEMPT,
        attachment_id: ATTACHMENT,
        interaction_event_id: EVENT,
        interaction_response_id: RESPONSE,
        interaction_claim_token: CLAIM,
      })
      assert.equal(ready[0].capability, 'dvsc_hidden')
      assert.equal(ready[0].args.interaction_event_ack, undefined, 'never beside an ACK')
      // Within one poll cycle: the poll after the one that carried the offer.
      const offerPoll = polls.findIndex((p, index) => index >= firstOffer && !p.args.command_handoff_ready &&
        polls[index + 1]?.args.command_handoff_ready)
      assert.ok(offerPoll >= 0, 'the readiness went out on the poll straight after the offer')

      // The answer was applied once, the message delivered once, and the question's
      // turn is no longer this host's to keep alive.
      assert.equal(stub.requests.filter((r) => r.name === 'report_pickup').length, 1)
      assert.equal(stub.polls().filter((p) => p.args.interaction_event_ack).length, 1)
      const commands = poller.inbox().filter((r) => r.type === 'canonical_commands')
      assert.equal(commands.length, 1)
      assert.deepEqual(commands[0].execute_message_ids, [HELD])
      assert.deepEqual(commands[0].question_handoff, { question_id: QUESTION, source_message_id: HELD })
      assert.ok(await until(() => poller.state().interaction_continuation === null))

      // What the model reads: the handover, then the message.
      const lines = poller.inbox().map((r) => JSON.stringify(r))
      const [batch] = parseInboxBatches(lines, CONNECTION).filter((r) => r.type === 'canonical_commands')
      assert.deepEqual(buildCanonicalCommandEvents(batch).map((e) => e.type), ['question_turn_handed_over', 'owner_message', 'wake'])
    } finally {
      poller.stop()
      await stub.close()
    }
  })

  it('retries a readiness the server did not act on with backoff, never in a spin', async () => {
    const stub = await stubServer({ deliverOnReady: false })
    const poller = startPoller(stub)
    try {
      assert.ok(await until(() => stub.polls().some((p) => p.args.interaction_event_ack)))
      stub.world.held = true
      assert.ok(await until(() => stub.polls().some((p) => p.args.command_handoff_ready)))
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      const ready = stub.polls().filter((p) => p.args.command_handoff_ready).length
      assert.ok(ready >= 1 && ready <= 4, `${ready} readiness polls in ~3s`)
      assert.equal(poller.inbox().some((r) => r.type === 'canonical_commands'), false, 'nothing is delivered on an offer')
      assert.equal(poller.state().interaction_continuation?.attempt_id, ATTEMPT, 'the question is still held')
    } finally {
      poller.stop()
      await stub.close()
    }
  })

  it('with no question open, delivers a message exactly as before', async () => {
    const stub = await stubServer({ question: false })
    const poller = startPoller(stub)
    try {
      assert.ok(await until(() => stub.polls().some((p) => p.args.command_offer_version === 1)), poller.stderr())
      stub.world.held = true
      assert.ok(await until(() => poller.inbox().some((r) => r.type === 'canonical_commands')), poller.stderr())
      assert.equal(stub.polls().some((p) => p.args.command_handoff_ready), false)
      const [record] = poller.inbox().filter((r) => r.type === 'canonical_commands')
      assert.equal(Object.hasOwn(record, 'question_handoff'), false)
      const [batch] = parseInboxBatches([JSON.stringify(record)], CONNECTION)
      assert.deepEqual(buildCanonicalCommandEvents(batch).map((e) => e.type), ['owner_message', 'wake'])
    } finally {
      poller.stop()
      await stub.close()
    }
  })

  it('recovers a poller an older version left wedged on a held page\'s cursor', async () => {
    // What a 0.32.4 poller persisted after one held page: the forward retry cursor,
    // filed as a history cursor. Every poll after was refused, so nothing arrived.
    const stub = await stubServer({ question: false })
    const poller = startPoller(stub, { catch_up_cursor: HELD_WINDOW.next_cursor })
    try {
      assert.ok(await until(() => stub.polls().some((p) => p.args.catch_up_cursor)), 'it first sends the wedged cursor')
      assert.ok(await until(() => poller.state().catch_up_cursor === null), poller.stderr())
      stub.world.held = true
      assert.ok(await until(() => poller.inbox().some((r) => r.type === 'canonical_commands')), poller.stderr())
      assert.equal(stub.polls().filter((p) => p.args.catch_up_cursor).length, 1, 'the refused cursor is dropped, not retried')
    } finally {
      poller.stop()
      await stub.close()
    }
  })
})
