/**
 * Which model Claude Code is running, reported to DevSpec, under Claude Code's own
 * engine (`claude plugin test .`): a turn's first request reports the model and effort
 * it was sent with and sends it at once, the turn's end reports the API's model and
 * the turn's usage, subagents are left out, and an unconnected conversation reports
 * nothing. The report's shape and the send are covered in
 * scripts/agent-telemetry.test.mjs.
 */
import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/someone'
const CONVERSATION_ID = 'cb68f9e2-9c97-426a-92c9-3354acdc6930'
const CONNECTION_ID = '40fb7b3f-cfe4-4468-9485-42e7ed2ce2a3'
const BOND = `${HOME}/.devspec/remote-control/local/claude-code/${CONVERSATION_ID}.json`
const REPORT_FILE = `${HOME}/.devspec/remote-control/connections/${CONNECTION_ID}.telemetry.json`

// The manifest requires a token, and Claude Code admits the module only with
// options that fit it.
const OPTIONS = { options: { devspec_token: 'dvs_devspec_telemetry_test' } }

type TestOn = Parameters<NonNullable<Parameters<typeof test>[2]>>[1]

// The test runner has timers; the module's environment, whose types this file uses, does not.
declare const setTimeout: (callback: () => void, ms: number) => unknown

const USAGE = {
  model: 'claude-opus-5-5',
  input_tokens: 120,
  output_tokens: 80,
  cache_read_input_tokens: 9_000,
  cache_creation_input_tokens: 300,
}

function harness(on: TestOn, files: Map<string, string>) {
  mock.env(on, { HOME })
  const seen = { runs: [] as Array<readonly string[]>, writes: [] as Array<{ path: string; text: string }> }
  let costUsd = 1.25
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    seen.writes.push({ path: e.path, text: e.text })
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('session.id', () => ({ value: CONVERSATION_ID }))
  on('session.turns', () => ({ value: 3 }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 50_000, window: 200_000, percent: 25 }, rateLimits: [], cost: { usd: costUsd } },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', () => ({ text: '' }))
  on('process.run', ($, e) => {
    seen.runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { seen, spend: (usd: number) => { costUsd += usd } }
}

/** The module's writes are never awaited by the hook; give them real time to land. */
const settle = () => new Promise<void>((resolve) => setTimeout(() => resolve(), 150))

async function step($: Parameters<NonNullable<Parameters<typeof test>[2]>>[0], turnId: string, index: number, extra: { agentId?: string } = {}) {
  const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: 'high', messageCount: 2 + index, ...extra })
  for await (const _ of stream) { /* drained */ }
  await stream.result
}

const reportIn = (text: string | undefined) => JSON.parse(text ?? '{}').report
// Only this module's report: the controls module shares the harness and writes its own file.
const reports = (writes: Array<{ path: string }>) => writes.filter((write) => write.path.endsWith('.telemetry.json'))
const sends = (runs: Array<readonly string[]>) =>
  runs.filter((argv) => argv.some((arg) => arg.endsWith('/hooks/scripts/devspec-telemetry.mjs')))

const bonded = () => new Map([[BOND, JSON.stringify({ status: 'live', connection_id: CONNECTION_ID })]])

test("a turn's first request reports its model and effort, and sends it straight away", OPTIONS, async ($, on) => {
  const files = bonded()
  const { seen } = harness(on, files)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'claim the next item', turnId: 'turn-1' })
  await step($, 'turn-1', 0)
  await settle()

  const report = reportIn(files.get(REPORT_FILE))
  expect(report.model).toEqual({ provider: 'anthropic', id: 'claude-opus-5-5' })
  expect(report.thinkingLevel).toBe('high')
  expect(report.context).toEqual({ tokens: 50_000, window: 200_000, percent: 25 })
  expect(sends(seen.runs).map((argv) => argv.slice(2))).toEqual([['send', CONNECTION_ID]])

  // Later requests of the same turn write nothing more until it ends.
  await step($, 'turn-1', 1)
  await settle()
  expect(reports(seen.writes).length).toBe(1)
})

test("the turn's end reports what it used, and the session's cost from Claude Code", OPTIONS, async ($, on) => {
  const files = bonded()
  const { seen, spend } = harness(on, files)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'refactor the parser', turnId: 'turn-2' })
  await step($, 'turn-2', 0)
  await step($, 'turn-2', 1)
  await settle()
  spend(0.5)
  await $.turn.complete({ turnId: 'turn-2', reason: 'answer', isAborted: false, answer: 'done', durationMs: 4_000, usage: USAGE })
  await settle()

  const report = reportIn(files.get(REPORT_FILE))
  expect(report.model).toEqual({ provider: 'anthropic', id: 'claude-opus-5-5' })
  expect(report.turn).toEqual({ input: 120, output: 80, cacheRead: 9_000, cacheWrite: 300, costUsd: 0.5, messages: 2 })
  expect(report.session.turns).toBe(3)
  expect(report.session.costUsd).toBe(1.75)
  expect(sends(seen.runs).length).toBe(2)
})

test("a subagent's requests and turns are not the agent DevSpec talks to", OPTIONS, async ($, on) => {
  const files = bonded()
  const { seen } = harness(on, files)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await step($, 'sub-turn', 0, { agentId: 'agent-7' })
  await $.turn.complete({ turnId: 'sub-turn', agentId: 'agent-7', reason: 'answer', isAborted: false, answer: '', durationMs: 1_000, usage: USAGE })
  await settle()
  expect(reports(seen.writes)).toEqual([])
  expect(sends(seen.runs)).toEqual([])
})

test('a conversation not connected to DevSpec reports nothing', OPTIONS, async ($, on) => {
  const { seen } = harness(on, new Map())
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hello', turnId: 'turn-3' })
  await step($, 'turn-3', 0)
  await $.turn.complete({ turnId: 'turn-3', reason: 'answer', isAborted: false, answer: 'hi', durationMs: 900, usage: USAGE })
  await settle()
  expect(reports(seen.writes)).toEqual([])
  expect(sends(seen.runs)).toEqual([])
})

test("an interrupted turn leaves its first request's report standing", OPTIONS, async ($, on) => {
  const files = bonded()
  const { seen } = harness(on, files)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'long work', turnId: 'turn-4' })
  await step($, 'turn-4', 0)
  await settle()
  const refreshed = files.get(REPORT_FILE)
  await $.turn.complete({ turnId: 'turn-4', reason: 'aborted', isAborted: true, answer: '', durationMs: 9_000 })
  await settle()
  expect(files.get(REPORT_FILE)).toBe(refreshed)
  expect(reports(seen.writes).length).toBe(1)
})
