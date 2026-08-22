#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  managePlanRequestOptions,
  readPlanConnectionState,
  validateManagePlanArguments,
} from './devspec-plan.mjs'
import { mcpToolsCall, mcpToolsList } from './mcp-call.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const STATE_SCRIPT = path.join(HERE, 'remote-control-state.mjs')
const CONNECTION = '10000000-0000-4000-8000-000000000001'

function source(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

describe('Claude shared-plan policy surfaces', () => {
  const skill = source('skills/devspec-session-plan/SKILL.md')
  const remote = source('commands/devspec.remote.md')

  it('supports attended and remote use while routine read-only investigation never plans', () => {
    assert.match(skill, /Routine read-only investigation never warrants a plan/)
    assert.match(remote, /Routine read-only investigation never warrants a plan/)
    assert.match(remote.match(/^allowed-tools: (.+)$/m)?.[1] ?? '', /mcp__devspec__manage_plan/)
    assert.match(skill, /describe\/use bridge/)
    assert.match(remote, /remote-control-state\.mjs" status/)
    assert.doesNotMatch(remote, /read `~\/\.devspec\/remote-control\/connections/)
  })

  it('creates once, advances atomically, resumes, and explicitly closes', () => {
    assert.match(skill, /create one plan once/)
    assert.match(skill, /atomically completes the current milestone/)
    assert.match(skill, /latest active-plan projection/)
    assert.match(skill, /explicitly: `complete`[\s\S]*`abandon`/)
  })

  it('keeps room awareness read-only and requires revisioned adoption/cross-plan targeting', () => {
    assert.match(skill, /advisory read-awareness only/)
    assert.match(skill, /Cross-plan work and `adopt` also require explicit `plan_id`/)
    assert.match(skill, /orphaned same-owner plan/)
  })

  it('does not let plans become claim or provenance evidence', () => {
    assert.match(skill, /outside action-item mutation claim enforcement/)
    assert.match(skill, /cannot create claim\/provenance evidence/)
    for (const operation of ['reserve_work_items', 'claim_work_item', 'record_implementation']) {
      assert.match(skill, new RegExp(operation))
    }
  })

  it('keeps idle discovery unchanged and bounds the on-demand skill footprint', () => {
    const hooks = JSON.parse(source('hooks/hooks.json'))
    const sessionStart = JSON.stringify(hooks.hooks.SessionStart)
    assert.doesNotMatch(sessionStart, /manage_plan|active_session_plans/)
    assert.ok(Buffer.byteLength(remote) < 15_000, `remote command is ${Buffer.byteLength(remote)} bytes`)
    assert.ok(Buffer.byteLength(skill) < 3_200, `on-demand skill is ${Buffer.byteLength(skill)} bytes`)
  })
})

describe('manage_plan client guard', () => {
  it('requires atomic existing-plan revisions and explicit adoption targets', () => {
    assert.equal(validateManagePlanArguments({ action: 'advance', expected_revision: 3 }).ok, true)
    assert.equal(validateManagePlanArguments({ action: 'advance' }).ok, false)
    assert.equal(validateManagePlanArguments({ action: 'adopt', expected_revision: 3 }).ok, false)
    assert.equal(validateManagePlanArguments({ action: 'adopt', plan_id: 'p', expected_revision: 3 }).ok, true)
  })

  it('allows room reads but rejects caller identity and provenance arguments', () => {
    assert.equal(validateManagePlanArguments({ action: 'list' }).ok, true)
    assert.equal(validateManagePlanArguments({ action: 'get', plan_id: 'other-owner' }).ok, true)
    for (const key of [
      'connection_id', 'owner_user_id', 'steward_connection_id', 'project_id',
      'git_remote', 'runner_session_id', 'provenance_ref', 'work_claim_ref',
      'connection_capability', 'capability', 'claim_id', 'token', 'arbitrary',
    ]) {
      assert.equal(validateManagePlanArguments({ action: 'list', [key]: 'forged' }).ok, false)
    }
    assert.equal(validateManagePlanArguments({
      action: 'create',
      steps: [{ title: 'Safe', connection_id: 'forged' }],
    }).ok, false)
  })

  it('loads only an attached enabled capability-bound connection', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-plan-state-'))
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
      assert.deepEqual(readPlanConnectionState(CONNECTION, dir), state)
      assert.equal(fs.statSync(statePath).mode & 0o777, 0o600)
      assert.deepEqual(managePlanRequestOptions(state), {
        mcpUrl: state.mcp_url,
        token: state.token,
        connectionCapability: state.connection_capability,
        timeoutMs: 30_000,
      })
      fs.writeFileSync(path.join(dir, `${CONNECTION}.json`), JSON.stringify({ ...state, session_id: null }))
      assert.throws(() => readPlanConnectionState(CONNECTION, dir), /attached/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('status/read repairs legacy mode and never prints authentication material', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-redacted-status-'))
    const dir = path.join(home, '.devspec', 'remote-control', 'connections')
    fs.mkdirSync(dir, { recursive: true })
    const statePath = path.join(dir, `${CONNECTION}.json`)
    fs.writeFileSync(statePath, JSON.stringify({
      connection_id: CONNECTION,
      session_id: '20000000-0000-4000-8000-000000000002',
      enabled: true,
      owner_pid: process.pid,
      token: 'dvs_stdout_forbidden',
      connection_capability: 'dvsc_stdout_forbidden',
    }), { mode: 0o644 })
    try {
      for (const command of ['status', 'read']) {
        const child = spawnSync(process.execPath, [
          STATE_SCRIPT,
          command,
          '--connection-id', CONNECTION,
        ], { encoding: 'utf8', env: { ...process.env, HOME: home } })
        assert.equal(child.status, 0, child.stderr)
        assert.doesNotMatch(child.stdout, /dvs_stdout_forbidden|dvsc_stdout_forbidden/)
        const publicStatus = JSON.parse(child.stdout)
        assert.equal(publicStatus.connection_capability_present, true)
        assert.equal(publicStatus.reconnect.disposition, 'reconnect')
      }
      assert.equal(fs.statSync(statePath).mode & 0o777, 0o600)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('schema-complete MCP describe/use reachability', () => {
  it('describes and invokes manage_plan with the hidden header and exposes no pump verb', async () => {
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
                name: 'manage_plan',
                description: 'Manage the authenticated connection shared plan.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    action: { type: 'string', enum: ['create', 'list', 'get', 'update', 'start_step', 'complete_step', 'skip_step', 'fail_step', 'advance', 'complete', 'abandon', 'adopt'] },
                    plan_id: { type: 'string' }, expected_revision: { type: 'number' },
                    title: { type: 'string' }, steps: { type: 'array' }, step_id: { type: 'string' },
                    current_step_id: { type: 'string' }, next_step_id: { type: 'string' },
                    reason: { type: 'string' }, retryable: { type: 'boolean' },
                  },
                  required: ['action'],
                },
              }],
            }
          : {
              content: [{ type: 'text', text: JSON.stringify({ plan: { revision: 4 } }) }],
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
      assert.deepEqual(tools.map((tool) => tool.name), ['manage_plan'])
      assert.ok(JSON.stringify(tools[0]).length < 2_100, 'manage_plan discovery must stay bounded')
      const properties = tools[0].inputSchema.properties
      for (const property of ['expected_revision', 'current_step_id', 'next_step_id', 'retryable']) {
        assert.ok(Object.hasOwn(properties, property), `missing ${property}`)
      }
      let hiddenMeta = null
      const result = await mcpToolsCall({
        ...options,
        name: 'manage_plan',
        arguments: { action: 'advance', expected_revision: 3 },
        onResultMeta: (meta) => { hiddenMeta = meta },
      })
      assert.equal(result.plan.revision, 4)
      assert.equal(hiddenMeta.devspec.connection_capability.value, 'dvsc_rotated')
      assert.doesNotMatch(JSON.stringify(result), /dvsc_rotated/)
      assert.deepEqual(requests.map((entry) => entry.parsed.method), ['tools/list', 'tools/call'])
      assert.deepEqual(requests.map((entry) => entry.capability), ['dvsc_hidden', 'dvsc_hidden'])
      assert.equal(requests[1].parsed.params.name, 'manage_plan')
      assert.doesNotMatch(JSON.stringify(tools), /poll_connection|heartbeat_connection|get_connection_dispatch/)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
