/**
 * Automatic conversational recall at the turn's tail (item 08f036e5; host delivery
 * contract 7c87f509). What these protect, each a mistake reading the code would not
 * catch:
 *
 * - which turns recall: a person's prompt and a DevSpec command, never a /loop firing,
 *   another session's message, a check job or notice, and a command once however many
 *   notifications carry it;
 * - a command cut at Claude Code's 500 characters is recalled on its whole text;
 * - DevSpec's block is passed through verbatim, a kind of card no plugin knows included;
 * - seen keys are sent, recorded only when shown, bounded, private, and cleared by
 *   compaction, so an unchanged card appears once and a new version appears again;
 * - every failure injects nothing and records nothing, inside the time limit;
 * - one prompt is recalled once when both the module and the command hook run;
 * - the token never leaves the process.
 */
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { saveLogin } from './auth-store.mjs'
import {
  classifyTurn,
  clearShownOnCompaction,
  loadRecallState,
  MODULE_STAMP_WINDOW_MS,
  parseDevspecNotification,
  recallStatePath,
  recordShown,
  runTurnRecall,
  saveRecallState,
  SEEN_MAX_BYTES,
  SEEN_MAX_ENTRIES,
  SEEN_TTL_MS,
  sweepExpiredRecallFiles,
  turnRecallUrl,
} from './turn-recall.mjs'

const SCRIPT = fileURLToPath(new URL('./turn-recall.mjs', import.meta.url))
const SERVER = 'https://api.devspecstaging.com/api/mcp'
const ENV = { CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: `${SERVER}?model_tools=heartbeat_connection` }
const CONVERSATION = 'cb68f9e2-9c97-426a-92c9-3354acdc6930'
const CONNECTION = '40fb7b3f-cfe4-4468-9485-42e7ed2ce2a3'
const ROOM = '7d6657e0-7fdc-4e89-93d4-a9da7d84ff9b'
const MESSAGE = '11111111-2222-4333-8444-555555555555'
const PROJECT = '24c4abaa-2cb9-496a-8492-cf1f1aa1090b'
const PROMPT = 'How should we retry failed webhook deliveries for the billing service?'
const HOUR = 60 * 60 * 1000

const realHome = process.env.HOME
let home
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-claude-recall-'))
  process.env.HOME = home
})
afterEach(() => {
  process.env.HOME = realHome
  fs.rmSync(home, { recursive: true, force: true })
})

function signIn(endpoint = SERVER, { tag = 'a', issuedAt = Date.now(), lifeMs = 24 * HOUR } = {}) {
  return saveLogin({
    endpoint,
    tokens: { accessToken: `oat_${tag}`, refreshToken: `rt_${tag}`, issuedAt, expiresAt: issuedAt + lifeMs },
    issuer: 'https://issuer.test',
    tokenEndpoint: 'https://issuer.test/oauth/token',
    clientId: 'claude-client',
    resource: endpoint,
  })
}

const pinned = () => ({ project_id: PROJECT, path: '/repo/.devspec/project.json' })
const remote = () => 'git@github.com:acme/billing.git'

/** A DevSpec stand-in: records each request and answers with `reply(body, n)`. */
function fakeDevspec(reply) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, headers: init.headers, body, signal: init.signal })
    const out = await reply(body, calls.length, init)
    if (out instanceof Error) throw out
    const status = out?.status ?? 200
    return { ok: status < 400, status, json: async () => out?.json ?? out }
  }
  return { calls, fetchImpl }
}

const answer = (keys, block = keys.map((k) => `- [card] ${k}`).join('\n')) => ({
  version: 1,
  formatted_block: block ? `### Project recall\n${block}` : '',
  cards: keys.map((key) => ({ dedupe_key: key, kind: key.split(':')[0] })),
  seen_keys: keys,
})

function repo() {
  const dir = path.join(home, 'repo')
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  return dir
}

function recall(overrides = {}) {
  return runTurnRecall({
    source: 'module',
    conversationId: CONVERSATION,
    text: PROMPT,
    origin: 'composer',
    cwd: repo(),
    home,
    env: ENV,
    gitRemote: remote,
    pin: pinned,
    renew: () => {},
    ...overrides,
  })
}

function ownerMessageLine(body, { id = MESSAGE } = {}) {
  return JSON.stringify({ type: 'owner_message', from: 'Ali Price', authority: 'owner', message_id: id, unread: 1, body_chars: body.length, body, envelope_id: 'e1' })
}

function notification(...lines) {
  return `<task-notification>\n<task-id>b1</task-id>\n<status>running</status>\n<summary>${lines.join('\n')}</summary>\n</task-notification>`
}

function bind({ capability = 'cap_secret', sessionId = ROOM } = {}) {
  const local = path.join(home, '.devspec', 'remote-control', 'local', 'claude-code')
  const conns = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(local, { recursive: true })
  fs.mkdirSync(conns, { recursive: true })
  fs.writeFileSync(path.join(local, `${CONVERSATION}.json`), JSON.stringify({ connection_id: CONNECTION, status: 'live', local_id: CONVERSATION }))
  fs.writeFileSync(path.join(conns, `${CONNECTION}.json`), JSON.stringify({
    connection_id: CONNECTION, enabled: true, local_id: CONVERSATION, session_id: sessionId,
    connection_capability: capability, mcp_url: SERVER, auth_source: 'env', token: 'oat_connection',
  }))
  return conns
}

describe('which turns recall', () => {
  const state = { handled_message_ids: [] }

  it('a person’s substantive prompt, typed, from Remote Control or an SDK turn', () => {
    for (const origin of ['composer', 'bridge', 'sdk']) {
      assert.deepEqual(classifyTurn({ origin, text: `  ${PROMPT}  `, state }), { recall: true, reason: 'person_prompt', query: PROMPT, messageIds: [] })
    }
  })

  it('not an acknowledgement, an empty prompt or a slash command', () => {
    assert.equal(classifyTurn({ origin: 'composer', text: 'ok do it', state }).recall, false)
    assert.equal(classifyTurn({ origin: 'composer', text: '   ', state }).recall, false)
    assert.equal(classifyTurn({ origin: 'composer', text: '/devspec:devspec.work 08f036e5 please start on this', state }).recall, false)
  })

  it('never a scheduled firing, another session, a channel or another plugin', () => {
    for (const origin of ['scheduled-trigger', 'peer', 'peer-send-message', 'channel', 'plugin', 'observer', 'unclassified']) {
      assert.equal(classifyTurn({ origin, text: PROMPT, state }).recall, false, origin)
    }
  })

  it('a DevSpec command, on its body', () => {
    const decided = classifyTurn({ origin: 'task-notification', text: notification(ownerMessageLine(PROMPT)), state })
    assert.deepEqual(decided, { recall: true, reason: 'devspec_command', query: PROMPT, messageIds: [MESSAGE] })
  })

  it('never a check job, system notice, answer or room count, nor another background job', () => {
    for (const type of ['check_job', 'system_notice', 'interaction_answer', 'room_unread', 'project_incidents']) {
      const text = notification(JSON.stringify({ type, session_id: ROOM, summary: PROMPT }))
      assert.equal(classifyTurn({ origin: 'task-notification', text, state }).recall, false, type)
    }
    assert.equal(classifyTurn({ origin: 'task-notification', text: notification(`npm test finished: ${PROMPT}`), state }).recall, false)
  })

  it('a command already recalled is not recalled again', () => {
    const decided = classifyTurn({ origin: 'task-notification', text: notification(ownerMessageLine(PROMPT)), state: { handled_message_ids: [MESSAGE] } })
    assert.equal(decided.recall, false)
    assert.equal(decided.reason, 'command_already_recalled')
  })

  it('an automation run, on its name', () => {
    const line = JSON.stringify({ type: 'automation_run', session_id: ROOM, dispatch: { automation_name: 'Nightly dependency audit and upgrade', run_id: 'r1' } })
    assert.deepEqual(classifyTurn({ origin: 'task-notification', text: notification(line), state }).query, 'Nightly dependency audit and upgrade')
  })

  it('the command hook, which cannot see the origin, reads a notification as one and anything else as a prompt', () => {
    assert.equal(classifyTurn({ origin: null, text: notification(ownerMessageLine(PROMPT)), state }).reason, 'devspec_command')
    assert.equal(classifyTurn({ origin: null, text: PROMPT, state }).reason, 'person_prompt')
  })
})

describe('a command Claude Code cut at 500 characters', () => {
  const longBody = `Please look at the billing retries. ${'The webhook retry policy needs a careful look. '.repeat(30)}`

  it('is read by its leading fields, and recalled on the whole text from the room transcript', () => {
    const cut = notification(ownerMessageLine(longBody).slice(0, 500))
    const parsed = parseDevspecNotification(cut)
    assert.equal(parsed.kind, 'command')
    assert.deepEqual(parsed.messageIds, [MESSAGE])
    assert.ok(parsed.inlineBodies[0].body.length < longBody.length)

    const conns = bind()
    const transcript = path.join(conns, `${CONNECTION}.${ROOM}.transcript.jsonl`)
    fs.writeFileSync(transcript, [
      JSON.stringify({ seq: 1, message_id: 'aaaaaaaa-2222-4333-8444-555555555555', text: 'earlier message' }),
      JSON.stringify({ seq: 2, message_id: MESSAGE, text: longBody }),
    ].join('\n') + '\n')
    const decided = classifyTurn({ origin: 'task-notification', text: cut, state: { handled_message_ids: [] }, home, transcriptFor: () => transcript })
    assert.equal(decided.query, longBody.trim())
  })

  it('falls back to the cut body when there is no transcript, and never reads a file outside the plugin’s own', () => {
    const cut = notification(ownerMessageLine(longBody).slice(0, 500))
    const outside = path.join(home, 'elsewhere.jsonl')
    fs.writeFileSync(outside, JSON.stringify({ message_id: MESSAGE, text: 'NOT THIS' }) + '\n')
    const decided = classifyTurn({ origin: 'task-notification', text: cut, state: { handled_message_ids: [] }, home, transcriptFor: () => outside })
    assert.equal(decided.recall, true)
    assert.ok(longBody.startsWith(decided.query))
  })
})

describe('one turn’s recall', () => {
  it('asks DevSpec once for this folder’s project and adds its block verbatim, a card kind no plugin knows included', async () => {
    await signIn()
    const block = '### Project recall\n- [ENVIRONMENT · staging] Staging database is shared with local dev (environment_entry:e1:v1)'
    const devspec = fakeDevspec(() => ({ ...answer(['environment_entry:e1:v1']), formatted_block: block }))
    const result = await recall({ fetchImpl: devspec.fetchImpl })

    assert.equal(result.block, block)
    assert.equal(devspec.calls.length, 1)
    const [call] = devspec.calls
    assert.equal(call.url, 'https://api.devspecstaging.com/api/mcp/turn-recall')
    assert.equal(call.headers.Authorization, 'Bearer oat_a')
    assert.match(call.headers['x-devspec-plugin'], /^claude_code\//)
    assert.equal(call.headers['x-devspec-connection-capability'], undefined)
    assert.deepEqual(call.body, {
      query: PROMPT,
      host: 'claude_code',
      conversation_id: CONVERSATION,
      pinned_project_id: PROJECT,
      git_remote: 'git@github.com:acme/billing.git',
      seen_versions: [],
    })
  })

  it('shows an unchanged card once and a new version of it again', async () => {
    await signIn()
    const devspec = fakeDevspec((body, n) => {
      if (n === 1) return answer(['memory:m1:v1', 'requirement:r1:v3'])
      // DevSpec leaves out what the conversation has seen; here the memory was edited.
      if (n === 2) return body.seen_versions.includes('memory:m1:v1') ? answer(['memory:m1:v2']) : answer(['memory:m1:v1'])
      return answer([])
    })
    assert.ok((await recall({ fetchImpl: devspec.fetchImpl })).block)
    const second = await recall({ fetchImpl: devspec.fetchImpl, now: Date.now() + 60_000 })
    assert.match(second.block, /memory:m1:v2/)
    assert.deepEqual(devspec.calls[1].body.seen_versions, ['memory:m1:v1', 'requirement:r1:v3'])
    const third = await recall({ fetchImpl: devspec.fetchImpl, now: Date.now() + 120_000 })
    assert.equal(third.block, null)
    assert.deepEqual(devspec.calls[2].body.seen_versions.sort(), ['memory:m1:v1', 'memory:m1:v2', 'requirement:r1:v3'])
  })

  it('injects nothing when nothing qualifies, and records nothing', async () => {
    await signIn()
    const devspec = fakeDevspec(() => answer([]))
    assert.equal((await recall({ fetchImpl: devspec.fetchImpl })).block, null)
    assert.deepEqual(loadRecallState(CONVERSATION, { home }).entries, [])
  })

  for (const [name, reply] of [
    ['DevSpec is unreachable', () => new TypeError('fetch failed')],
    ['DevSpec fails', () => ({ status: 503, json: { code: 'auth_validation_unavailable' } })],
    ['DevSpec refuses the sign-in', () => ({ status: 401, json: { code: 'invalid_api_token' } })],
  ]) {
    it(`fails open when ${name}: nothing injected, nothing recorded`, async () => {
      await signIn()
      const devspec = fakeDevspec(reply)
      assert.equal((await recall({ fetchImpl: devspec.fetchImpl })).block, null)
      const state = loadRecallState(CONVERSATION, { home })
      assert.deepEqual(state.entries, [])
      assert.deepEqual(state.scope_misses, [])
    })
  }

  it('gives up at its time limit and lets the prompt through', async () => {
    await signIn()
    const devspec = fakeDevspec((body, n, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
    }))
    const started = Date.now()
    const result = await recall({ fetchImpl: devspec.fetchImpl, timeoutMs: 150 })
    assert.equal(result.block, null)
    assert.ok(Date.now() - started < 1_000)
    assert.deepEqual(loadRecallState(CONVERSATION, { home }).entries, [])
  })

  it('does not ask again for a folder DevSpec found no project for, and asks for a different one', async () => {
    await signIn()
    const devspec = fakeDevspec(() => ({ status: 400, json: { code: 'project_required' } }))
    await recall({ fetchImpl: devspec.fetchImpl })
    await recall({ fetchImpl: devspec.fetchImpl })
    assert.equal(devspec.calls.length, 1)
    await recall({ fetchImpl: devspec.fetchImpl, pin: () => ({ project_id: '99999999-2cb9-496a-8492-cf1f1aa1090b' }) })
    assert.equal(devspec.calls.length, 2)
  })

  it('asks again after a refusal that is not about the folder’s project', async () => {
    await signIn()
    const devspec = fakeDevspec(() => ({ status: 400, json: { code: 'project_selection_unavailable' } }))
    await recall({ fetchImpl: devspec.fetchImpl })
    await recall({ fetchImpl: devspec.fetchImpl })
    assert.equal(devspec.calls.length, 2)
  })

  it('makes no call when nothing names a project, or when signed out', async () => {
    const devspec = fakeDevspec(() => answer(['memory:m1:v1']))
    assert.equal((await recall({ fetchImpl: devspec.fetchImpl })).reason, 'signed_out')
    assert.equal(fs.existsSync(recallStatePath(CONVERSATION, home)), false, 'nothing is written for someone not signed in')
    await signIn()
    assert.equal((await recall({ fetchImpl: devspec.fetchImpl, pin: () => null, gitRemote: () => null })).reason, 'no_project')
    assert.equal(devspec.calls.length, 0)
  })

  it('reads a sign-in past half its life without renewing it here, and leaves the renewal to its own process', async () => {
    await signIn(SERVER, { issuedAt: Date.now() - 20 * HOUR })
    const renewals = []
    const devspec = fakeDevspec(() => answer(['memory:m1:v1']))
    const result = await recall({ fetchImpl: devspec.fetchImpl, renew: (server) => renewals.push(server) })
    assert.ok(result.block)
    assert.deepEqual(renewals, [SERVER])
    assert.equal(devspec.calls[0].headers.Authorization, 'Bearer oat_a')
  })

  it('skips a sign-in that has expired, and starts its renewal', async () => {
    await signIn(SERVER, { issuedAt: Date.now() - 30 * HOUR })
    const renewals = []
    const devspec = fakeDevspec(() => answer(['memory:m1:v1']))
    assert.equal((await recall({ fetchImpl: devspec.fetchImpl, renew: (server) => renewals.push(server) })).reason, 'signed_out')
    assert.equal(devspec.calls.length, 0)
    assert.equal(renewals.length, 1)
  })

  it('in a connected conversation, speaks for the connection: its capability, its room, its credential', async () => {
    bind()
    const devspec = fakeDevspec(() => answer(['document:d1:v4']))
    const result = await recall({ fetchImpl: devspec.fetchImpl, pin: () => null, gitRemote: () => null })
    assert.ok(result.block)
    const [call] = devspec.calls
    assert.equal(call.headers['x-devspec-connection-capability'], 'cap_secret')
    assert.equal(call.headers.Authorization, 'Bearer oat_connection')
    assert.equal(call.body.connection_id, CONNECTION)
    assert.equal(call.body.session_id, ROOM)
    assert.equal(call.body.pinned_project_id, undefined)
  })

  it('recalls a DevSpec command once, however many notifications carry it', async () => {
    bind()
    const devspec = fakeDevspec(() => answer(['memory:m1:v1']))
    const text = notification(ownerMessageLine(PROMPT))
    assert.ok((await recall({ fetchImpl: devspec.fetchImpl, origin: 'task-notification', text })).block)
    assert.equal((await recall({ fetchImpl: devspec.fetchImpl, origin: 'task-notification', text })).reason, 'command_already_recalled')
    assert.equal(devspec.calls.length, 1)
    assert.equal(devspec.calls[0].body.query, PROMPT)
  })
})

describe('one prompt, one recall, when both hooks run', () => {
  it('the command hook stands down when the module just handled the prompt', async () => {
    await signIn()
    const devspec = fakeDevspec(() => answer(['memory:m1:v1']))
    const now = Date.now()
    await recall({ fetchImpl: devspec.fetchImpl, now })
    const fallback = await recall({ source: 'command_hook', origin: undefined, fetchImpl: devspec.fetchImpl, now: now + 2_000 })
    assert.equal(fallback.reason, 'handled_by_module')
    assert.equal(devspec.calls.length, 1)
  })

  it('a scheduled firing the module skipped is not recalled by the command hook either', async () => {
    await signIn()
    const devspec = fakeDevspec(() => answer(['memory:m1:v1']))
    const now = Date.now()
    assert.equal((await recall({ origin: 'scheduled-trigger', fetchImpl: devspec.fetchImpl, now })).block, null)
    assert.equal((await recall({ source: 'command_hook', fetchImpl: devspec.fetchImpl, now: now + 50 })).reason, 'handled_by_module')
    assert.equal(devspec.calls.length, 0)
  })

  it('on a build with no hooks module, the command hook recalls', async () => {
    await signIn()
    const devspec = fakeDevspec((body) => answer(['memory:m1:v1'].filter((key) => !body.seen_versions.includes(key))))
    const now = Date.now()
    await recall({ fetchImpl: devspec.fetchImpl, now })
    const later = await recall({ source: 'command_hook', fetchImpl: devspec.fetchImpl, now: now + MODULE_STAMP_WINDOW_MS + 1, text: `${PROMPT} And the refunds?` })
    assert.equal(devspec.calls.length, 2)
    assert.equal(later.block, null, 'the memory was already shown')
    assert.deepEqual(devspec.calls[1].body.seen_versions, ['memory:m1:v1'])
  })
})

describe('the conversation’s seen cards', () => {
  it('are private: 0600 in a 0700 directory', async () => {
    await signIn()
    await recall({ fetchImpl: fakeDevspec(() => answer(['memory:m1:v1'])).fetchImpl })
    const file = recallStatePath(CONVERSATION, home)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
  })

  it('keep the newest 512 keys inside 32 KB', () => {
    const state = loadRecallState(CONVERSATION, { home })
    const keys = Array.from({ length: 900 }, (_, i) => `memory:${String(i).padStart(8, '0')}-2cb9-496a-8492-cf1f1aa1090b:v1`)
    saveRecallState(recordShown(state, keys), { home })
    const saved = loadRecallState(CONVERSATION, { home })
    assert.ok(saved.entries.length <= SEEN_MAX_ENTRIES)
    assert.ok(fs.statSync(recallStatePath(CONVERSATION, home)).size <= SEEN_MAX_BYTES)
    assert.equal(saved.entries.at(-1).key, keys.at(-1))
  })

  it('are cleared by compaction, so the cards can be shown again', async () => {
    await signIn()
    await recall({ fetchImpl: fakeDevspec(() => answer(['memory:m1:v1'])).fetchImpl })
    assert.equal(clearShownOnCompaction(CONVERSATION, { home }), true)
    assert.deepEqual(loadRecallState(CONVERSATION, { home }).entries, [])
  })

  it('of conversations untouched for 30 days are swept away', () => {
    saveRecallState(loadRecallState('old-conversation', { home }), { home })
    const old = recallStatePath('old-conversation', home)
    const stale = (Date.now() - SEEN_TTL_MS - HOUR) / 1000
    fs.utimesSync(old, stale, stale)
    saveRecallState(loadRecallState(CONVERSATION, { home }), { home })
    assert.equal(fs.existsSync(old), false)
    assert.equal(sweepExpiredRecallFiles({ home }), 0)
  })

  it('an unreadable file is a fresh start, never a skipped turn', async () => {
    await signIn()
    fs.mkdirSync(path.dirname(recallStatePath(CONVERSATION, home)), { recursive: true })
    fs.writeFileSync(recallStatePath(CONVERSATION, home), '{not json', { mode: 0o600 })
    assert.ok((await recall({ fetchImpl: fakeDevspec(() => answer(['memory:m1:v1'])).fetchImpl })).block)
  })
})

describe('the script, as Claude Code runs it', () => {
  function serve(handler) {
    return new Promise((resolve) => {
      const requests = []
      const server = http.createServer((req, res) => {
        let raw = ''
        req.on('data', (chunk) => { raw += chunk })
        req.on('end', () => {
          requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') })
          handler(req, res)
        })
      })
      server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/api/mcp` }))
    })
  }

  function run(args, input, env) {
    return new Promise((resolve) => {
      const started = Date.now()
      const child = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, HOME: home, ...env }, cwd: home })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }))
      child.stdin.end(JSON.stringify(input))
    })
  }

  function pinProject() {
    fs.mkdirSync(path.join(home, 'repo', '.git'), { recursive: true })
    fs.mkdirSync(path.join(home, 'repo', '.devspec'), { recursive: true })
    fs.writeFileSync(path.join(home, 'repo', '.devspec', 'project.json'), JSON.stringify({ project_id: PROJECT }))
  }

  it('adds the block as context, and the token appears nowhere in what it prints', async () => {
    const devspec = await serve((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(answer(['requirement:r1:v1'])))
    })
    try {
      await signIn(devspec.url, { tag: 'cli-secret' })
      pinProject()
      const env = { CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: devspec.url }
      const out = await new Promise((resolve) => {
        const child = spawn(process.execPath, [SCRIPT, 'prompt-submit'], { env: { PATH: process.env.PATH, HOME: home, ...env }, cwd: path.join(home, 'repo') })
        let stdout = ''
        child.stdout.on('data', (chunk) => { stdout += chunk })
        child.on('close', (code) => resolve({ code, stdout }))
        child.stdin.end(JSON.stringify({ conversation_id: CONVERSATION, text: PROMPT, origin: 'composer' }))
      })
      assert.equal(out.code, 0)
      assert.match(JSON.parse(out.stdout).context, /requirement:r1:v1/)
      assert.doesNotMatch(out.stdout, /oat_cli-secret/)
      assert.equal(devspec.requests[0].url, '/api/mcp/turn-recall')
      assert.equal(devspec.requests[0].headers.authorization, 'Bearer oat_cli-secret')
      assert.equal(devspec.requests[0].body.pinned_project_id, PROJECT)

      const fallback = await run(['user-prompt-submit'], { session_id: CONVERSATION, prompt: PROMPT, cwd: path.join(home, 'repo') }, env)
      assert.deepEqual(JSON.parse(fallback.stdout), {}, 'the module handled this prompt')
      assert.equal(devspec.requests.length, 1)
    } finally {
      devspec.server.close()
    }
  })

  it('answers the command hook in its own shape', async () => {
    const devspec = await serve((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(answer(['memory:m9:v1'])))
    })
    try {
      await signIn(devspec.url)
      pinProject()
      const out = await run(['user-prompt-submit'], { session_id: CONVERSATION, prompt: PROMPT, cwd: path.join(home, 'repo') }, { CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: devspec.url })
      const parsed = JSON.parse(out.stdout)
      assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
      assert.match(parsed.hookSpecificOutput.additionalContext, /memory:m9:v1/)
    } finally {
      devspec.server.close()
    }
  })

  it('exits with nothing at its own deadline when DevSpec never answers', async () => {
    const devspec = await serve(() => { /* never answers */ })
    try {
      await signIn(devspec.url)
      pinProject()
      const out = await run(['prompt-submit'], { conversation_id: CONVERSATION, text: PROMPT, origin: 'composer' }, { CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: devspec.url })
      assert.equal(out.code, 0)
      assert.deepEqual(JSON.parse(out.stdout), {})
      assert.ok(out.ms < 4_000, `took ${out.ms} ms`)
      assert.deepEqual(loadRecallState(CONVERSATION, { home }).entries, [])
    } finally {
      devspec.server.closeAllConnections?.()
      devspec.server.close()
    }
  })

  it('clears the seen cards on a compaction start, and only then', async () => {
    saveRecallState(recordShown(loadRecallState(CONVERSATION, { home }), ['memory:m1:v1']), { home })
    await run(['compacted'], { session_id: CONVERSATION, source: 'resume' }, {})
    assert.equal(loadRecallState(CONVERSATION, { home }).entries.length, 1)
    const out = await run(['compacted'], { session_id: CONVERSATION, source: 'compact' }, {})
    assert.deepEqual(JSON.parse(out.stdout), {})
    assert.equal(loadRecallState(CONVERSATION, { home }).entries.length, 0)
  })
})

describe('the endpoint', () => {
  it('sits beside the MCP endpoint, without its query', () => {
    assert.equal(turnRecallUrl('https://api.devspec.ai/api/mcp?model_tools=heartbeat_connection'), 'https://api.devspec.ai/api/mcp/turn-recall')
    assert.equal(turnRecallUrl('not a url'), null)
  })
})
