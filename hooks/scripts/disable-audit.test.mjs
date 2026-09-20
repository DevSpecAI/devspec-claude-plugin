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

function seedLiveConnection({ localId = null, agent = 'Claude Code' } = {}) {
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
