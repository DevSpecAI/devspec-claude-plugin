#!/usr/bin/env node
/**
 * Claude Code's runtime report for DevSpec (item 2382364d).
 * Run: node --test hooks/scripts/agent-telemetry.test.mjs
 *
 * What matters most: the model DevSpec holds is the one Claude Code actually ran,
 * never a guess; a turn's first request makes it current without pretending a turn
 * settled; a conversation's totals never leak into the next one after /clear; and the
 * report reaches DevSpec on the heartbeat without touching the working state.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import {
  contextFigures,
  effortLevel,
  parseTelemetryRecord,
  refreshedRecord,
  settledRecord,
  telemetryPath,
} from './agent-telemetry.mjs'
import { sendTelemetry } from './devspec-telemetry.mjs'

const CONVERSATION = 'cb68f9e2-9c97-426a-92c9-3354acdc6930'
const CONNECTION = '8bb639b0-1aed-4c93-8a8b-8d0ac023f833'
const T0 = '2026-10-06T18:00:00.000Z'
const T1 = '2026-10-06T18:01:00.000Z'
const T2 = '2026-10-06T18:02:00.000Z'
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-telemetry-'))
after(() => fs.rmSync(HOME, { recursive: true, force: true }))

const usage = (model, input = 100, output = 50) => ({
  model,
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 4_000,
  cache_creation_input_tokens: 200,
})

const settle = (previous, overrides = {}) => parseTelemetryRecord(settledRecord({
  previous,
  conversationId: CONVERSATION,
  usage: usage('claude-opus-5-5'),
  stepModel: 'claude-opus-5-5',
  effort: 'high',
  context: { tokens: 40_000, window: 200_000, percent: 20 },
  requests: 3,
  sessionTurns: 1,
  sessionCostUsd: 0.42,
  turnCostUsd: 0.42,
  nowIso: T1,
  ...overrides,
}))

describe('the model DevSpec is told about', () => {
  it('is the one the turn ran, as the API reported it, with its effort and context', () => {
    const { report } = settle(null)
    assert.deepEqual(report.model, { provider: 'anthropic', id: 'claude-opus-5-5' })
    assert.equal(report.thinkingLevel, 'high')
    assert.deepEqual(report.context, { tokens: 40_000, window: 200_000, percent: 20 })
    assert.equal(report.at, T1)
  })

  it('follows a /model switch on the next turn', () => {
    const first = settle(null)
    const next = parseTelemetryRecord(refreshedRecord({
      previous: first,
      conversationId: CONVERSATION,
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      context: { tokens: 41_000, window: 200_000, percent: 20.5 },
      nowIso: T2,
    }))
    assert.deepEqual(next.report.model, { provider: 'anthropic', id: 'claude-sonnet-5-5' })
    assert.equal(next.report.thinkingLevel, 'medium')
    assert.equal(next.report.at, T2)
  })

  it('prefers the API-reported model over the one the request named', () => {
    const { report } = settle(null, { stepModel: 'claude-opus-5-5', usage: usage('claude-opus-5-5-20261001') })
    assert.equal(report.model.id, 'claude-opus-5-5-20261001')
  })

  it('is never guessed: no request and no usage names none', () => {
    const { report } = settle(null, { usage: undefined, stepModel: undefined, effort: undefined })
    assert.equal(report.model, null)
    assert.equal(report.thinkingLevel, null)
  })

  it('keeps the last known model when an interrupted turn reports no usage', () => {
    const first = settle(null)
    const { report } = settle(first, { usage: undefined, stepModel: undefined, effort: undefined, nowIso: T2 })
    assert.deepEqual(report.model, first.report.model)
    assert.equal(report.thinkingLevel, 'high')
  })

  it('names an effort level, never a numeric thinking budget', () => {
    assert.equal(effortLevel('xhigh'), 'xhigh')
    assert.equal(effortLevel(16_000), null)
    assert.equal(effortLevel('turbo'), null)
  })
})

describe("a turn's first request", () => {
  it('makes the report current without pretending a turn settled', () => {
    const first = settle(null)
    const refreshed = parseTelemetryRecord(refreshedRecord({
      previous: first,
      conversationId: CONVERSATION,
      model: 'claude-opus-5-5',
      effort: 'high',
      context: undefined,
      nowIso: T2,
    }))
    assert.equal(refreshed.report.at, T2)
    assert.deepEqual(refreshed.report.turn, first.report.turn)
    assert.deepEqual(refreshed.report.session, first.report.session)
    assert.deepEqual(refreshed.report.context, first.report.context)
  })

  it('reports zero usage, not invented usage, before any turn has settled', () => {
    const { report } = parseTelemetryRecord(refreshedRecord({
      previous: null,
      conversationId: CONVERSATION,
      model: 'claude-opus-5-5',
      effort: undefined,
      context: { window: 200_000 },
      nowIso: T0,
    }))
    assert.deepEqual(report.turn, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0 })
    assert.equal(report.session.turns, 0)
    assert.deepEqual(report.context, { tokens: null, window: 200_000, percent: null })
  })
})

describe("a conversation's totals", () => {
  it("add each turn's tokens and take the session's cost and turns from Claude Code", () => {
    const first = settle(null)
    const { report } = settle(first, { sessionTurns: 2, sessionCostUsd: 0.9, turnCostUsd: 0.48, nowIso: T2 })
    assert.deepEqual(report.turn, { input: 100, output: 50, cacheRead: 4_000, cacheWrite: 200, costUsd: 0.48, messages: 3 })
    assert.deepEqual(report.session, { input: 200, output: 100, cacheRead: 8_000, cacheWrite: 400, costUsd: 0.9, turns: 2 })
  })

  it('start again for a new conversation after /clear', () => {
    const before = settle(null)
    const { report } = parseTelemetryRecord(settledRecord({
      previous: before,
      conversationId: 'a-new-conversation',
      usage: usage('claude-opus-5-5', 10, 5),
      stepModel: 'claude-opus-5-5',
      effort: 'high',
      context: undefined,
      requests: 1,
      sessionTurns: 1,
      sessionCostUsd: 0.01,
      turnCostUsd: 0.01,
      nowIso: T2,
    }))
    assert.equal(report.session.input, 10)
    assert.equal(report.session.turns, 1)
    assert.equal(report.context, null)
  })
})

describe('the record on file', () => {
  it('reads nothing from a half-written or foreign file', () => {
    assert.equal(parseTelemetryRecord('{"v":1,"report":{"v":'), null)
    assert.equal(parseTelemetryRecord(JSON.stringify({ v: 2, report: { v: 1 } })), null)
    assert.equal(parseTelemetryRecord(''), null)
  })

  it('reads context figures leniently and bounds the percentage', () => {
    assert.deepEqual(contextFigures({ tokens: 210_000.4, window: 200_000, percent: 104 }), { tokens: 210_000, window: 200_000, percent: 100 })
    assert.equal(contextFigures(undefined), null)
    assert.equal(contextFigures({}), null)
  })
})

describe('sending the report to DevSpec', () => {
  const stateDir = path.join(HOME, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, `${CONNECTION}.json`), JSON.stringify({ token: 'dvs_test', mcp_url: 'https://example.test/api/mcp' }), { mode: 0o600 })

  it('rides the heartbeat as agent_stats, leaving the working state alone', async () => {
    const record = settledRecord({
      previous: null,
      conversationId: CONVERSATION,
      usage: usage('claude-opus-5-5'),
      stepModel: 'claude-opus-5-5',
      effort: 'high',
      context: undefined,
      requests: 1,
      sessionTurns: 1,
      sessionCostUsd: 0.1,
      turnCostUsd: 0.1,
      nowIso: T1,
    })
    fs.writeFileSync(telemetryPath(HOME, CONNECTION), record)
    const calls = []
    const result = await sendTelemetry({ connectionId: CONNECTION, home: HOME, call: async (req) => calls.push(req) })
    assert.deepEqual(result, { ok: true })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'heartbeat_connection')
    assert.equal(calls[0].mcpUrl, 'https://example.test/api/mcp')
    assert.equal('busy' in calls[0].arguments, false)
    assert.deepEqual(calls[0].arguments, {
      connection_id: CONNECTION,
      agent_name: 'Claude Code',
      status: 'live',
      agent_stats: parseTelemetryRecord(record).report,
    })
  })

  it('sends nothing when there is no report, or the id is not an id', async () => {
    const calls = []
    const call = async (req) => calls.push(req)
    assert.deepEqual(await sendTelemetry({ connectionId: '1d8b7a3f-5c2e-4d66-8a1f-3e9c7d2b0a21', home: HOME, call }), { ok: false, reason: 'no_report' })
    assert.deepEqual(await sendTelemetry({ connectionId: '../escape', home: HOME, call }), { ok: false, reason: 'bad_id' })
    assert.equal(calls.length, 0)
  })
})
