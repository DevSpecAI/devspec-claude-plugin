/**
 * The owner's Stop from DevSpec, under Claude Code's own engine (`claude plugin test .`):
 * it cancels the turn that is running and hands the control back, never cancels a turn
 * for a stale or idle control, says it carries Stop out only while loaded, and does
 * nothing in a `-p` run. The files and the ack script are covered in
 * scripts/control-relay.test.mjs.
 */
import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/someone'
const CONVERSATION_ID = 'cb68f9e2-9c97-426a-92c9-3354acdc6930'
const CONNECTION_ID = '40fb7b3f-cfe4-4468-9485-42e7ed2ce2a3'
const CONTROL_ID = '0c7a6f2e-4b1d-4c55-9b0e-2f8d6c1a9e10'
const BOND = `${HOME}/.devspec/remote-control/local/claude-code/${CONVERSATION_ID}.json`
const CONTROL_FILE = `${HOME}/.devspec/remote-control/connections/${CONNECTION_ID}.control.json`
const REPORT_FILE = `${HOME}/.devspec/remote-control/connections/${CONNECTION_ID}.controls.json`

// The manifest requires a token, and Claude Code admits the module only with
// options that fit it.
const OPTIONS = { options: { devspec_token: 'dvs_devspec_control_test' } }

type TestOn = Parameters<NonNullable<Parameters<typeof test>[2]>>[1]

// The test runner has timers; the module's environment, whose types this file uses, does not.
declare const setTimeout: (callback: () => void, ms: number) => unknown

function harness(on: TestOn, files: Map<string, string>) {
  mock.env(on, { HOME })
  const clock = mock.clock(on)
  const seen = { aborted: [] as string[], runs: [] as Array<readonly string[]>, writes: new Map<string, string>() }
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    seen.writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('session.id', () => ({ value: CONVERSATION_ID }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.abort', ($, e) => {
    seen.aborted.push(e.turnId)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    seen.runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { clock, seen }
}

/** A tick crosses several engine calls; give it real time to finish. */
async function tickOnce(clock: { advance: (ms: number) => Promise<unknown> }) {
  await clock.advance(1_000)
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 100))
}

function controlFile(receivedAt: string) {
  return JSON.stringify({ id: CONTROL_ID, verb: 'abort', received_at: receivedAt })
}

const bonded = () => new Map([[BOND, JSON.stringify({ status: 'live', connection_id: CONNECTION_ID })]])

test('Stop cancels the running turn and hands the control back', OPTIONS, async ($, on) => {
  const files = bonded()
  const { clock, seen } = harness(on, files)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'refactor the parser', turnId: 'turn-1' })

  files.set(CONTROL_FILE, controlFile(new Date().toISOString()))
  await tickOnce(clock)

  expect(seen.aborted).toEqual(['turn-1'])
  const ack = seen.runs.find((argv) => argv.includes('ack'))
  expect(ack?.slice(1)).toEqual([expect.stringMatching(/\/hooks\/scripts\/devspec-control\.mjs$/), 'ack', CONNECTION_ID, CONTROL_ID])

  // Handed back once: the next ticks neither stop nor ack it again.
  const runs = seen.runs.length
  await tickOnce(clock)
  expect(seen.aborted).toEqual(['turn-1'])
  expect(seen.runs.length).toBe(runs)
})

test('says it carries out Stop while it is loaded', OPTIONS, async ($, on) => {
  const { clock, seen } = harness(on, bonded())
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await tickOnce(clock)
  expect(JSON.parse(seen.writes.get(REPORT_FILE) ?? '{}').verbs).toEqual(['abort'])
})

test('with no turn running, a Stop stops nothing and is still handed back', OPTIONS, async ($, on) => {
  const files = bonded()
  const { clock, seen } = harness(on, files)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  files.set(CONTROL_FILE, controlFile(new Date().toISOString()))
  await tickOnce(clock)
  expect(seen.aborted).toEqual([])
  expect(seen.runs.some((argv) => argv.includes(CONTROL_ID))).toBe(true)
})

test('a stale Stop never cuts off the turn running now', OPTIONS, async ($, on) => {
  const files = bonded()
  const { clock, seen } = harness(on, files)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'a new task', turnId: 'turn-2' })
  files.set(CONTROL_FILE, controlFile(new Date(Date.now() - 10 * 60_000).toISOString()))
  await tickOnce(clock)
  expect(seen.aborted).toEqual([])
  expect(seen.runs.some((argv) => argv.includes(CONTROL_ID))).toBe(true)
})

test('a -p run reports nothing and carries nothing out', OPTIONS, async ($, on) => {
  const files = bonded()
  const { clock, seen } = harness(on, files)
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  await $.turn.start({ text: 'one shot', turnId: 'turn-3' })
  files.set(CONTROL_FILE, controlFile(new Date().toISOString()))
  await tickOnce(clock)
  expect(seen.writes.size).toBe(0)
  expect(seen.aborted).toEqual([])
  expect(seen.runs).toEqual([])
})

const STOP_HOOK_FILE = `${HOME}/.devspec/remote-control/connections/${CONNECTION_ID}.stop-hook.json`
const turnEnds = (runs: Array<readonly string[]>) =>
  runs.filter((argv) => argv.some((arg) => arg.endsWith('/hooks/scripts/mirror-turn.mjs')))

test('a turn that ends with no Stop hook, interrupted or on a denied prompt, tells DevSpec it ended', OPTIONS, async ($, on) => {
  const { seen } = harness(on, bonded())
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'long work', turnId: 'turn-4' })
  // Esc, or Stop from DevSpec
  await $.turn.complete({ turnId: 'turn-4', reason: 'aborted', isAborted: true, answer: '', durationMs: 9_000 })
  await $.turn.start({ text: 'touch a file', turnId: 'turn-5' })
  // A denied permission prompt completes as an answer, with no Stop hook either.
  await $.turn.complete({ turnId: 'turn-5', reason: 'answer', isAborted: false, answer: '', durationMs: 4_000 })
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 100))
  expect(turnEnds(seen.runs).map((argv) => argv.at(-1))).toEqual(['stop', 'stop'])
})

test("a turn whose Stop hook ran is left to it, and a subagent's run never ends the turn", OPTIONS, async ($, on) => {
  const files = bonded()
  const { seen } = harness(on, files)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'short work', turnId: 'turn-6' })
  files.set(STOP_HOOK_FILE, JSON.stringify({ at: new Date().toISOString() }))
  await $.turn.complete({ turnId: 'turn-6', reason: 'answer', isAborted: false, answer: 'Done.', durationMs: 2_000 })
  await $.turn.complete({ turnId: 'turn-7', reason: 'aborted', isAborted: true, answer: '', durationMs: 1_000, agentId: 'sub-1' })
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 100))
  expect(turnEnds(seen.runs)).toEqual([])
})
