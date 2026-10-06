#!/usr/bin/env node
/**
 * The owner's controls from DevSpec, carried out by Claude Code (item cbf3d758).
 * Run: node --test hooks/scripts/control-relay.test.mjs
 *
 * What matters most: Stop is reported only while a module is loaded and ticking, a
 * half-written report is not mistaken for "none", a stale control is never carried
 * out, and the ack frees DevSpec's slot without dropping a newer control.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import {
  CARRIED_FRESH_MS,
  CONTROL_STALE_MS,
  carriedControls,
  carriedControlsRecord,
  controlIsCurrent,
  parsePendingControl,
  pendingControlPath,
  stopHookRanSince,
} from './control-relay.mjs'
import { ackControl } from './devspec-control.mjs'

const NOW = Date.parse('2026-10-06T15:00:00.000Z')
const CONNECTION = '8bb639b0-1aed-4c93-8a8b-8d0ac023f833'
const CONTROL = '0c7a6f2e-4b1d-4c55-9b0e-2f8d6c1a9e10'
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'control-relay-'))
after(() => fs.rmSync(HOME, { recursive: true, force: true }))

describe('what the module says it carries out', () => {
  it('is Stop while the module keeps its report fresh', () => {
    assert.deepEqual(carriedControls(carriedControlsRecord(new Date(NOW - 5_000).toISOString()), NOW), ['abort'])
  })

  it('is nothing once the module stops ticking, or when there is no module', () => {
    assert.deepEqual(carriedControls(carriedControlsRecord(new Date(NOW - CARRIED_FRESH_MS - 1).toISOString()), NOW), [])
    assert.deepEqual(carriedControls('', NOW), [])
    assert.deepEqual(carriedControls(null, NOW), [])
  })

  it('is unknown, not "none", while the report is half written', () => {
    assert.equal(carriedControls('{"verbs":["ab', NOW), null)
  })

  it('never claims a verb this plugin does not carry out', () => {
    const report = JSON.stringify({ verbs: ['abort', 'compact', 'set_model'], at: new Date(NOW).toISOString() })
    assert.deepEqual(carriedControls(report, NOW), ['abort'])
  })
})

describe('a control handed to the module', () => {
  it('is carried out only while it is current', () => {
    const fresh = parsePendingControl(JSON.stringify({ id: CONTROL, verb: 'abort', received_at: new Date(NOW - 2_000).toISOString() }))
    const stale = parsePendingControl(JSON.stringify({ id: CONTROL, verb: 'abort', received_at: new Date(NOW - CONTROL_STALE_MS - 1).toISOString() }))
    const undated = parsePendingControl(JSON.stringify({ id: CONTROL, verb: 'abort' }))
    assert.equal(controlIsCurrent(fresh, NOW), true)
    assert.equal(controlIsCurrent(stale, NOW), false)
    assert.equal(controlIsCurrent(undated, NOW), false)
  })

  it('reads nothing from a malformed file', () => {
    assert.equal(parsePendingControl('not json'), null)
    assert.equal(parsePendingControl(JSON.stringify({ verb: 'abort' })), null)
  })
})

describe('handing a control back to DevSpec', () => {
  const stateDir = path.join(HOME, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, `${CONNECTION}.json`), JSON.stringify({ token: 'dvs_test', mcp_url: 'https://example.test/api/mcp' }), { mode: 0o600 })

  it('acks that control on the heartbeat and forgets its hand-off file', async () => {
    const file = pendingControlPath(HOME, CONNECTION)
    fs.writeFileSync(file, JSON.stringify({ id: CONTROL, verb: 'abort', received_at: new Date(NOW).toISOString() }))
    const calls = []
    const result = await ackControl({ connectionId: CONNECTION, controlId: CONTROL, home: HOME, call: async (req) => calls.push(req) })
    assert.deepEqual(result, { ok: true })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'heartbeat_connection')
    assert.deepEqual(calls[0].arguments, { connection_id: CONNECTION, agent_name: 'Claude Code', status: 'live', control_ack: CONTROL })
    assert.equal(fs.existsSync(file), false)
  })

  it('keeps a newer control the poller wrote meanwhile', async () => {
    const newer = '1d8b7a3f-5c2e-4d66-8a1f-3e9c7d2b0a21'
    const file = pendingControlPath(HOME, CONNECTION)
    fs.writeFileSync(file, JSON.stringify({ id: newer, verb: 'abort', received_at: new Date(NOW).toISOString() }))
    await ackControl({ connectionId: CONNECTION, controlId: CONTROL, home: HOME, call: async () => {} })
    assert.equal(parsePendingControl(fs.readFileSync(file, 'utf8')).id, newer)
  })

  it('refuses ids that are not ids, and sends nothing', async () => {
    const calls = []
    assert.deepEqual(await ackControl({ connectionId: CONNECTION, controlId: '../../x', home: HOME, call: async (req) => calls.push(req) }), { ok: false, reason: 'bad_id' })
    assert.equal(calls.length, 0)
  })
})

describe('whether the Stop hook ran for a turn', () => {
  it('counts only a run at or after the turn began', () => {
    const at = (ms) => JSON.stringify({ at: new Date(ms).toISOString() })
    assert.equal(stopHookRanSince(at(NOW), NOW - 5_000), true)
    assert.equal(stopHookRanSince(at(NOW - 10_000), NOW - 5_000), false)
    assert.equal(stopHookRanSince(null, NOW), false)
    assert.equal(stopHookRanSince('not json', NOW), false)
  })
})
