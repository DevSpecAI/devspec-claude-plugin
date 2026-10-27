/**
 * The module under Claude Code's own engine (`claude plugin test .`): a denied tool
 * call hands the clear to scripts/terminal-wait.mjs when a wait is on record, and
 * does nothing when none is. What the clear sends is covered in
 * scripts/terminal-wait.test.mjs.
 */
import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/someone'
const CONVERSATION_ID = 'cb68f9e2-9c97-426a-92c9-3354acdc6930'
const CONNECTION_ID = '40fb7b3f-cfe4-4468-9485-42e7ed2ce2a3'
const BOND = `${HOME}/.devspec/remote-control/local/claude-code/${CONVERSATION_ID}.json`
const WAIT = `${HOME}/.devspec/remote-control/connections/${CONNECTION_ID}.terminal-wait.json`

// The manifest requires a token, and Claude Code admits the module only with
// options that fit it.
const OPTIONS = { options: { devspec_token: 'dvs_terminal_wait_test' } }

type TestOn = Parameters<NonNullable<Parameters<typeof test>[2]>>[1]

function harness(on: TestOn, files: Map<string, string>) {
  mock.env(on, { HOME })
  const runs: Array<{ argv: readonly string[]; stdin: unknown }> = []
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('session.id', () => ({ value: CONVERSATION_ID }))
  on('process.run', ($, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // The person chose "No" in the permission dialog.
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'The user doesn\'t want to proceed with this tool use.' }))
  return runs
}

// The test runner has timers; the module's environment, whose types this file uses, does not.
declare const setTimeout: (callback: () => void, ms: number) => unknown

// The clear is never awaited by the tool call, so give it real time to start.
async function settled() {
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 100))
}

test('a denied prompt with a wait on record hands the clear to the script', OPTIONS, async ($, on) => {
  const files = new Map([
    [BOND, JSON.stringify({ status: 'live', connection_id: CONNECTION_ID })],
    [WAIT, JSON.stringify({ pending: null, reported: { kind: 'permission', label: 'Bash' } })],
  ])
  const runs = harness(on, files)

  const answer = await $.tool.call({ tool: 'Bash', command: 'touch x' })
  expect(answer.deny).toBeDefined()
  await settled()

  expect(runs.length).toBe(1)
  expect(runs[0]?.argv.slice(1)).toEqual([expect.stringMatching(/\/hooks\/scripts\/terminal-wait\.mjs$/), 'clear'])
  expect(JSON.parse(String(runs[0]?.stdin))).toEqual({ hook_event_name: 'ToolCallSettled', session_id: CONVERSATION_ID })
})

test('a tool call with no wait on record starts nothing', OPTIONS, async ($, on) => {
  const files = new Map([[BOND, JSON.stringify({ status: 'live', connection_id: CONNECTION_ID })]])
  const runs = harness(on, files)

  await $.tool.call({ tool: 'Bash', command: 'touch x' })
  await settled()
  expect(runs).toEqual([])
})

test('a conversation with no DevSpec connection starts nothing', OPTIONS, async ($, on) => {
  const runs = harness(on, new Map())

  await $.tool.call({ tool: 'Bash', command: 'touch x' })
  await settled()
  expect(runs).toEqual([])
})
