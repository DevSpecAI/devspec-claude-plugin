#!/usr/bin/env node
/**
 * Unit tests for devspec-remote-wait's owner-command batch parsing and event
 * building. Run: node --test hooks/scripts/devspec-remote-wait.test.mjs
 *
 * Regression coverage for item b9fb49a9: an inbox batch's session_id (already
 * stamped by the poller's appendInbox) must survive into both the per-message
 * owner_message event and the summary wake event, so the agent consuming this
 * stream always has a live, event-sourced session id — never a value it must
 * cache and risk going stale after a server-side session reattach.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseOwnerBatches, buildOwnerMessageEvents } from './devspec-remote-wait.mjs'

describe('parseOwnerBatches', () => {
  it('keeps only owner_messages lines with a non-empty messages array', () => {
    const lines = [
      JSON.stringify({ type: 'owner_messages', session_id: 's1', messages: [{ id: 'm1' }] }),
      JSON.stringify({ type: 'advisory_context', session_id: 's1', messages: [{ id: 'a1' }] }),
      JSON.stringify({ type: 'owner_messages', session_id: 's2', messages: [] }),
      'not json',
    ]
    const batches = parseOwnerBatches(lines)
    assert.equal(batches.length, 1)
    assert.equal(batches[0].session_id, 's1')
  })
})

describe('buildOwnerMessageEvents (item b9fb49a9 — session id must not be dropped)', () => {
  it('stamps the batch session_id on every owner_message event', () => {
    const batch = {
      session_id: 'sess-live',
      next_after_message_id: 'msg-2',
      messages: [{ id: 'msg-1' }, { id: 'msg-2' }],
    }
    const events = buildOwnerMessageEvents(batch, { inboxFile: '/tmp/inbox.jsonl' })
    const ownerEvents = events.filter((e) => e.type === 'owner_message')
    assert.equal(ownerEvents.length, 2)
    for (const e of ownerEvents) assert.equal(e.session_id, 'sess-live')
    assert.deepEqual(
      ownerEvents.map((e) => e.message.id),
      ['msg-1', 'msg-2'],
    )
  })

  it('stamps the batch session_id on the trailing wake event too', () => {
    const batch = { session_id: 'sess-live', messages: [{ id: 'msg-1' }] }
    const events = buildOwnerMessageEvents(batch, { inboxFile: '/tmp/inbox.jsonl' })
    const wake = events.find((e) => e.type === 'wake')
    assert.equal(wake.session_id, 'sess-live')
    assert.equal(wake.count, 1)
    assert.equal(wake.inbox, '/tmp/inbox.jsonl')
  })

  it('emits session_id: null for a sessionless dispatch batch rather than throwing', () => {
    const batch = { messages: [{ id: 'msg-1' }] } // no session_id field at all
    const events = buildOwnerMessageEvents(batch, { inboxFile: '/tmp/inbox.jsonl' })
    assert.equal(events.find((e) => e.type === 'owner_message').session_id, null)
    assert.equal(events.find((e) => e.type === 'wake').session_id, null)
  })

  it('event order is every owner_message first, then one trailing wake', () => {
    const batch = { session_id: 's', messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
    const events = buildOwnerMessageEvents(batch, {})
    assert.deepEqual(
      events.map((e) => e.type),
      ['owner_message', 'owner_message', 'owner_message', 'wake'],
    )
  })
})
