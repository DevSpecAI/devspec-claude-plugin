#!/usr/bin/env node
/**
 * The two arbitration halves for the Working/Idle oscillation (item 55d1bac8).
 * Run: node --test hooks/scripts/mark-explicit-reply.test.mjs
 *
 * The bug: the `.turn` marker is host-observed liveness and the poller re-asserts
 * busy from it every tick. An agent declaring `complete_turn` mid-turn closed the
 * activity attempt without clearing the marker, so the completed attempt read Idle
 * and the next keepalive read Working, for up to MAX_TURN_MS.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { declaresCompleteTurn } from './mark-explicit-reply.mjs'
import { isNoWorkingAttemptRefusal } from './devspec-remote-poll.mjs'

const tmpRoots = []
after(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true })
})

describe('declaresCompleteTurn', () => {
  const hook = (toolInput) =>
    JSON.stringify({ tool_name: 'mcp__devspec__post_session_message', tool_input: toolInput })

  it('is true only for an explicit boolean true', () => {
    assert.equal(declaresCompleteTurn(hook({ complete_turn: true })), true)
  })

  it('is false for a mid-turn post that omits the flag', () => {
    // The common case: progress on a long brief. The marker must survive.
    assert.equal(declaresCompleteTurn(hook({ message: 'done X, starting Y' })), false)
  })

  it('is false for explicit false', () => {
    assert.equal(declaresCompleteTurn(hook({ complete_turn: false })), false)
  })

  it('never reads a truthy non-boolean as completion', () => {
    // Clearing the marker wrongly shows Idle while the agent is still working,
    // so anything but a real boolean true must be treated as "not finished".
    for (const v of ['true', 1, {}, [], 'yes']) {
      assert.equal(declaresCompleteTurn(hook({ complete_turn: v })), false, `value ${JSON.stringify(v)}`)
    }
  })

  it('is false for malformed or empty hook input', () => {
    assert.equal(declaresCompleteTurn(''), false)
    assert.equal(declaresCompleteTurn('{not json'), false)
    assert.equal(declaresCompleteTurn('{}'), false)
  })

  it('reads the camelCase hook shape too', () => {
    assert.equal(
      declaresCompleteTurn(JSON.stringify({ toolName: 'x', toolInput: { complete_turn: true } })),
      true,
    )
  })
})

describe('isNoWorkingAttemptRefusal', () => {
  it('matches the exact server refusal', () => {
    // apps/web/lib/connections/activity.ts — forwarded verbatim by errorResult(),
    // which drops the machine code `not_working`, so the string is all we get.
    const err = new Error('No working attempt to keep alive for this connection.')
    assert.equal(isNoWorkingAttemptRefusal(err), true)
  })

  it('does NOT match unrelated failures that merely mention working', () => {
    // A loose /working/ match here would clear a live turn's marker on transport
    // noise and show Idle while the agent is still working.
    for (const m of [
      'MCP HTTP 502: Bad Gateway',
      'fetch failed',
      'Invalid or revoked API token',
      'rate limit exceeded',
      'connection is working normally',
      'no working directory',
    ]) {
      assert.equal(isNoWorkingAttemptRefusal(new Error(m)), false, m)
    }
  })

  it('tolerates a non-Error argument', () => {
    assert.equal(isNoWorkingAttemptRefusal(null), false)
    assert.equal(isNoWorkingAttemptRefusal('No working attempt to keep alive for X'), true)
  })
})

describe('clearTurnMarker', () => {
  it('removes the marker file and is safe when it is already gone', async () => {
    const { clearTurnMarker, turnMarkerPath } = await import('./mirror-turn.mjs')
    const id = '11111111-2222-3333-4444-555555555555'
    const p = turnMarkerPath(id)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ startedAt: Date.now() }), { mode: 0o600 })
    assert.equal(fs.existsSync(p), true)
    clearTurnMarker(id)
    assert.equal(fs.existsSync(p), false)
    clearTurnMarker(id) // idempotent — must not throw
    clearTurnMarker(null)
  })
})
