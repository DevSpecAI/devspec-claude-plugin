#!/usr/bin/env node
/**
 * Working lasts as long as the work, not a fixed hour (item 9e8dda57).
 * Run: node --test hooks/scripts/turn-liveness.test.mjs
 *
 * Measured 2026-10-06: three Claude Code commands (Wary Egret, Drifting Pika, Bold
 * Octopus) were closed at exactly 60 minutes from pickup with work still running. The
 * open bubble was sealed empty and the answer arrived later as a separate message.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

import {
  NO_SIGN_OF_LIFE_MS,
  connectionsDir,
  readTurnActivity,
  recordTurnActivity,
  touch,
  turnIsLive,
  turnIsRunning,
  turnMarkerFile,
} from './turn-liveness.mjs'
import { bondPath } from './terminal-status.mjs'

const CONNECTION = '11111111-2222-4333-8444-555555555555'
const CONVERSATION = '62e52186-8e2f-4fca-81bd-544e89df6d2c'
const NOW = Date.parse('2026-10-06T19:06:35.662Z')
const HOUR = 60 * 60 * 1000
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'turn-liveness.mjs')

const scratch = []
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }) })
function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-liveness-'))
  scratch.push(home)
  fs.mkdirSync(connectionsDir(home), { recursive: true })
  return home
}
function bond(home) {
  fs.mkdirSync(path.dirname(bondPath(home, CONVERSATION)), { recursive: true })
  fs.writeFileSync(bondPath(home, CONVERSATION), JSON.stringify({ connection_id: CONNECTION }))
}
function openTurn(home, marker) {
  fs.writeFileSync(turnMarkerFile(CONNECTION, connectionsDir(home)), JSON.stringify(marker))
}

describe('turnIsLive — what Claude Code shows decides, not the time since pickup', () => {
  const startedAt = NOW - HOUR - 1

  it('a command past its first hour is live while its tool calls keep coming', () => {
    assert.equal(turnIsLive({ startedAt }, { activity: { turn: startedAt, at: NOW - 30_000 }, now: NOW }), true)
  })

  it('a held command is live however long Claude waits for its own work', () => {
    assert.equal(turnIsLive({ startedAt: NOW - 5 * HOUR, held: true }, { now: NOW }), true)
  })

  it('a turn whose end was never reported goes once nothing has happened for the backstop', () => {
    assert.equal(turnIsLive({ startedAt }, { now: NOW }), false)
    assert.equal(turnIsLive({ startedAt }, { activity: { turn: startedAt, at: NOW - NO_SIGN_OF_LIFE_MS }, now: NOW }), false)
  })

  it('a short turn is unchanged: live from the moment it starts', () => {
    assert.equal(turnIsLive({ startedAt: NOW - 1_000 }, { now: NOW }), true)
  })

  it("a previous turn's activity never keeps the next one alive", () => {
    assert.equal(turnIsLive({ startedAt }, { activity: { turn: startedAt - 1, at: NOW - 1_000 }, now: NOW }), false)
  })

  it('no marker is no turn', () => {
    assert.equal(turnIsLive(null, { now: NOW }), false)
  })
})

describe('turnIsRunning — queued work waits only for a turn Claude Code is working on (item d0b8eeb1)', () => {
  it('a held turn is live but not running: Claude Code is idle, waiting on background work', () => {
    const held = { startedAt: NOW - 1_000, held: true }
    assert.equal(turnIsLive(held, { now: NOW }), true, 'the command stays open')
    assert.equal(turnIsRunning(held, { now: NOW }), false)
    assert.equal(turnIsRunning({ startedAt: NOW - 5 * HOUR, held: true }, { now: NOW }), false)
  })

  it('the prompt that ends the hold makes the same turn running again', () => {
    // A prompt rewrites the held marker without `held`, keeping its start.
    const startedAt = NOW - 10 * 60_000
    assert.equal(turnIsRunning({ startedAt }, { now: NOW }), true)
  })

  it('a running turn follows the same signs of life as turnIsLive', () => {
    const startedAt = NOW - HOUR - 1
    assert.equal(turnIsRunning({ startedAt }, { activity: { turn: startedAt, at: NOW - 30_000 }, now: NOW }), true)
    assert.equal(turnIsRunning({ startedAt }, { now: NOW }), false, 'an unreported end is not running')
    assert.equal(turnIsRunning(null, { now: NOW }), false)
  })
})

describe('recordTurnActivity — a sign of life never opens or reopens a turn', () => {
  it("stamps the open turn's activity with the turn it belongs to", () => {
    const home = tempHome()
    openTurn(home, { startedAt: NOW - HOUR })
    assert.equal(recordTurnActivity(CONNECTION, { dir: connectionsDir(home), now: NOW }), true)
    assert.deepEqual(readTurnActivity(CONNECTION, connectionsDir(home)), { turn: NOW - HOUR, at: NOW })
  })

  it('with no turn open it writes nothing, so a turn that just ended stays ended', () => {
    const home = tempHome()
    assert.equal(recordTurnActivity(CONNECTION, { dir: connectionsDir(home), now: NOW }), false)
    assert.equal(fs.existsSync(turnMarkerFile(CONNECTION, connectionsDir(home))), false)
    assert.equal(readTurnActivity(CONNECTION, connectionsDir(home)), null)
  })

  it('leaves the marker exactly as it was', () => {
    const home = tempHome()
    const marker = { startedAt: NOW - HOUR, held: true }
    openTurn(home, marker)
    recordTurnActivity(CONNECTION, { dir: connectionsDir(home), now: NOW })
    assert.deepEqual(JSON.parse(fs.readFileSync(turnMarkerFile(CONNECTION, connectionsDir(home)), 'utf8')), marker)
  })
})

describe('touch — the PostToolUse hook', () => {
  it("records activity for the conversation's own connection, a subagent's tool call included", () => {
    const home = tempHome()
    bond(home)
    openTurn(home, { startedAt: NOW - HOUR })
    const input = JSON.stringify({ session_id: CONVERSATION, agent_id: 'a5d2', hook_event_name: 'PostToolUse', tool_name: 'Bash' })
    assert.equal(touch(input, { env: {}, home, now: NOW }), true)
    assert.deepEqual(readTurnActivity(CONNECTION, connectionsDir(home)), { turn: NOW - HOUR, at: NOW })
  })

  it('does nothing for a conversation that is not connected', () => {
    const home = tempHome()
    openTurn(home, { startedAt: NOW - HOUR })
    assert.equal(touch(JSON.stringify({ session_id: CONVERSATION }), { env: {}, home, now: NOW }), false)
  })

  it('as a command it always exits 0 and prints nothing, whatever it is given', () => {
    const home = tempHome()
    bond(home)
    openTurn(home, { startedAt: Date.now() - 1_000 })
    for (const stdin of [JSON.stringify({ session_id: CONVERSATION }), 'not json', '']) {
      const run = spawnSync(process.execPath, [SCRIPT, 'touch'], { input: stdin, env: { HOME: home, PATH: process.env.PATH }, encoding: 'utf8' })
      assert.equal(run.status, 0)
      assert.equal(run.stdout, '')
    }
    assert.equal(readTurnActivity(CONNECTION, connectionsDir(home))?.turn > 0, true)
  })
})
