#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  managePollRequestOptions,
  readPollConnectionState,
  validateManagePollArguments,
} from './devspec-poll.mjs'
import { mcpToolsCall, mcpToolsList } from './mcp-call.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const CONNECTION = '10000000-0000-4000-8000-000000000001'
const POLL = '30000000-0000-4000-8000-000000000003'
const REQUEST = '40000000-0000-4000-8000-000000000004'

function source(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

describe('Claude session-poll policy surfaces (item f4dd7be1)', () => {
  const skill = source('skills/devspec-session-poll/SKILL.md')
  const remote = source('commands/devspec.remote.md')

  it('is reachable: the tool is allow-listed and the skill names the bridge', () => {
    assert.match(remote.match(/^allowed-tools: (.+)$/m)?.[1] ?? '', /mcp__devspec__manage_poll/)
    assert.match(skill, /devspec-poll\.mjs" describe/)
    assert.match(skill, /devspec-poll\.mjs" use/)
    assert.match(skill.match(/^allowed-tools: (.+)$/m)?.[1] ?? '', /mcp__devspec__manage_poll/)
  })

  it('models the PLAN bridge, not the question one: no turn, wake or reply machinery', () => {
    // The brief is explicit that a poll is not a blocking agent driver. Forbid the
    // MECHANISM identifiers rather than the words: saying a poll opens no reply channel
    // is useful, but naming an argument or verb that only exists for questions means
    // someone copied the wrong precedent.
    for (const forbidden of [/awaiting_input/, /keep_turn/, /complete_turn/,
      /question_answer/, /devspec-question\.mjs/, /respond --connection-id/]) {
      assert.doesNotMatch(skill, forbidden, `poll skill must not carry ${forbidden}`)
    }
    // And it must say plainly that it does not block, since that is the whole confusion
    // this skill exists to prevent.
    // \s+ throughout: this file is prose and wraps, so a phrase can straddle a newline.
    assert.match(skill, /holds\s+no\s+turn/i)
    assert.match(skill, /no\s+vote\s+action/i)
    assert.match(skill, /leaves\s+the\s+room's\s+Working\s+state\s+exactly\s+as\s+it\s+was/i)
    // A poll asks the room; one person's decision is the question tool's job.
    assert.match(skill, /devspec-directed-question/)
  })

  it('keeps discovery small enough to load without thinking about it', () => {
    assert.ok(Buffer.byteLength(skill) < 3_000, `skill is ${Buffer.byteLength(skill)} bytes`)
  })
})

describe('manage_poll client guard (item f4dd7be1)', () => {
  it('accepts the seven server actions and refuses anything else', () => {
    assert.equal(validateManagePollArguments({ action: 'list' }).ok, true)
    assert.equal(validateManagePollArguments({ action: 'get', poll_id: POLL }).ok, true)
    for (const action of ['vote', 'answer', 'cancel', 'advance', '', undefined]) {
      assert.equal(validateManagePollArguments({ action }).ok, false, String(action))
    }
  })

  it('requires the poll identity AND its revision for every existing-poll mutation', () => {
    for (const action of ['update', 'end', 'retract', 'supersede']) {
      const base = { action, poll_id: POLL, expected_revision: 2 }
      if (action === 'retract') base.reason = 'superseded by a decision'
      if (action === 'supersede') {
        base.client_request_id = REQUEST
        base.question = 'Which one now?'
        base.options = ['A', 'B']
      }
      assert.equal(validateManagePollArguments(base).ok, true, action)
      const { expected_revision: _revision, ...noRevision } = base
      assert.equal(validateManagePollArguments(noRevision).ok, false, `${action} without revision`)
      const { poll_id: _id, ...noId } = base
      assert.equal(validateManagePollArguments(noId).ok, false, `${action} without poll_id`)
    }
    // A revision on something that has no poll yet is a sign of a confused caller.
    assert.equal(validateManagePollArguments({
      action: 'create', question: 'Q', options: ['A', 'B'], client_request_id: REQUEST, expected_revision: 1,
    }).ok, false)
  })

  it('refuses caller identity and provenance arguments outright', () => {
    // The whole point of the bridge: identity is server-derived, so these are not
    // properties this tool has, and a model that invents one gets a local error.
    for (const key of [
      'connection_id', 'session_id', 'owner_user_id', 'project_id', 'responder_user_id',
      'git_remote', 'runner_session_id', 'provenance_ref', 'work_claim_ref',
      'connection_capability', 'capability', 'token', 'vote', 'votes', 'arbitrary',
    ]) {
      assert.equal(validateManagePollArguments({ action: 'list', [key]: 'forged' }).ok, false, key)
    }
  })

  it('holds the server contract on create, retract and series', () => {
    const create = { action: 'create', question: 'Ship tonight?', options: ['Yes', 'No'], client_request_id: REQUEST }
    assert.equal(validateManagePollArguments(create).ok, true)
    // Retry idempotency is the caller's job on the two actions that mint a poll.
    const { client_request_id: _rid, ...noRequestId } = create
    assert.equal(validateManagePollArguments(noRequestId).ok, false)
    assert.equal(validateManagePollArguments({ ...create, options: ['Only one'] }).ok, false)
    assert.equal(validateManagePollArguments({
      ...create, options: Array.from({ length: 31 }, (_, i) => `Option ${i}`),
    }).ok, false)
    assert.equal(validateManagePollArguments({ ...create, options: ['Yes', '  '] }).ok, false)
    assert.equal(validateManagePollArguments({ action: 'create', options: ['A', 'B'], client_request_id: REQUEST }).ok, false)
    // retract must say why; a silent retraction is indistinguishable from a bug.
    assert.equal(validateManagePollArguments({ action: 'retract', poll_id: POLL, expected_revision: 1 }).ok, false)
    // A grouping id without its label produces a half-formed series in the room.
    assert.equal(validateManagePollArguments({ ...create, series_id: POLL }).ok, false)
    assert.equal(validateManagePollArguments({ ...create, series_id: POLL, series_label: 'Launch' }).ok, true)
    assert.equal(validateManagePollArguments({ action: 'list', status: 'active' }).ok, true)
    assert.equal(validateManagePollArguments({ action: 'list', status: 'closed' }).ok, false)
    assert.equal(validateManagePollArguments({ ...create, multi_select: 'yes' }).ok, false)
  })

  it('treats recommendation_index as an option index, not a ballot', () => {
    const create = { action: 'create', question: 'Q', options: ['A', 'B'], client_request_id: REQUEST }
    assert.equal(validateManagePollArguments({ ...create, recommendation_index: 1 }).ok, true)
    assert.equal(validateManagePollArguments({ ...create, recommendation_index: 2 }).ok, false)
    assert.equal(validateManagePollArguments({ ...create, recommendation_index: -1 }).ok, false)
    assert.equal(validateManagePollArguments({ ...create, recommendation_index: 1.5 }).ok, false)
    // Without options in the same call there is nothing to bound it against, so it passes
    // here and the server decides.
    assert.equal(validateManagePollArguments({
      action: 'update', poll_id: POLL, expected_revision: 3, recommendation_index: 9,
    }).ok, true)
  })

  it('loads only an attached, enabled, capability-bound connection', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-poll-state-'))
    try {
      const state = {
        enabled: true,
        connection_id: CONNECTION,
        session_id: '20000000-0000-4000-8000-000000000002',
        token: 'dvs_token',
        mcp_url: 'http://localhost/mcp',
        connection_capability: 'dvsc_secret',
      }
      const statePath = path.join(dir, `${CONNECTION}.json`)
      fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o644 })
      assert.deepEqual(readPollConnectionState(CONNECTION, dir), state)
      // Reading repairs a loose mode before any byte is used.
      assert.equal(fs.statSync(statePath).mode & 0o777, 0o600)
      assert.deepEqual(managePollRequestOptions(state), {
        mcpUrl: state.mcp_url,
        token: state.token,
        connectionCapability: state.connection_capability,
        timeoutMs: 30_000,
      })
      for (const [patch, pattern] of [
        [{ session_id: null }, /attached/],
        [{ enabled: false }, /disabled/],
        [{ connection_capability: null }, /capability/],
        [{ token: null }, /authentication/],
      ]) {
        fs.writeFileSync(statePath, JSON.stringify({ ...state, ...patch }))
        assert.throws(() => readPollConnectionState(CONNECTION, dir), pattern, JSON.stringify(patch))
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('manage_poll describe/use reachability', () => {
  it('describes and invokes manage_poll with the hidden header, exposing no pump verb', async () => {
    const requests = []
    const server = http.createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body)
        requests.push({ parsed, capability: request.headers['x-devspec-connection-capability'] })
        const result = parsed.method === 'tools/list'
          ? {
              tools: [{
                name: 'manage_poll',
                description: 'Manage this connection\'s shared session poll.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    action: { type: 'string', enum: ['create', 'list', 'get', 'update', 'end', 'retract', 'supersede'] },
                    poll_id: { type: 'string' }, expected_revision: { type: 'number' },
                    client_request_id: { type: 'string' }, question: { type: 'string' },
                    options: { type: 'array' }, recommendation_index: { type: 'number' },
                    multi_select: { type: 'boolean' }, allow_write_in: { type: 'boolean' },
                    series_id: { type: 'string' }, series_label: { type: 'string' },
                    reason: { type: 'string' }, status: { type: 'string' },
                  },
                  required: ['action'],
                },
              }],
            }
          : {
              content: [{ type: 'text', text: JSON.stringify({ poll: { revision: 5 } }) }],
              _meta: { devspec: { connection_capability: { version: 1, value: 'dvsc_rotated' } } },
            }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const options = {
        mcpUrl: `http://127.0.0.1:${server.address().port}`,
        token: 'dvs_test',
        connectionCapability: 'dvsc_hidden',
      }
      const tools = await mcpToolsList(options)
      assert.deepEqual(tools.map((tool) => tool.name), ['manage_poll'])
      assert.ok(JSON.stringify(tools[0]).length < 2_100, 'manage_poll discovery must stay bounded')
      const properties = tools[0].inputSchema.properties
      for (const property of ['poll_id', 'expected_revision', 'client_request_id',
        'recommendation_index', 'allow_write_in', 'series_label']) {
        assert.ok(Object.hasOwn(properties, property), `missing ${property}`)
      }
      let hiddenMeta = null
      const result = await mcpToolsCall({
        ...options,
        name: 'manage_poll',
        arguments: { action: 'end', poll_id: POLL, expected_revision: 4 },
        onResultMeta: (meta) => { hiddenMeta = meta },
      })
      assert.equal(result.poll.revision, 5)
      // The rotated capability reaches the host and never the model-visible result.
      assert.equal(hiddenMeta.devspec.connection_capability.value, 'dvsc_rotated')
      assert.doesNotMatch(JSON.stringify(result), /dvsc_rotated/)
      // Every request carried the hidden header.
      assert.ok(requests.length >= 2)
      for (const entry of requests) {
        assert.equal(entry.capability, 'dvsc_hidden')
      }
    } finally {
      server.close()
    }
  })
})
