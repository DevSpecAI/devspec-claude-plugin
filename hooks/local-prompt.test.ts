/**
 * The prompt hand-off under Claude Code's own engine (`claude plugin test .`): every
 * prompt in a DevSpec conversation reaches scripts/mirror-turn.mjs, with the engine's
 * own origin for it, before the prompt enters; nothing runs in a conversation DevSpec
 * is not in; and a failure never holds a prompt back. Which origins the script shows
 * as the owner's is covered in scripts/local-turn.test.mjs (item dd1a8325).
 */
import type { PromptOrigin } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/someone'
const CONVERSATION_ID = 'cb68f9e2-9c97-426a-92c9-3354acdc6930'
const CONNECTION_ID = '40fb7b3f-cfe4-4468-9485-42e7ed2ce2a3'
const BOND = `${HOME}/.devspec/remote-control/local/claude-code/${CONVERSATION_ID}.json`

// The manifest requires a token, and Claude Code admits the module only with
// options that fit it.
const OPTIONS = { options: { devspec_token: 'dvs_local_prompt_test' } }

type TestOn = Parameters<NonNullable<Parameters<typeof test>[2]>>[1]

function harness(on: TestOn, files: Map<string, string>, { runFails = false } = {}) {
  mock.env(on, { HOME })
  const seen = { order: [] as string[], runs: [] as Array<{ argv: readonly string[]; stdin: unknown }> }
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('session.id', () => ({ value: CONVERSATION_ID }))
  on('process.run', ($, e) => {
    seen.order.push('mirror')
    seen.runs.push({ argv: e.argv, stdin: e.init?.stdin })
    if (runFails) throw new Error('spawn node ENOENT')
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // The prompt entering the session, beneath every plugin.
  on('prompt.submit', ($, e) => {
    seen.order.push('entered')
    return { text: e.text }
  })
  return seen
}

const bonded = () => new Map([[BOND, JSON.stringify({ status: 'live', connection_id: CONNECTION_ID })]])

function submit($: Parameters<NonNullable<Parameters<typeof test>[2]>>[0], text: string, origin: PromptOrigin) {
  return $.prompt.submit({ text, wait: false, origin })
}

test('a typed prompt reaches the mirror, stamped as typed, before it enters', OPTIONS, async ($, on) => {
  const seen = harness(on, bonded())

  const entered = await submit($, 'file an item for the flaky test', { kind: 'composer' })

  expect(entered.text).toBe('file an item for the flaky test')
  expect(seen.order).toEqual(['mirror', 'entered'])
  expect(seen.runs[0]?.argv.slice(1)).toEqual([expect.stringMatching(/\/hooks\/scripts\/mirror-turn\.mjs$/), 'user_prompt'])
  expect(JSON.parse(String(seen.runs[0]?.stdin))).toEqual({
    hook_event_name: 'UserPromptSubmit',
    session_id: CONVERSATION_ID,
    prompt: 'file an item for the flaky test',
    origin: { kind: 'composer' },
  })
})

test('a scheduled firing reaches the mirror stamped as scheduled, so the script can tell', OPTIONS, async ($, on) => {
  const seen = harness(on, bonded())

  await submit($, '/loop check CI and merge when green', { kind: 'scheduled-trigger' })

  expect(JSON.parse(String(seen.runs[0]?.stdin)).origin).toEqual({ kind: 'scheduled-trigger' })
})

test('a conversation with no DevSpec connection starts nothing', OPTIONS, async ($, on) => {
  const seen = harness(on, new Map())

  const entered = await submit($, 'hello', { kind: 'composer' })

  expect(entered.text).toBe('hello')
  expect(seen.order).toEqual(['entered'])
})

test('a mirror that fails never holds the prompt back', OPTIONS, async ($, on) => {
  const seen = harness(on, bonded(), { runFails: true })

  const entered = await submit($, 'hello', { kind: 'composer' })

  expect(entered.text).toBe('hello')
  expect(seen.order).toEqual(['mirror', 'entered'])
})
