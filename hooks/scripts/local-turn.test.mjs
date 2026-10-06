import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachmentFromPoll, localTurnScope, localTurnToComplete, startLocalTurn } from './local-turn.mjs'

const CONNECTION = '11111111-1111-4111-8111-111111111111'
const ROOM = '22222222-2222-4222-8222-222222222222'
const ATTACHMENT = '33333333-3333-4333-8333-333333333333'
const OLDER = '44444444-4444-4444-8444-444444444444'
const ATTACHED_AT = '2026-10-04T21:00:00.123+00:00'
const state = {
  connection_id: CONNECTION,
  session_id: ROOM,
  connection_capability: 'dvsc_hidden',
  speech_attachment_id: ATTACHMENT,
  attached_at: ATTACHED_AT,
}

describe('attachmentFromPoll', () => {
  it('records the attachment a poll names', () => {
    assert.deepEqual(attachmentFromPoll({ speech_attachment_id: ATTACHMENT, attached_at: ATTACHED_AT }),
      { speech_attachment_id: ATTACHMENT, attached_at: ATTACHED_AT })
  })
  it('records nothing for a detached or malformed response, never half an attachment', () => {
    for (const res of [{}, { speech_attachment_id: ATTACHMENT }, { speech_attachment_id: 'nope', attached_at: ATTACHED_AT }, null]) {
      assert.deepEqual(attachmentFromPoll(res), { speech_attachment_id: null, attached_at: null })
    }
  })
})

describe('localTurnScope', () => {
  it('is the exact attachment the server will check', () => {
    assert.deepEqual(localTurnScope(state, ROOM), {
      connection_id: CONNECTION,
      expected_session_id: ROOM,
      expected_attachment_id: ATTACHMENT,
      expected_attached_at: ATTACHED_AT,
    })
  })
  it('cannot prove a turn without a room, the capability or a recorded attachment', () => {
    assert.equal(localTurnScope(state, null), null)
    assert.equal(localTurnScope({ ...state, connection_capability: null }, ROOM), null)
    assert.equal(localTurnScope({ ...state, speech_attachment_id: null }, ROOM), null)
    assert.equal(localTurnScope({ ...state, attached_at: 'not a time' }, ROOM), null)
  })
})

describe('startLocalTurn', () => {
  const scope = localTurnScope(state, ROOM)
  const receipt = (args, extra) => ({ connection_id: args.connection_id, attempt_id: args.attempt_id,
    expected_session_id: args.expected_session_id, ...extra })

  it('admits with the exact local identity and nothing else', async () => {
    const calls = []
    const admitted = await startLocalTurn({ scope, attemptId: OLDER, call: async args => {
      calls.push(args)
      return receipt(args, { status: 'working', already_started: false })
    } })
    assert.deepEqual(admitted, { attempt_id: OLDER, session_id: ROOM })
    assert.deepEqual(calls, [{ ...scope, local_activity_version: 1, local_turn: true, attempt_id: OLDER, previous_attempt_id: null }])
  })

  it('adopts the newest attempt the server names, once', async () => {
    const calls = []
    const admitted = await startLocalTurn({ scope, call: async args => {
      calls.push(args.previous_attempt_id)
      return calls.length === 1
        ? receipt(args, { status: 'predecessor_changed', previous_attempt_id: OLDER })
        : receipt(args, { status: 'working', already_started: false })
    } })
    assert.equal(admitted.session_id, ROOM)
    assert.deepEqual(calls, [null, OLDER])
  })

  it('admits nothing when the server keeps moving, another command owns the turn, or the call fails', async () => {
    const changing = async args => receipt(args, { status: 'predecessor_changed', previous_attempt_id: OLDER })
    assert.equal(await startLocalTurn({ scope, call: changing }), null)
    assert.equal(await startLocalTurn({ scope, call: async args => receipt(args, { status: 'foreground_owned' }) }), null)
    assert.equal(await startLocalTurn({ scope, call: async () => { throw new Error('offline') } }), null)
    assert.equal(await startLocalTurn({ scope, call: async args => ({ ...receipt(args, { status: 'working' }), connection_id: OLDER }) }), null)
  })
})

describe('localTurnToComplete', () => {
  it('completes only a turn admitted in the room the connection is still in', () => {
    assert.equal(localTurnToComplete({ attempt_id: OLDER, session_id: ROOM }, ROOM), OLDER)
    assert.equal(localTurnToComplete({ attempt_id: OLDER, session_id: ROOM }, ATTACHMENT), null)
    assert.equal(localTurnToComplete(null, ROOM), null)
  })
})

// The hook as Claude Code runs it: a real process, a real state file, a stub server.
describe('mirror-turn opens and closes the owner terminal turn (item 718825fc)', () => {
  const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mirror-turn.mjs')
  const CONVERSATION = 'conversation-718825fc'
  // Claude Code's stamp on a prompt typed at the terminal, as hooks/local-prompt.ts passes it.
  const TYPED = { kind: 'composer' }
  let server
  let url
  let calls = []
  let home
  let connections

  before(async () => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        const rpc = JSON.parse(body)
        const name = rpc.params?.name
        const args = rpc.params?.arguments ?? {}
        calls.push({ name, args, capability: req.headers['x-devspec-connection-capability'] ?? null })
        const result = name === 'report_pickup'
          ? { connection_id: args.connection_id, attempt_id: args.attempt_id, expected_session_id: args.expected_session_id,
              status: 'working', already_started: false }
          : { ok: true }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }))
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${server.address().port}/api/mcp`
  })
  after(() => server.close())

  function seed(extra = {}) {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-local-turn-'))
    connections = path.join(home, '.devspec', 'remote-control', 'connections')
    fs.mkdirSync(connections, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(connections, `${CONNECTION}.json`), JSON.stringify({
      ...state, enabled: true, agent_name: 'Claude Code', local_id: CONVERSATION, token: 'dvs_test', mcp_url: url, ...extra,
    }), { mode: 0o600 })
    // A live listener, so Stop is a real turn end rather than a refusal to stop.
    fs.writeFileSync(path.join(connections, `${CONNECTION}.wait.pid`), String(process.pid), { mode: 0o600 })
    calls = []
  }
  const stored = () => JSON.parse(fs.readFileSync(path.join(connections, `${CONNECTION}.json`), 'utf8'))
  function run(mode, input) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HOOK, mode], {
        env: { PATH: process.env.PATH, HOME: home, CLAUDE_CODE_SESSION_ID: CONVERSATION },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      child.on('error', reject)
      child.on('exit', code => resolve(code))
      child.stdin.end(JSON.stringify({ session_id: CONVERSATION, ...input }))
    })
  }

  it('a typed prompt admits the turn with the capability, before anything else, and Stop closes exactly it', async () => {
    seed()
    await run('user_prompt', { prompt: 'file an item for the flaky test', origin: TYPED })
    const pickup = calls.find(call => call.name === 'report_pickup')
    assert.ok(pickup, 'report_pickup was called')
    assert.equal(calls[0].name, 'report_pickup')
    assert.equal(pickup.capability, 'dvsc_hidden')
    assert.deepEqual({ ...pickup.args, attempt_id: undefined }, {
      connection_id: CONNECTION, expected_session_id: ROOM, expected_attachment_id: ATTACHMENT,
      expected_attached_at: ATTACHED_AT, local_activity_version: 1, local_turn: true,
      attempt_id: undefined, previous_attempt_id: null,
    })
    assert.deepEqual(stored().local_turn, { attempt_id: pickup.args.attempt_id, session_id: ROOM })

    calls = []
    await run('stop', { last_assistant_message: 'Filed.' })
    const complete = calls.find(call => call.name === 'report_complete')
    assert.deepEqual(complete.args, { connection_id: CONNECTION, attempt_id: pickup.args.attempt_id, reason: 'turn_end' })
    assert.equal(stored().local_turn, null)
  })

  it('a harness wake is not a prompt: it admits nothing and keeps the open turn', async () => {
    seed({ local_turn: { attempt_id: OLDER, session_id: ROOM } })
    await run('user_prompt', { prompt: '<task-notification>background job finished</task-notification>', origin: { kind: 'task-notification' } })
    assert.equal(calls.some(call => call.name === 'report_pickup'), false)
    assert.deepEqual(stored().local_turn, { attempt_id: OLDER, session_id: ROOM })
  })

  // Measured on 2.1.291: a /loop firing carries exactly the text typed to start the
  // loop, so only the engine's stamp tells them apart (item dd1a8325).
  it('a scheduled firing of a prompt the owner once typed is not the owner speaking now', async () => {
    seed()
    const loop = '/loop check CI and merge when green'
    await run('user_prompt', { prompt: loop, origin: { kind: 'scheduled-trigger' } })
    assert.deepEqual(calls.map(call => call.name), ['heartbeat_connection'])
    assert.equal(calls[0].args.busy, true)
    assert.equal(stored().local_turn ?? null, null)

    calls = []
    await run('user_prompt', { prompt: loop, origin: TYPED })
    assert.deepEqual(calls.map(call => call.name), ['report_pickup', 'post_session_message', 'heartbeat_connection'])
    assert.deepEqual(calls[1].args, { message: loop, agent_name: 'Claude Code', turn_kind: 'local_prompt', connection_id: CONNECTION })
  })

  it('a prompt whose origin is unknown or missing is not shown as the owner\'s', async () => {
    for (const origin of [{ kind: 'unclassified' }, { kind: 'a-kind-added-later' }, undefined]) {
      seed()
      await run('user_prompt', { prompt: 'Continue: when CI is green, merge it', origin })
      assert.deepEqual(calls.map(call => call.name), ['heartbeat_connection'], JSON.stringify(origin))
    }
  })

  it('without a recorded attachment the turn is left as before, and Stop keeps the connection-scoped completion', async () => {
    seed({ speech_attachment_id: null, attached_at: null })
    await run('user_prompt', { prompt: 'file an item', origin: TYPED })
    assert.equal(calls.some(call => call.name === 'report_pickup'), false)
    calls = []
    await run('stop', { last_assistant_message: 'Done.' })
    assert.deepEqual(calls.find(call => call.name === 'report_complete').args, { connection_id: CONNECTION, reason: 'turn_end' })
  })
})
