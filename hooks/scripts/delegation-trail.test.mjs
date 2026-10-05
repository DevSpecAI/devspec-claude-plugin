#!/usr/bin/env node
/**
 * The delegation group in a session's Activity (item d2cbd4c6).
 * Run: node --test hooks/scripts/delegation-trail.test.mjs
 *
 * Inbox and hook shapes are the ones Claude Code 2.1.289 and the plugin's poller
 * produced on 2026-10-05.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import {
  delegatedChildren,
  delegationEvent,
  delegationText,
  ensureTrailState,
  latestDeliveredCommand,
  postLatest,
  turnIdentity,
} from './delegation-trail.mjs'
import { recordOwnedEnd, recordOwnedLaunch, stillAlive, subagentStillWaiting, turnMarkerPath, updateDelegationTrail } from './mirror-turn.mjs'

const CONNECTION = '11111111-2222-4333-8444-555555555555'
const SESSION = '86e8b437-8c8e-4882-b1e7-24b4a2aeb7c6'
const TURN_ID = 'ec0017b7-8bc7-4cff-92db-ca59550868f4'
const MESSAGE_ID = '0e6c1d9e-4ebe-48c7-a0ed-d320a8627778'
const T0 = Date.parse('2026-10-05T15:13:49.258Z')

const scratch = []
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }) })
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-delegation-'))
  scratch.push(dir)
  return dir
}

function canonicalCommands(receivedAt, turnId = TURN_ID, messageId = MESSAGE_ID) {
  return JSON.stringify({
    type: 'canonical_commands',
    received_at: new Date(receivedAt).toISOString(),
    ingress: { commands: [{ message_id: messageId, delivery: { turn_id: turnId, is_primary: true } }] },
  })
}

describe('turnIdentity — a trail names exactly the command turn it belongs to', () => {
  const state = { connection_id: CONNECTION, session_id: SESSION }
  const marker = { startedAt: T0 + 300 }

  it('uses the delivered command that opened this turn', () => {
    const latestCommand = latestDeliveredCommand([canonicalCommands(T0 - 600_000, 'aaaaaaaa-1111-4222-8333-444444444444'), canonicalCommands(T0)].join('\n'))
    assert.deepEqual(turnIdentity({ state, marker, latestCommand }), { command_turn_id: TURN_ID, command_message_id: MESSAGE_ID })
  })

  it('posts nothing when the newest command did not open this turn', () => {
    const latestCommand = latestDeliveredCommand(canonicalCommands(T0 - 60_000))
    assert.equal(turnIdentity({ state, marker, latestCommand }), null)
  })

  it('a turn typed at the terminal is a local turn', () => {
    const local = { ...state, local_turn: { attempt_id: '22222222-3333-4444-8555-666666666666', session_id: SESSION } }
    assert.deepEqual(turnIdentity({ state: local, marker, latestCommand: null }), { command_turn_unbound: true, local_turn: true })
  })

  it('a connection outside a room posts nothing', () => {
    assert.equal(turnIdentity({ state: { connection_id: CONNECTION }, marker, latestCommand: latestDeliveredCommand(canonicalCommands(T0)) }), null)
  })
})

describe('delegationEvent — one nested group the Activity panel already renders', () => {
  const launch = (id, at, extra = {}) => ({ id, kind: 'subagent', turn: 1, at: new Date(at).toISOString(), ...extra })

  it('shows running subagents with their label and model, and never their ids', () => {
    const lines = [
      launch('ac0306ccc64174af8', T0 + 1_000, { label: 'sleep probe', model: 'claude-sonnet-5-5' }),
      { id: 'bp2fmso53', kind: 'shell', turn: 1, at: new Date(T0 + 2_000).toISOString() },
    ]
    const event = delegationEvent(delegatedChildren(lines, 1), { seq: 1 })
    assert.equal(event.kind, 'subagent')
    assert.equal(event.status, 'running')
    assert.equal(event.summary, '1 of 1 agent active')
    assert.deepEqual(event.children, [
      { key: 'child-1', agent: 'sleep probe', status: 'running', model: 'claude-sonnet-5-5', lastActivityAt: new Date(T0 + 1_000).toISOString() },
    ])
    assert.doesNotMatch(JSON.stringify(event), /ac0306ccc64174af8|bp2fmso53/)
  })

  it('a finished subagent is shown finished, with how long it took', () => {
    const lines = [
      launch('a1', T0, { label: 'review docs' }),
      launch('a2', T0 + 500, { label: 'run checks' }),
      { id: 'a1', turn: 1, ended: new Date(T0 + 45_000).toISOString(), status: 'completed' },
    ]
    let event = delegationEvent(delegatedChildren(lines, 1), { seq: 1 })
    assert.equal(event.summary, '1 of 2 agents active')
    assert.deepEqual(event.children.map((c) => [c.agent, c.status, c.durationMs ?? null]), [['review docs', 'completed', 45_000], ['run checks', 'running', null]])

    lines.push({ id: 'a2', turn: 1, ended: new Date(T0 + 60_500).toISOString(), status: 'completed' })
    event = delegationEvent(delegatedChildren(lines, 1), { seq: 1 })
    assert.equal(event.status, 'ok')
    assert.equal(event.summary, '2 agents finished')
    assert.equal(event.completedAt, new Date(T0 + 60_500).toISOString())
    assert.equal(event.durationMs, 60_500)
    // The text only ever grows, so the server's prefix fold keeps it whole.
    const text = delegationText(lines, 1)
    assert.equal(text, ['Delegated work', '- Started review docs', '- Started run checks', '- review docs finished after 45s', '- run checks finished after 60s'].join('\n'))
    assert.ok(text.startsWith(delegationText(lines.slice(0, 3), 1)))
  })

  it('a turn that delegated nothing has no group', () => {
    assert.equal(delegationEvent(delegatedChildren([{ id: 'b1', kind: 'shell', turn: 1, at: new Date(T0).toISOString() }], 1), { seq: 1 }), null)
  })
})

describe('postLatest — one post in flight, and the last change always reaches the room', () => {
  it('re-posts when a change arrived during a post', async () => {
    const dir = tempDir()
    let version = 1
    const posted = []
    const result = await postLatest(CONNECTION, {
      dir,
      build: () => ({ version }),
      post: async (payload) => {
        posted.push(payload.version)
        if (posted.length === 1) {
          version = 2
          // A second hook fires while this post is in flight.
          const nested = await postLatest(CONNECTION, { dir, build: () => ({ version }), post: async () => true })
          assert.equal(nested.deferred, true)
        }
        return true
      },
    })
    assert.deepEqual(posted, [1, 2])
    assert.equal(result.posted, 2)
    assert.equal(fs.existsSync(path.join(dir, `${CONNECTION}.turn-trail.lock`)), false)
  })

  it('takes over a lock left by a hook that was killed', async () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, `${CONNECTION}.turn-trail.lock`), String(Date.now() - 60_000))
    const result = await postLatest(CONNECTION, { dir, build: () => ({}), post: async () => true })
    assert.equal(result.posted, 1)
  })
})

describe('updateDelegationTrail — what reaches post_session_message', () => {
  it('posts a trail under the exact command identity, and only once there is delegated work', async () => {
    const dir = tempDir()
    const startedAt = T0 + 300
    fs.writeFileSync(turnMarkerPath(CONNECTION, dir), JSON.stringify({ startedAt }))
    fs.writeFileSync(path.join(dir, `${CONNECTION}.inbox.jsonl`), canonicalCommands(T0) + '\n')
    const state = { connection_id: CONNECTION, session_id: SESSION }
    const calls = []
    const call = async (request) => { calls.push(request); return { delivery: { status: 'stored' } } }
    const auth = { token: 'dvs_test', mcpUrl: 'https://api.devspec.example/api/mcp' }
    const marker = { startedAt }

    recordOwnedLaunch(CONNECTION, { id: 'bshell1', kind: 'shell' }, { dir, now: startedAt + 1_000 })
    assert.deepEqual(await updateDelegationTrail(state, { dir, marker, call, auth }), { posted: 0 })

    recordOwnedLaunch(CONNECTION, { id: 'ac0306ccc64174af8', kind: 'subagent', label: 'sleep probe', model: 'claude-sonnet-5-5' }, { dir, now: startedAt + 2_000 })
    await updateDelegationTrail(state, { dir, marker, call, auth })
    assert.equal(recordOwnedEnd(CONNECTION, 'ac0306ccc64174af8', { dir, now: startedAt + 47_000 }), true)
    await updateDelegationTrail(state, { dir, marker, call, auth })

    assert.equal(calls.length, 2)
    for (const request of calls) {
      assert.equal(request.name, 'post_session_message')
      assert.equal(request.arguments.phase, 'trail')
      assert.equal(request.arguments.connection_id, CONNECTION)
      assert.equal(request.arguments.command_turn_id, TURN_ID)
      assert.equal(request.arguments.command_message_id, MESSAGE_ID)
      assert.ok(request.arguments.message.length > 0, 'a trail post must carry text')
    }
    assert.equal(calls[0].arguments.trail_events[0].children[0].status, 'running')
    assert.equal(calls[1].arguments.trail_events[0].children[0].status, 'completed')
    assert.equal(calls[1].arguments.trail_events[0].children[0].durationMs, 45_000)
    assert.equal(calls[0].arguments.trail_events[0].seq, calls[1].arguments.trail_events[0].seq)
  })

  it('posts nothing when the command identity cannot be established', async () => {
    const dir = tempDir()
    const startedAt = T0 + 300
    fs.writeFileSync(turnMarkerPath(CONNECTION, dir), JSON.stringify({ startedAt }))
    recordOwnedLaunch(CONNECTION, { id: 'a1', kind: 'subagent', label: 'x' }, { dir, now: startedAt + 1_000 })
    const calls = []
    const result = await updateDelegationTrail(
      { connection_id: CONNECTION, session_id: SESSION },
      { dir, marker: { startedAt }, call: async (r) => { calls.push(r) }, auth: { token: 't', mcpUrl: 'u' } },
    )
    assert.deepEqual(result, { posted: 0 })
    assert.equal(calls.length, 0)
    assert.equal(ensureTrailState(CONNECTION, { dir, turn: startedAt, resolveIdentity: () => null }), null)
  })
})

describe('subagentStillWaiting — a subagent that stops to say it is waiting has not finished', () => {
  // Measured 2026-10-05: a subagent's foreground `sleep 25` was refused, it re-ran it in
  // the background (bqy23s945), stopped with an interim report at +4 s, and finished
  // at +29 s. Its own background command is what it was still waiting on.
  it('waits while something the subagent started is still running, and finishes once nothing is', () => {
    const dir = tempDir()
    const startedAt = T0
    fs.writeFileSync(turnMarkerPath(CONNECTION, dir), JSON.stringify({ startedAt }))
    recordOwnedLaunch(CONNECTION, { id: 'a70dc9e6f73b91717', kind: 'subagent', label: 'docs review' }, { dir, now: startedAt + 1_000 })
    recordOwnedLaunch(CONNECTION, { id: 'bqy23s945', kind: 'shell', parent: 'a70dc9e6f73b91717' }, { dir, now: startedAt + 4_000 })
    const listener = { id: 'b1ldwo0qm', type: 'shell', status: 'running' }
    const self = { id: 'a70dc9e6f73b91717', type: 'subagent', status: 'running' }
    const ownCommand = { id: 'bqy23s945', type: 'shell', status: 'running' }

    assert.equal(subagentStillWaiting(CONNECTION, 'a70dc9e6f73b91717', [listener, self, ownCommand], { dir }), true)
    assert.equal(subagentStillWaiting(CONNECTION, 'a70dc9e6f73b91717', [listener, self], { dir }), false)
    // A host that sends no list cannot tell an interim stop from the last one.
    assert.equal(subagentStillWaiting(CONNECTION, 'a70dc9e6f73b91717', null, { dir }), false)
  })
})

describe('stillAlive — the host stops listing a subagent while it waits on its own command', () => {
  // The main Stop at 15:51:55 on 2026-10-05 listed the listener and the subagents'
  // background commands, but neither subagent.
  const lines = [
    { id: 'acd5458b776d87b57', kind: 'subagent', turn: 1, at: 'x' },
    { id: 'a4415f3884489937c', kind: 'subagent', turn: 1, at: 'x' },
    { id: 'bf3h0vohd', kind: 'shell', turn: 1, at: 'x', parent: 'acd5458b776d87b57' },
    { id: 'bj2npe9zb', kind: 'shell', turn: 1, at: 'x', parent: 'a4415f3884489937c' },
  ]
  it('keeps a subagent alive through the work it started', () => {
    const listed = new Set(['b1ldwo0qm', 'bj2npe9zb', 'bf3h0vohd'])
    assert.equal(stillAlive('acd5458b776d87b57', lines, listed), true)
    assert.equal(stillAlive('a4415f3884489937c', lines, listed), true)
  })
  it('lets it go once nothing it started is listed', () => {
    assert.equal(stillAlive('acd5458b776d87b57', lines, new Set(['b1ldwo0qm', 'bj2npe9zb'])), false)
  })
})
