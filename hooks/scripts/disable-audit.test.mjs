/**
 * A connection that goes offline must say who asked (item 37d6e6e0).
 *
 * On 2026-09-19 a live connection was disabled and its poller killed. The poll
 * log stopped mid-normal-operation, the state file said `local_stop`, and there
 * was nothing anywhere to say what had done it. The agent read `local_stop` as a
 * human pressing stop — which is exactly what it looks like — and stood down.
 *
 * The bug being guarded is not the kill. It is that a kill and a deliberate stop
 * were indistinguishable, so the incident could not be investigated at all.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { installExitAudit } from './devspec-remote-poll.mjs'

const STATE_SCRIPT = fileURLToPath(new URL('./remote-control-state.mjs', import.meta.url))
const CONN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

let home
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-disable-audit-'))
})
afterEach(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
})

function connectionsDir() {
  return path.join(home, '.devspec', 'remote-control', 'connections')
}

function seedLiveConnection({ localId = null, agent = 'Claude Code', mcpUrl = null } = {}) {
  const dir = connectionsDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${CONN}.json`),
    JSON.stringify({
      connection_id: CONN,
      enabled: true,
      agent_name: agent,
      local_id: localId,
      token: 'dvs_test',
      ...(mcpUrl ? { mcp_url: mcpUrl } : {}),
    }),
    { mode: 0o600 },
  )
  if (localId) {
    const bondDir = path.join(home, '.devspec', 'remote-control', 'local', 'claude-code')
    fs.mkdirSync(bondDir, { recursive: true })
    fs.writeFileSync(
      path.join(bondDir, `${localId}.json`),
      JSON.stringify({ connection_id: CONN, agent_name: agent, local_id: localId, status: 'live' }),
      { mode: 0o600 },
    )
  }
}

function auditLines() {
  const p = path.join(connectionsDir(), `${CONN}.poll.log`)
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } })
}

function run(args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STATE_SCRIPT, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
    })
    let stdout = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', () => {})
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout }))
    child.stdin.end('')
  })
}

describe('disabling a connection leaves a trace', () => {
  it('records who asked, from an explicit disable', async () => {
    seedLiveConnection()
    await run(['disable', '--connection-id', CONN])

    const audit = auditLines().filter((l) => l.event === 'connection_disabled')
    assert.equal(audit.length, 1, 'expected exactly one audit line')
    const [entry] = audit
    assert.equal(entry.via, 'disable')
    assert.equal(entry.was_enabled, true, 'must record that a LIVE connection was ended')
    assert.ok(Number.isInteger(entry.pid), 'pid identifies the process that did it')
    assert.ok(Array.isArray(entry.argv) && entry.argv.some((a) => String(a).includes('disable')),
      'argv must show which command asked')
    assert.ok(entry.at, 'timestamp')
  })

  it('reports where the id really came from, never a plausible-looking guess', async () => {
    // An audit field that lies is worse than one that is absent: an INHERITED
    // id is the thing under suspicion, so recording it as 'arg' would hide the
    // exact case this exists to catch.
    seedLiveConnection()
    await run(['disable', '--connection-id', CONN], {
      env: { CLAUDE_CODE_SESSION_ID: '0e61bd47-4992-4420-8f38-4db19b0e58eb' },
    })
    const [entry] = auditLines().filter((l) => l.event === 'connection_disabled')
    assert.equal(entry.id_source, 'env:CLAUDE_CODE_SESSION_ID')
  })

  it('records HOW the conversation id was resolved on the SessionEnd path', async () => {
    // This is the field whose absence made 2026-09-19 unfalsifiable: it says
    // whether the id came from this conversation or from somewhere else.
    const localId = '0e61bd47-4992-4420-8f38-4db19b0e58eb'
    seedLiveConnection({ localId })
    await run(['disable-local', '--agent', 'Claude Code'], {
      env: { CLAUDE_CODE_SESSION_ID: localId },
    })

    const [entry] = auditLines().filter((l) => l.event === 'connection_disabled')
    assert.ok(entry, 'SessionEnd teardown must leave an audit line too')
    assert.equal(entry.via, 'disable-local')
    assert.equal(entry.local_id, localId)
    assert.equal(entry.id_source, 'env:CLAUDE_CODE_SESSION_ID')
  })

  it('attributes a stdin-delivered id to stdin, not to the environment', async () => {
    const localId = '11111111-2222-3333-4444-555555555555'
    seedLiveConnection({ localId })
    // Strip the runner's OWN identity vars, or detectLocalId resolves from the
    // inherited environment and stdin is never read. The test inherits the
    // parent's conversation id for the same reason a spawned agent does — which
    // is item 75f65461, met here in a test harness.
    const env = { ...process.env, HOME: home, USERPROFILE: home }
    for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'DEVSPEC_REMOTE_LOCAL_ID_CLAUDE_CODE']) {
      delete env[k]
    }
    const child = spawn(process.execPath, [STATE_SCRIPT, 'disable-local', '--agent', 'Claude Code'], { env })
    child.stdin.end(JSON.stringify({ session_id: localId }))
    await new Promise((r) => child.on('close', r))

    const [entry] = auditLines().filter((l) => l.event === 'connection_disabled')
    assert.ok(entry)
    assert.equal(entry.id_source, 'stdin:session_id')
  })

  it('still disables when the audit line cannot be written', async () => {
    // Losing the trace is bad; refusing to honour a stop is worse.
    seedLiveConnection()
    const logPath = path.join(connectionsDir(), `${CONN}.poll.log`)
    fs.mkdirSync(logPath)  // a directory where the log should be: append will throw

    await run(['disable', '--connection-id', CONN])
    const state = JSON.parse(fs.readFileSync(path.join(connectionsDir(), `${CONN}.json`), 'utf8'))
    assert.equal(state.enabled, false, 'the disable must still have happened')
  })
})

describe('a poller says goodbye on the way out', () => {
  it('writes a terminal line naming the exit code', () => {
    const lines = []
    const fake = {
      pid: 4242,
      stderr: { write: (l) => lines.push(l) },
      handlers: {},
      on(event, fn) { this.handlers[event] = fn },
    }
    installExitAudit(fake)
    fake.handlers.exit(0)

    assert.equal(lines.length, 1)
    assert.match(lines[0], /devspec-remote-poll: exiting code=0 pid=4242/)
  })

  it('fires for a silent SIGTERM exit, which is the case that went unexplained', () => {
    // installStopSignalHandlers deliberately exits without touching state
    // (item b9e02835) — that stays. This only adds the log line.
    const lines = []
    const fake = {
      pid: 7,
      stderr: { write: (l) => lines.push(l) },
      handlers: {},
      on(event, fn) { this.handlers[event] = fn },
    }
    installExitAudit(fake)
    fake.handlers.exit(0)
    assert.equal(lines.length, 1, 'a signalled exit must still leave a line')
  })

  it('never throws when the log is gone', () => {
    const fake = {
      pid: 1,
      stderr: { write: () => { throw new Error('EBADF') } },
      handlers: {},
      on(event, fn) { this.handlers[event] = fn },
    }
    installExitAudit(fake)
    assert.doesNotThrow(() => fake.handlers.exit(1))
  })
})

/**
 * A real exit ends the connection on the SERVER, not just in the local file
 * (item 58e2a19f). Before this, SessionEnd rewrote local state and nothing
 * else, and the poller's signal handler exits silently by design (b9e02835), so
 * the server kept every exited connection open. A sessionless one stayed open
 * for good, because the liveness sweep only ends attached connections.
 */
describe('a real exit ends the connection on the server', () => {
  const LOCAL = '22222222-3333-4444-5555-666666666666'
  let server
  let calls

  beforeEach(async () => {
    calls = []
    server = http.createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body)
        calls.push({ parsed, authorization: request.headers.authorization })
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] },
        }))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  })
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  function url() {
    return `http://127.0.0.1:${server.address().port}/api/mcp`
  }

  function endOnExit(reason) {
    const env = { ...process.env, HOME: home, USERPROFILE: home }
    for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'DEVSPEC_REMOTE_LOCAL_ID_CLAUDE_CODE']) {
      delete env[k]
    }
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [STATE_SCRIPT, 'disable-local', '--agent', 'Claude Code'], { env })
      let stdout = ''
      child.stdout.on('data', (c) => { stdout += c })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, out: JSON.parse(stdout.trim().split('\n').pop() || '{}') }))
      child.stdin.end(JSON.stringify({ session_id: LOCAL, reason }))
    })
  }

  function heartbeatCalls() {
    return calls.filter((c) => c.parsed.method === 'tools/call' && c.parsed.params?.name === 'heartbeat_connection')
  }

  it('sends one offline heartbeat with end_reason local_stop, for a sessionless connection too', async () => {
    // The seeded connection has no session_id: the case the sweep never reaches.
    seedLiveConnection({ localId: LOCAL, mcpUrl: url() })
    const { code, out } = await endOnExit('prompt_input_exit')

    assert.equal(code, 0)
    const sent = heartbeatCalls()
    assert.equal(sent.length, 1, 'exactly one end, not a retry storm or none')
    assert.deepEqual(sent[0].parsed.params.arguments, {
      connection_id: CONN,
      status: 'offline',
      end_reason: 'local_stop',
    })
    assert.equal(sent[0].authorization, 'Bearer dvs_test', 'the proven key cached for this connection')
    assert.deepEqual(out.server_end, { sent: true, end_reason: 'local_stop' })
    assert.ok(auditLines().some((l) => l.event === 'connection_end_reported'))

    const state = JSON.parse(fs.readFileSync(path.join(connectionsDir(), `${CONN}.json`), 'utf8'))
    assert.equal(state.enabled, false, 'the local disable still happens')
  })

  for (const reason of ['clear', 'resume']) {
    it(`sends nothing on /${reason}: the Claude Code process is still running`, async () => {
      // No startup listener is seeded, so this is the path that DOES disable
      // locally. It still must not end the connection on the server.
      seedLiveConnection({ localId: LOCAL, mcpUrl: url() })
      const { code, out } = await endOnExit(reason)

      assert.equal(code, 0)
      assert.equal(heartbeatCalls().length, 0)
      assert.deepEqual(out.server_end, { sent: false, reason: 'conversation_switch' })
    })
  }

  it('never guesses a server address for the key', async () => {
    // Key without its proven address: sending it to a default would hand this
    // key to a server it was never proven against (8bb707fd).
    seedLiveConnection({ localId: LOCAL })
    const { code, out } = await endOnExit('prompt_input_exit')

    assert.equal(code, 0)
    assert.equal(heartbeatCalls().length, 0)
    assert.deepEqual(out.server_end, { sent: false, reason: 'no_credential_pair' })
    assert.ok(auditLines().some((l) => l.event === 'connection_end_not_reported' && l.reason === 'no_credential_pair'))
  })

  it('an unreachable server does not stop the exit, and says so in the log', async () => {
    const closedUrl = url()
    await new Promise((resolve) => server.close(resolve))
    server = http.createServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    seedLiveConnection({ localId: LOCAL, mcpUrl: closedUrl })

    const started = Date.now()
    const { code, out } = await endOnExit('prompt_input_exit')

    assert.equal(code, 0)
    assert.ok(Date.now() - started < 10_000, 'bounded well inside the 15s hook timeout')
    assert.equal(out.server_end.sent, false)
    const state = JSON.parse(fs.readFileSync(path.join(connectionsDir(), `${CONN}.json`), 'utf8'))
    assert.equal(state.enabled, false)
    assert.ok(auditLines().some((l) => l.event === 'connection_end_not_reported'))
  })
})
