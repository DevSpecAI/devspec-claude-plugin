import { test } from 'node:test'
import assert from 'node:assert/strict'

import { UNTITLED_RETRY_MS, readSessionTitle, sessionTitleReadDue } from './session-title.mjs'

const SESSION_ID = '358f2225-413a-483e-9c05-1617aa278fc2'

test('a newly attached room has its title read straight away, and a titled one is left alone', () => {
  assert.equal(sessionTitleReadDue({ sessionId: SESSION_ID, state: {}, lastAttemptAt: 0 }), true)
  assert.equal(sessionTitleReadDue({
    sessionId: SESSION_ID,
    state: { session_title: 'Fix the login redirect', session_title_for: SESSION_ID },
    lastAttemptAt: 0,
  }), false)
  assert.equal(sessionTitleReadDue({ sessionId: null, state: {}, lastAttemptAt: 0 }), false)
})

test('an untitled room, or a read that failed, is tried again only after the retry interval', () => {
  const now = 1_000_000
  const untitled = { session_title: 'New session', session_title_for: SESSION_ID }
  assert.equal(sessionTitleReadDue({ sessionId: SESSION_ID, state: untitled, lastAttemptAt: now - 1_000, now }), false)
  assert.equal(sessionTitleReadDue({ sessionId: SESSION_ID, state: untitled, lastAttemptAt: now - UNTITLED_RETRY_MS, now }), true)
  // Nothing stored yet because the last read failed.
  assert.equal(sessionTitleReadDue({ sessionId: SESSION_ID, state: {}, lastAttemptAt: now - 1_000, now }), false)
  assert.equal(sessionTitleReadDue({ sessionId: SESSION_ID, state: {}, lastAttemptAt: now - UNTITLED_RETRY_MS, now }), true)
})

test('the title is read with an empty window, so no history comes back with it', async () => {
  const calls = []
  const now = Date.parse('2026-10-05T09:30:00Z')
  const title = await readSessionTitle({
    call: async (request) => {
      calls.push(request)
      return { id: SESSION_ID, title: 'Fix the login redirect', messages: [] }
    },
    mcpUrl: 'https://api.devspec.example/api/mcp',
    token: 'dvs_x',
    sessionId: SESSION_ID,
    now,
  })
  assert.equal(title, 'Fix the login redirect')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'get_session_transcript')
  assert.deepEqual(calls[0].arguments, { session_id: SESSION_ID, since_created_at: '2026-10-05T09:30:00.000Z', limit: 1 })
  assert.ok(calls[0].timeoutMs > 0, 'a read that hangs must not hold the poller')
})

test('a failed read, or an answer about another room, stores nothing', async () => {
  const base = { mcpUrl: 'u', token: 't', sessionId: SESSION_ID }
  assert.equal(await readSessionTitle({ ...base, call: async () => { throw new Error('offline') } }), null)
  assert.equal(await readSessionTitle({ ...base, call: async () => ({ id: 'someone-else', title: 'x' }) }), null)
  assert.equal(await readSessionTitle({ ...base, call: async () => ({ id: SESSION_ID }) }), '')
})
