/**
 * A turn Claude Code could not run tells the room, in Claude Code's own words, and
 * ends as a Stop ends it (item b6a38d81). Run: node --test hooks/scripts/turn-failure.test.mjs
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTurnFailure, turnFailureMessage } from './turn-failure.mjs'
import { markCommandsAnswered } from './mark-explicit-reply.mjs'

// The hook input Claude Code 2.1.314 sent for an invalid key, measured 2026-10-30.
const MEASURED = {
  session_id: 'f3ef3d60-26d2-496b-a616-a1cea052a652',
  hook_event_name: 'StopFailure',
  error: 'authentication_failed',
  last_assistant_message: 'Invalid API key · Fix external API key',
}

describe('parseTurnFailure', () => {
  it('reads the reason and Claude Code\'s own text from the hook input', () => {
    assert.deepEqual(parseTurnFailure(JSON.stringify(MEASURED)),
      { reason: 'authentication_failed', text: 'Invalid API key · Fix external API key', details: null })
  })

  it('is not a failure for any other event, or for input that is not JSON', () => {
    assert.equal(parseTurnFailure(JSON.stringify({ ...MEASURED, hook_event_name: 'Stop' })), null)
    assert.equal(parseTurnFailure('not json'), null)
    assert.equal(parseTurnFailure(''), null)
  })

  it('a missing reason is unknown, never a guess', () => {
    const { error: _omitted, ...input } = MEASURED
    assert.equal(parseTurnFailure(JSON.stringify(input)).reason, 'unknown')
  })
})

describe('turnFailureMessage', () => {
  it('passes Claude Code\'s text through whole and as written, never reworded', () => {
    const text = 'You\'ve hit your limit · resets 3pm (Europe/London)\n/upgrade to increase your usage limit.'
    const message = turnFailureMessage({ reason: 'rate_limit', text, details: null }, 'Claude Code')
    assert.ok(message.includes('> You\'ve hit your limit · resets 3pm (Europe/London)\n> /upgrade to increase your usage limit.'))
    assert.ok(message.startsWith('Claude Code'))
  })

  it('names the reason when Claude Code gave no text, so no failure is silent', () => {
    const message = turnFailureMessage({ reason: 'a_reason_added_later', text: null, details: null }, 'Claude Code')
    assert.ok(message.includes('`a_reason_added_later`'))
  })

  it('falls back to the details when there is no text', () => {
    const message = turnFailureMessage({ reason: 'rate_limit', text: null, details: '429 Too Many Requests' }, 'Claude Code')
    assert.ok(message.includes('> 429 Too Many Requests'))
  })
})

// The hook as Claude Code runs it: a real process, a real state file, a stub server.
describe('mirror-turn stop_failure', () => {
  const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mirror-turn.mjs')
  const CONVERSATION = 'conversation-b6a38d81'
  const CONNECTION = '11111111-1111-4111-8111-111111111111'
  const ROOM = '22222222-2222-4222-8222-222222222222'
  const COMMAND = '55555555-5555-4555-8555-555555555555'
  const MESSAGE = '66666666-6666-4666-8666-666666666666'
  const BRANDON = '44444444-4444-4444-8444-444444444444'
  let server
  let url
  let calls = []
  let refusePosts = false
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
        calls.push({ name, args })
        const refused = name === 'post_session_message' && refusePosts
        const result = name === 'report_request'
          ? { outcome: 'committed', request_id: args.request_id, status: args.action === 'open' ? 'open' : 'closed', requested_by_user_id: BRANDON }
          : { ok: true }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {
          content: [{ type: 'text', text: refused ? 'Connection is not attached to a room.' : JSON.stringify(result) }],
          ...(refused ? { isError: true } : {}),
        } }))
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${server.address().port}/api/mcp`
  })
  after(() => server.close())

  function seed() {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-turn-failure-'))
    connections = path.join(home, '.devspec', 'remote-control', 'connections')
    fs.mkdirSync(connections, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(connections, `${CONNECTION}.json`), JSON.stringify({
      connection_id: CONNECTION, session_id: ROOM, connection_capability: 'dvsc_hidden',
      enabled: true, agent_name: 'Claude Code', local_id: CONVERSATION, token: 'dvs_test', mcp_url: url,
    }), { mode: 0o600 })
    fs.writeFileSync(path.join(connections, `${CONNECTION}.wait.pid`), String(process.pid), { mode: 0o600 })
    // The poller opened Brandon's room command ahead of its wake.
    fs.writeFileSync(path.join(connections, `${CONNECTION}.requests.jsonl`),
      JSON.stringify({ op: 'open', id: COMMAND, kind: 'command', message_id: MESSAGE, requested_by: BRANDON }) + '\n')
    calls = []
    refusePosts = false
  }
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
  const wakeForCommand = () => run('user_prompt', {
    prompt: `<task-notification><task-id>listener</task-id><event>{"type":"owner_message","message_id":"${MESSAGE}"}</event></task-notification>`,
    origin: { kind: 'task-notification' },
  })
  const failed = (extra = {}) => run('stop_failure', { ...MEASURED, session_id: CONVERSATION, ...extra })
  const closedRequests = () => calls.filter(call => call.name === 'report_request' && call.args.action === 'close').map(call => call.args.request_id)

  it('answers the room command in Claude Code\'s words, then ends the turn and closes the command', async () => {
    seed()
    await wakeForCommand()
    calls = []
    await failed({ last_assistant_message: 'Login expired · Please run /login' })

    const names = calls.map(call => call.name)
    const post = calls.find(call => call.name === 'post_session_message')
    assert.ok(post, 'the room was told')
    assert.equal(post.args.connection_id, CONNECTION)
    assert.equal(post.args.complete_turn, true)
    assert.ok(post.args.message.includes('> Login expired · Please run /login'))
    // Told first, so the answer is what ends the turn, not an empty completion.
    assert.ok(names.indexOf('post_session_message') < names.indexOf('report_complete'))
    assert.equal(calls.find(call => call.name === 'heartbeat_connection').args.busy, false)
    assert.deepEqual(closedRequests(), [COMMAND])
    // The module reads this to leave the turn to this hook.
    assert.ok(fs.existsSync(path.join(connections, `${CONNECTION}.stop-hook.json`)))
    assert.equal(fs.existsSync(path.join(connections, `${CONNECTION}.turn`)), false)
  })

  it('a prompt typed at this terminal is in front of its owner: nothing is posted, the turn still ends', async () => {
    seed()
    await run('user_prompt', { prompt: 'tidy the changelog', origin: { kind: 'composer' } })
    calls = []
    await failed()
    assert.equal(calls.some(call => call.name === 'post_session_message'), false)
    assert.ok(calls.some(call => call.name === 'report_complete'))
  })

  it('a command the agent answered before the failure is not answered again', async () => {
    seed()
    await wakeForCommand()
    assert.deepEqual(markCommandsAnswered(CONNECTION, { dir: connections }), [COMMAND])
    calls = []
    await failed()
    assert.equal(calls.some(call => call.name === 'post_session_message'), false)
    assert.deepEqual(closedRequests(), [COMMAND])
  })

  it('a post the room refused is not taken as an answer: the command stays open', async () => {
    seed()
    await wakeForCommand()
    calls = []
    refusePosts = true
    await failed()
    assert.ok(calls.some(call => call.name === 'post_session_message'))
    assert.deepEqual(closedRequests(), [])
  })

  it('a normal Stop posts nothing of its own', async () => {
    seed()
    await wakeForCommand()
    calls = []
    await run('stop', { hook_event_name: 'Stop', last_assistant_message: 'Done.', background_tasks: [] })
    assert.equal(calls.some(call => call.name === 'post_session_message'), false)
  })
})
