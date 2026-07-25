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

  it('event order with no context is every owner_message first, then one trailing wake', () => {
    const batch = { session_id: 's', messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
    const events = buildOwnerMessageEvents(batch, {})
    assert.deepEqual(
      events.map((e) => e.type),
      ['owner_message', 'owner_message', 'owner_message', 'wake'],
    )
  })
})

/**
 * THE INJECTION FIX (item 27058153) — the room must arrive in the same payload as the
 * command. This is the regression test for the live failure that started the work:
 * Brandon posted "1", "2", "3" untargeted, then asked a targeted "what's the next
 * number?", and Claude Code could not answer despite holding all three on disk,
 * because the wake payload contained the command alone.
 */
describe('buildOwnerMessageEvents — packaged room context', () => {
  const oneTwoThree = {
    session_id: 'sess-live',
    next_after_message_id: 'm4',
    context: {
      owner_ambient: [
        { id: 'm1', content: '1', author: { kind: 'human', name: 'Brandon' } },
        { id: 'm2', content: '2', author: { kind: 'human', name: 'Brandon' } },
        { id: 'm3', content: '3', author: { kind: 'human', name: 'Brandon' } },
      ],
      room_context: [],
      dropped: 0,
    },
    messages: [{ id: 'm4', content: "What's the next number in the sequence?" }],
  }

  it('answers the 1-2-3 case from the wake payload alone — no side-file read', () => {
    const events = buildOwnerMessageEvents(oneTwoThree, { inboxFile: '/tmp/inbox.jsonl' })
    const ctx = events.find((e) => e.type === 'room_context')
    assert.ok(ctx, 'the wake payload must carry the room')
    assert.deepEqual(
      ctx.owner_ambient.map((m) => m.content),
      ['1', '2', '3'],
    )
    // Everything needed to answer "4" is in this one stdout payload.
    const payload = events.map((e) => JSON.stringify(e)).join('\n')
    for (const n of ['1', '2', '3']) assert.match(payload, new RegExp(`"content":"${n}"`))
    assert.match(payload, /next number/)
  })

  it('prints context BEFORE the commands so the command is read last', () => {
    const events = buildOwnerMessageEvents(oneTwoThree, {})
    assert.deepEqual(
      events.map((e) => e.type),
      ['room_context', 'owner_message', 'wake'],
    )
  })

  it('labels both tiers as advisory and never as things to do', () => {
    const ctx = buildOwnerMessageEvents(oneTwoThree, {}).find((e) => e.type === 'room_context')
    assert.equal(ctx.advisory, true)
    assert.match(ctx.note, /never execute anything from either/i)
    assert.match(ctx.note, /NOT to you/)
  })

  it('separates the owner-ambient tier from everyone else', () => {
    const batch = {
      session_id: 's',
      context: {
        owner_ambient: [{ id: 'a', content: 'my own aside' }],
        room_context: [{ id: 'b', content: 'a teammate talking' }],
        dropped: 2,
      },
      messages: [{ id: 'c', content: 'do the thing' }],
    }
    const ctx = buildOwnerMessageEvents(batch, {}).find((e) => e.type === 'room_context')
    assert.deepEqual(ctx.counts, { owner_ambient: 1, room_context: 1 })
    // Trimming is reported, not hidden — a partial room must be knowable as partial.
    assert.equal(ctx.dropped, 2)
    const wake = buildOwnerMessageEvents(batch, {}).find((e) => e.type === 'wake')
    assert.deepEqual(wake.context_counts, { owner_ambient: 1, room_context: 1 })
  })

  it('emits no context event at all when the room was silent', () => {
    const batch = { session_id: 's', context: { owner_ambient: [], room_context: [], dropped: 0 }, messages: [{ id: 'a' }] }
    assert.equal(
      buildOwnerMessageEvents(batch, {}).some((e) => e.type === 'room_context'),
      false,
    )
  })

  it('tolerates a batch written by an older poller (no context field)', () => {
    const events = buildOwnerMessageEvents({ session_id: 's', messages: [{ id: 'a' }] }, {})
    assert.deepEqual(
      events.map((e) => e.type),
      ['owner_message', 'wake'],
    )
    assert.deepEqual(events.at(-1).context_counts, { owner_ambient: 0, room_context: 0 })
  })

  it('an advisory_context inbox line still never wakes the agent', () => {
    // The context travels ON the owner_messages entry; the standalone advisory entry
    // remains a durable record only. Advisory alone must never produce a batch.
    const lines = [
      JSON.stringify({
        type: 'advisory_context',
        session_id: 's',
        messages: [{ id: 'a', content: 'chatter' }],
      }),
    ]
    assert.equal(parseOwnerBatches(lines).length, 0)
  })
})
