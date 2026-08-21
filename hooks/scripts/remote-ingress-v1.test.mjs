#!/usr/bin/env node
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  normalizeRemoteIngressV1,
  renderAdvisoryContext,
  REMOTE_INGRESS_CONTRACT_VERSION,
  REMOTE_INGRESS_POLICY_VERSION,
} from './remote-ingress-v1.mjs'

const CONNECTION = '10000000-0000-4000-8000-000000000001'
const OWNER = '20000000-0000-4000-8000-000000000002'
const MESSAGE = '30000000-0000-4000-8000-000000000003'
const PROVENANCE = '40000000-0000-4000-8000-000000000004'
const TURN = '50000000-0000-4000-8000-000000000005'
const ENVELOPE = '60000000-0000-4000-8000-000000000006'
const RESOURCE = '70000000-0000-4000-8000-000000000007'

function order(messageId = MESSAGE, sequence = 1) {
  return { sequence, created_at: '2026-08-19T12:00:00.000Z', message_id: messageId }
}

function emptyContext() {
  return { human_context: [], agent_context: [], ai_context: [], system_context: [] }
}

function command(over = {}) {
  return {
    message_id: MESSAGE,
    order: order(),
    content: { mode: 'full', body: 'do the exact thing', complete: true },
    attachments: [],
    requester: { user_id: OWNER, display_name: 'Owner' },
    authority: {
      kind: 'owner',
      mode: 'owner',
      requested_by_user_id: OWNER,
      connection_owner_user_id: OWNER,
      decision_source: 'server',
    },
    addressee: {
      connection_id: CONNECTION,
      agent_name: 'Claude Code',
      codename: 'Careful Moth',
      label: 'Claude Code / Careful Moth',
    },
    delivery: {
      provenance_ref: PROVENANCE,
      turn_id: TURN,
      primary_provenance_ref: PROVENANCE,
      is_primary: true,
    },
    ...over,
  }
}

function metadata(rows, over = {}) {
  const first = rows[0]?.order ?? null
  const last = rows.at(-1)?.order ?? null
  return {
    policy_version: REMOTE_INGRESS_POLICY_VERSION,
    returned: rows.length,
    total_known: rows.length,
    source_window: { start: first, end: last },
    truncated: false,
    has_more: false,
    next_cursor: null,
    fetch_id: null,
    omission_reason: null,
    ...over,
  }
}

function envelope(over = {}) {
  const commands = over.commands ?? [command()]
  const context = over.context ?? emptyContext()
  const rows = [...commands, ...Object.values(context).flat()].sort(
    (a, b) => a.order.sequence - b.order.sequence,
  )
  return {
    kind: 'devspec.remote_ingress',
    schema_version: 1,
    contract_version: REMOTE_INGRESS_CONTRACT_VERSION,
    policy_version: REMOTE_INGRESS_POLICY_VERSION,
    envelope_id: ENVELOPE,
    connection: {
      connection_id: CONNECTION,
      agent_name: 'Claude Code',
      codename: 'Careful Moth',
      label: 'Claude Code / Careful Moth',
    },
    wake: { kind: 'conversational_command', active: true, reason_id: 'new-command' },
    delivery_state: 'live',
    command_message_ids: commands.map((entry) => entry.message_id),
    commands,
    control: null,
    context,
    window: metadata(rows),
    ...over,
  }
}

describe('normalizeRemoteIngressV1', () => {
  it('preserves an exact very large full command body and all metadata by identity', () => {
    const body = `start\n${'x'.repeat(300_000)}\nend`
    const ingress = envelope({ commands: [command({ content: { mode: 'full', body, complete: true } })] })
    const result = normalizeRemoteIngressV1(ingress, CONNECTION)
    assert.equal(result.ok, true)
    assert.equal(result.wake, true)
    assert.equal(result.envelope, ingress)
    assert.equal(result.commands[0].content.body, body)
    assert.equal(result.commands[0].delivery.turn_id, TURN)
    assert.equal(result.commands[0].requester.user_id, OWNER)
  })

  it('accepts both server authority kinds while preserving requester attribution', () => {
    const requester = '21000000-0000-4000-8000-000000000002'
    const delegated = command({
      requester: { user_id: requester, display_name: 'Delegate' },
      authority: {
        kind: 'delegated',
        mode: 'allowlist',
        requested_by_user_id: requester,
        connection_owner_user_id: OWNER,
        decision_source: 'server',
      },
    })
    const result = normalizeRemoteIngressV1(envelope({ commands: [delegated] }), CONNECTION)
    assert.equal(result.wake, true)
    assert.equal(result.commands[0].authority.kind, 'delegated')
    assert.equal(result.commands[0].requester.user_id, requester)
  })

  it('accepts metadata attachments as stable resource references without rewriting them', () => {
    const stable = {
      materialization: 'metadata',
      filename: 'design.png',
      mime_type: 'image/png',
      type: 'image',
      size_bytes: 1234,
      resource_id: RESOURCE,
    }
    const ingress = envelope({ commands: [command({ attachments: [stable] })] })
    const result = normalizeRemoteIngressV1(ingress, CONNECTION)
    assert.equal(result.wake, true)
    assert.equal(result.commands[0].attachments[0], stable)
    assert.equal(result.commands[0].attachments[0].resource_id, RESOURCE)
  })

  it('rejects an unavailable attachment for the whole one-command turn before wake', () => {
    const unavailable = {
      materialization: 'unavailable',
      filename: 'lost.png',
      mime_type: 'image/png',
      type: 'image',
      size_bytes: null,
      resource_id: null,
      reason: 'missing_resource',
    }
    const result = normalizeRemoteIngressV1(
      envelope({ commands: [command({ attachments: [unavailable] })] }),
      CONNECTION,
    )
    assert.deepEqual([result.ok, result.wake, result.reason], [true, false, 'unavailable_attachment'])
  })

  it('matches the authoritative canonical UUID boundary', () => {
    const cases = [
      ['lowercase nil sentinel', '00000000-0000-0000-0000-000000000000', true],
      ['lowercase max sentinel', 'ffffffff-ffff-ffff-ffff-ffffffffffff', true],
      ['lowercase RFC v4 UUID', '123e4567-e89b-42d3-a456-426614174000', true],
      ['uppercase RFC v4 UUID', '123E4567-E89B-42D3-A456-426614174000', true],
      ['nil near miss', '00000000-0000-0000-0000-000000000001', false],
      ['max near miss', 'ffffffff-ffff-ffff-ffff-fffffffffffe', false],
      ['uppercase max sentinel', 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF', false],
      ['mixed-case max sentinel', 'ffffffff-ffff-ffff-ffff-ffffffffffFf', false],
      ['invalid RFC version', '123e4567-e89b-92d3-a456-426614174000', false],
      ['invalid RFC variant', '123e4567-e89b-42d3-7456-426614174000', false],
      ['missing canonical hyphen', '123e4567e89b-42d3-a456-426614174000', false],
    ]

    for (const [name, value, expected] of cases) {
      assert.equal(
        normalizeRemoteIngressV1(envelope({ envelope_id: value }), CONNECTION).ok,
        expected,
        name,
      )
    }
  })

  it('matches authoritative datetime/safe-integer boundaries', () => {
    const invalidDate = command({
      order: { sequence: 1, created_at: '2026-02-29T12:00:00.000Z', message_id: MESSAGE },
    })
    assert.equal(normalizeRemoteIngressV1(envelope({ commands: [invalidDate] }), CONNECTION).ok, false)
    const unsafeOrder = command({
      order: { sequence: Number.MAX_SAFE_INTEGER + 1, created_at: '2026-08-19T12:00:00.000Z', message_id: MESSAGE },
    })
    assert.equal(normalizeRemoteIngressV1(envelope({ commands: [unsafeOrder] }), CONNECTION).ok, false)
  })

  it('fails closed on missing, malformed, extra-field, unknown-version, and wrong-target ingress', () => {
    assert.equal(normalizeRemoteIngressV1(undefined, CONNECTION).ok, false)
    assert.equal(normalizeRemoteIngressV1({ kind: 'devspec.remote_ingress' }, CONNECTION).ok, false)
    assert.equal(normalizeRemoteIngressV1({ ...envelope(), preview: 'run me' }, CONNECTION).ok, false)
    assert.equal(normalizeRemoteIngressV1({ ...envelope(), schema_version: 2 }, CONNECTION).ok, false)
    assert.equal(normalizeRemoteIngressV1({ ...envelope(), contract_version: '1.1.0' }, CONNECTION).ok, true)
    assert.equal(normalizeRemoteIngressV1({ ...envelope(), contract_version: '1.1.2' }, CONNECTION).ok, false)
    assert.equal(
      normalizeRemoteIngressV1(envelope(), '90000000-0000-4000-8000-000000000009').ok,
      false,
    )
  })

  it('never wakes replay/reseed/advisory/control/idle envelopes', () => {
    const cases = [
      envelope({
        wake: { kind: 'history_reseed', active: false, reason_id: 'reseed' },
        delivery_state: 'reseed',
        command_message_ids: [],
        commands: [],
        window: metadata([]),
      }),
      envelope({
        wake: { kind: 'advisory_update', active: false, reason_id: 'context' },
        command_message_ids: [],
        commands: [],
        window: metadata([]),
      }),
      envelope({
        wake: { kind: 'idle', active: false, reason_id: 'idle' },
        command_message_ids: [],
        commands: [],
        window: metadata([]),
      }),
      envelope({
        wake: { kind: 'control', active: true, reason_id: 'control' },
        command_message_ids: [],
        commands: [],
        control: {
          id: '80000000-0000-4000-8000-000000000008',
          verb: 'abort',
          issued_at: '2026-08-19T12:00:00.000Z',
          issued_by_user_id: OWNER,
        },
        window: metadata([]),
      }),
    ]
    for (const ingress of cases) {
      const result = normalizeRemoteIngressV1(ingress, CONNECTION)
      assert.equal(result.ok, true)
      assert.equal(result.wake, false)
    }
  })

  it('preserves queued command order and the one-turn primary binding', () => {
    const secondId = '31000000-0000-4000-8000-000000000003'
    const secondaryRef = '41000000-0000-4000-8000-000000000004'
    const primary = command()
    const secondary = command({
      message_id: secondId,
      order: order(secondId, 2),
      content: { mode: 'full', body: 'second queued body', complete: true },
      delivery: {
        provenance_ref: secondaryRef,
        turn_id: TURN,
        primary_provenance_ref: PROVENANCE,
        is_primary: false,
      },
    })
    const ingress = envelope({ commands: [primary, secondary] })
    const result = normalizeRemoteIngressV1(ingress, CONNECTION)
    assert.equal(result.wake, true)
    assert.deepEqual(result.commands.map((entry) => entry.message_id), [MESSAGE, secondId])
    assert.equal(result.commands[1].delivery.primary_provenance_ref, PROVENANCE)
  })

  it('accepts a later cursor delta after the turn primary was already consumed', () => {
    const secondId = '31000000-0000-4000-8000-000000000003'
    const secondary = command({
      message_id: secondId,
      order: order(secondId, 2),
      delivery: {
        provenance_ref: '41000000-0000-4000-8000-000000000004',
        turn_id: TURN,
        primary_provenance_ref: PROVENANCE,
        is_primary: false,
      },
    })
    const result = normalizeRemoteIngressV1(envelope({ commands: [secondary] }), CONNECTION)
    assert.equal(result.ok, true)
    assert.equal(result.wake, true)
    assert.deepEqual(result.commands.map((entry) => entry.message_id), [secondId])
  })

  it('rejects false primary flags and duplicate visible provenance refs', () => {
    const secondaryId = '31000000-0000-4000-8000-000000000003'
    const secondary = command({
      message_id: secondaryId,
      order: order(secondaryId, 2),
      delivery: {
        provenance_ref: '41000000-0000-4000-8000-000000000004',
        turn_id: TURN,
        primary_provenance_ref: PROVENANCE,
        is_primary: false,
      },
    })
    const falseFlag = command({
      delivery: {
        provenance_ref: PROVENANCE,
        turn_id: TURN,
        primary_provenance_ref: PROVENANCE,
        is_primary: false,
      },
    })
    assert.equal(normalizeRemoteIngressV1(envelope({ commands: [falseFlag] }), CONNECTION).ok, false)
    const duplicate = command({
      message_id: secondaryId,
      order: order(secondaryId, 2),
      delivery: { ...secondary.delivery, provenance_ref: secondary.delivery.provenance_ref },
    })
    const first = command({
      delivery: {
        provenance_ref: secondary.delivery.provenance_ref,
        turn_id: TURN,
        primary_provenance_ref: PROVENANCE,
        is_primary: false,
      },
    })
    assert.equal(normalizeRemoteIngressV1(envelope({ commands: [first, duplicate] }), CONNECTION).ok, false)
  })

  it('treats reconnect replay as inert even when legacy top-level arrays would look live', () => {
    const replay = envelope({
      wake: { kind: 'history_reseed', active: false, reason_id: 'reconnect' },
      delivery_state: 'replay',
      command_message_ids: [],
      commands: [],
      window: metadata([]),
    })
    const pollResponse = { changed: true, ingress: replay, commands: [command()], preview: 'do it' }
    const result = normalizeRemoteIngressV1(pollResponse.ingress, CONNECTION)
    assert.equal(result.ok, true)
    assert.equal(result.wake, false)
  })
})

describe('renderAdvisoryContext', () => {
  it('renders every typed bucket with an explicit actor label and advisory marker', () => {
    const kinds = [
      ['human_context', 'human'],
      ['agent_context', 'agent'],
      ['ai_context', 'ai'],
      ['system_context', 'system'],
    ]
    const context = emptyContext()
    for (let i = 0; i < kinds.length; i++) {
      const [bucket, kind] = kinds[i]
      const id = `${String(10 + i).padStart(8, '0')}-0000-4000-8000-000000000010`
      context[bucket].push({
        message_id: id,
        order: order(id, i + 1),
        actor: {
          kind,
          user_id: kind === 'human' ? OWNER : null,
          display_name: `${kind} actor`,
          agent_tool: kind === 'agent' ? 'Claude Code' : null,
          model: kind === 'ai' ? 'model-x' : null,
        },
        source_type: 'session_message',
        relationship: 'within_window',
        content: `${kind} says this is context`,
        advisory: true,
      })
    }
    const rendered = renderAdvisoryContext(context)
    assert.equal(rendered.length, 4)
    assert.ok(rendered.every((entry) => entry.advisory === true))
    assert.deepEqual(rendered.map((entry) => entry.actor_label), [
      'HUMAN: human actor',
      'AGENT: agent actor',
      'AI: ai actor',
      'SYSTEM: system actor',
    ])
  })
})
