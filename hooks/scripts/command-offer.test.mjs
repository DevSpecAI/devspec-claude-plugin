#!/usr/bin/env node
/**
 * The command handoff rules (item a11d27fa). Run:
 *   node --test hooks/scripts/command-offer.test.mjs
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  COMMAND_OFFER_VERSION,
  QUESTION_HANDOFF_EVENT,
  commandHandoffDecision,
  commandHandoffKey,
  commandOfferArguments,
  commandOfferNegotiable,
  parseCommandOfferResponse,
  questionHandoffEvent,
  validQuestionHandoff,
} from './command-offer.mjs'
import { appendCanonicalInbox, scanPersistedInboxRecords } from './devspec-remote-poll.mjs'

const CONNECTION = '10000000-0000-4000-8000-000000000001'
const ROOM = '20000000-0000-4000-8000-000000000002'
const ATTACHMENT = '30000000-0000-4000-8000-000000000003'
const MESSAGE = '40000000-0000-4000-8000-000000000004'
const ATTEMPT = '50000000-0000-4000-8000-000000000005'
const EVENT = '60000000-0000-4000-8000-000000000006'
const RESPONSE = '70000000-0000-4000-8000-000000000007'
const CLAIM = '80000000-0000-4000-8000-000000000008'
const QUESTION = '90000000-0000-4000-8000-000000000009'
const OTHER = 'a0000000-0000-4000-8000-00000000000a'
const scope = { connectionId: CONNECTION, sessionId: ROOM, attachmentId: ATTACHMENT }

function offer(overrides = {}) {
  return {
    version: 1,
    connection_id: CONNECTION,
    source_session_id: ROOM,
    attachment_id: ATTACHMENT,
    source_message_id: MESSAGE,
    blocking_attempt_id: ATTEMPT,
    attachments: [],
    ...overrides,
  }
}

function response(commandOffer = offer(), stale = false) {
  return { command_offer_version: 1, command_offer: commandOffer, command_handoff_stale: stale }
}

function continuation(overrides = {}) {
  return {
    event_id: EVENT,
    response_id: RESPONSE,
    claim_token: CLAIM,
    question_id: QUESTION,
    attempt_id: ATTEMPT,
    connection_id: CONNECTION,
    session_id: ROOM,
    started_at: '2026-09-25T15:00:00.000Z',
    inbox_offset_after: 1200,
    ...overrides,
  }
}

describe('negotiation', () => {
  it('asks for offers only on a live poll that can carry the exact capability', () => {
    const live = { connectionCapability: 'cap', sessionId: ROOM, attachmentId: ATTACHMENT, catchUp: false }
    assert.equal(commandOfferNegotiable(live), true)
    // The server refuses the version without the capability, which would fail the poll.
    assert.equal(commandOfferNegotiable({ ...live, connectionCapability: null }), false)
    assert.equal(commandOfferNegotiable({ ...live, sessionId: null }), false)
    assert.equal(commandOfferNegotiable({ ...live, attachmentId: null }), false)
    // A catch-up page never computes an offer.
    assert.equal(commandOfferNegotiable({ ...live, catchUp: true }), false)
  })

  it('carries a readiness only beside the version it belongs to', () => {
    const ready = { source_message_id: MESSAGE }
    assert.deepEqual(commandOfferArguments({ negotiable: false, ready }), {})
    assert.deepEqual(commandOfferArguments({ negotiable: true }), { command_offer_version: COMMAND_OFFER_VERSION })
    assert.deepEqual(commandOfferArguments({ negotiable: true, ready }), { command_offer_version: 1, command_handoff_ready: ready })
  })
})

describe('the offer sidecar', () => {
  it('is absent on a server that does not offer: the legacy lane is untouched', () => {
    assert.deepEqual(parseCommandOfferResponse({ changed: true }, scope), { supported: false, stale: false, offer: null })
  })

  it('reads a null offer and the stale flag', () => {
    assert.deepEqual(parseCommandOfferResponse(response(null, true), scope), { supported: true, stale: true, offer: null })
  })

  it('accepts an exact offer for this connection, room and attachment', () => {
    assert.deepEqual(parseCommandOfferResponse(response(), scope).offer, offer())
  })

  it('refuses one aimed at another connection, room or attachment generation', () => {
    for (const bent of [{ connection_id: OTHER }, { source_session_id: OTHER }, { attachment_id: OTHER }]) {
      assert.throws(() => parseCommandOfferResponse(response(offer(bent)), scope), /not for this connection/)
    }
  })

  it('refuses extra fields, a body sneaking in included', () => {
    assert.throws(() => parseCommandOfferResponse(response({ ...offer(), body: 'do this' }), scope), /fields/)
    const missing = offer()
    delete missing.attachments
    assert.throws(() => parseCommandOfferResponse(response(missing), scope), /fields/)
  })

  it('refuses a bad identity, version or attachment manifest', () => {
    assert.throws(() => parseCommandOfferResponse(response(offer({ blocking_attempt_id: 'nope' })), scope), /UUID/)
    assert.throws(() => parseCommandOfferResponse({ ...response(), command_offer_version: 2 }, scope), /unsupported/)
    assert.throws(() => parseCommandOfferResponse({ ...response(), command_handoff_stale: 'no' }, scope), /unsupported/)
    assert.throws(() => parseCommandOfferResponse(response(offer({ attachments: [{ filename: 'x' }] })), scope), /attachments/)
  })

  it('accepts a canonical metadata attachment', () => {
    const attachments = [{ materialization: 'metadata', filename: 'a.png', mime_type: 'image/png', type: 'image', size_bytes: 10, resource_id: OTHER }]
    assert.deepEqual(parseCommandOfferResponse(response(offer({ attachments })), scope).offer.attachments, attachments)
  })
})

describe('deciding the handoff', () => {
  const settled = { continuation: continuation(), ackPending: false, inboxByteOffset: 1200 }

  it('is ready once the answer is acknowledged and has reached the model', () => {
    const decision = commandHandoffDecision({ offer: offer(), ...settled })
    assert.equal(decision.action, 'ready')
    assert.deepEqual(decision.ready, {
      source_message_id: MESSAGE,
      attempt_id: ATTEMPT,
      attachment_id: ATTACHMENT,
      interaction_event_id: EVENT,
      interaction_response_id: RESPONSE,
      interaction_claim_token: CLAIM,
    })
  })

  it('names a dismissal by its own identity', () => {
    const dismissal = continuation({ kind: 'devspec.question_dismissal_event' })
    delete dismissal.response_id
    const decision = commandHandoffDecision({ offer: offer(), ...settled, continuation: dismissal })
    assert.deepEqual(decision.ready, {
      source_message_id: MESSAGE,
      attempt_id: ATTEMPT,
      attachment_id: ATTACHMENT,
      question_dismissal_event_id: EVENT,
      question_dismissal_question_id: QUESTION,
      question_dismissal_claim_token: CLAIM,
    })
  })

  it('waits while the ACK has not ridden a returned poll', () => {
    assert.equal(commandHandoffDecision({ offer: offer(), ...settled, ackPending: true }).action, 'wait')
  })

  it('waits while the answer is still on its way to the model', () => {
    assert.equal(commandHandoffDecision({ offer: offer(), ...settled, inboxByteOffset: 1199 }).action, 'wait')
    assert.equal(commandHandoffDecision({ offer: offer(), ...settled, inboxByteOffset: null }).action, 'wait')
  })

  it('ignores an offer blocked by a question this host does not hold', () => {
    assert.equal(commandHandoffDecision({ offer: offer(), ...settled, continuation: null }).action, 'ignore')
    assert.equal(commandHandoffDecision({ offer: offer({ blocking_attempt_id: OTHER }), ...settled }).action, 'ignore')
    assert.equal(commandHandoffDecision({ offer: offer(), ...settled, continuation: continuation({ session_id: OTHER }) }).action, 'ignore')
    assert.equal(commandHandoffDecision({ offer: null, ...settled }).action, 'ignore')
  })

  it('keys a readiness by message and question attempt', () => {
    assert.equal(commandHandoffKey({ source_message_id: MESSAGE, attempt_id: ATTEMPT }), `${MESSAGE}:${ATTEMPT}`)
    assert.equal(commandHandoffKey(null), null)
  })
})

describe('telling the model', () => {
  it('marks only the handed-over message on its inbox record', () => {
    const ingress = { envelope_id: 'env-1', commands: [{ message_id: MESSAGE }, { message_id: OTHER }] }
    let durable
    const appended = appendCanonicalInbox(CONNECTION, ingress, scanPersistedInboxRecords(''), {
      channel: 'command',
      questionHandoff: { question_id: QUESTION, source_message_id: MESSAGE },
      writeRecord: (_connection, record) => { durable = record; return true },
    })
    assert.equal(appended.handedOff, true)
    assert.deepEqual(durable.question_handoff, { question_id: QUESTION, source_message_id: MESSAGE })

    let plain
    const ordinary = appendCanonicalInbox(CONNECTION, { envelope_id: 'env-2', commands: [{ message_id: OTHER }] },
      scanPersistedInboxRecords(''), {
        channel: 'command',
        questionHandoff: { question_id: QUESTION, source_message_id: MESSAGE },
        writeRecord: (_connection, record) => { plain = record; return true },
      })
    assert.equal(ordinary.handedOff, false)
    assert.equal(Object.hasOwn(plain, 'question_handoff'), false)
  })

  it('revalidates the marker read back from the inbox', () => {
    const ids = new Set([MESSAGE])
    assert.deepEqual(validQuestionHandoff({ question_id: QUESTION, source_message_id: MESSAGE, extra: 1 }, ids),
      { question_id: QUESTION, source_message_id: MESSAGE })
    assert.equal(validQuestionHandoff({ question_id: QUESTION, source_message_id: OTHER }, ids), null)
    assert.equal(validQuestionHandoff({ question_id: 'q', source_message_id: MESSAGE }, ids), null)
    assert.equal(validQuestionHandoff(null, ids), null)
  })

  it('says the question channel is closed, within the host line cap', () => {
    const event = questionHandoffEvent({ question_id: QUESTION, source_message_id: MESSAGE }, { sessionId: ROOM })
    assert.equal(event.type, QUESTION_HANDOFF_EVENT)
    assert.equal(event.executable, false)
    assert.match(event.note, /do not use devspec-question respond/)
    assert.match(event.note, /post_session_message/)
    assert.ok(JSON.stringify(event).length < 500, `${JSON.stringify(event).length} characters`)
  })
})
