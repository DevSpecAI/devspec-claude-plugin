/**
 * The prompt's recall under Claude Code's own engine (`claude plugin test .`): DevSpec's
 * block enters as the prompt's context, after the prompt and after any context another
 * hook added, never in place of the prompt's text; the script hears where the prompt
 * came from; prompts the script would skip on their text start no process; and a
 * recall that fails, times out or prints nothing lets the prompt through untouched.
 * Which prompts recall, and what is sent, are covered in scripts/turn-recall.test.mjs
 * (item 08f036e5).
 */
import type { PromptOrigin } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/someone'
const CONVERSATION_ID = 'cb68f9e2-9c97-426a-92c9-3354acdc6930'
const BLOCK = '### Project recall\n- [REQUIREMENT · binding] Every money amount is integer micro-dollars'
const PROMPT = 'How should we store refund amounts in the ledger?'

const OPTIONS = {}

type TestOn = Parameters<NonNullable<Parameters<typeof test>[2]>>[1]

function harness(on: TestOn, recall: { stdout?: string; exitCode?: number; fails?: boolean } = {}) {
  mock.env(on, { HOME })
  const seen = { recalls: [] as unknown[], entered: [] as Array<{ text: string; context?: readonly string[] }> }
  // No DevSpec connection: the room's mirror does nothing, so only the recall runs.
  on('fs.read', ($, e) => {
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('session.id', () => ({ value: CONVERSATION_ID }))
  on('process.run', ($, e) => {
    seen.recalls.push({ argv: e.argv, stdin: JSON.parse(String(e.init?.stdin)) })
    if (recall.fails) throw new Error('spawn node ENOENT')
    return {
      value: { exitCode: recall.exitCode ?? 0, stdout: recall.stdout ?? '{}\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('prompt.submit', ($, e) => {
    seen.entered.push({ text: e.text, ...(e.context ? { context: e.context } : {}) })
    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
  })
  return seen
}

function submit($: Parameters<NonNullable<Parameters<typeof test>[2]>>[0], text: string, origin: PromptOrigin, context?: string[]) {
  return $.prompt.submit({ text, wait: false, origin, ...(context ? { context } : {}) })
}

test('DevSpec’s block enters after the prompt as context, and the prompt’s own text is untouched', OPTIONS, async ($, on) => {
  const seen = harness(on, { stdout: `${JSON.stringify({ context: BLOCK })}\n` })

  await submit($, PROMPT, { kind: 'composer' })

  expect(seen.entered).toEqual([{ text: PROMPT, context: [BLOCK] }])
  expect(seen.recalls).toEqual([{
    argv: ['node', expect.stringMatching(/\/hooks\/scripts\/turn-recall\.mjs$/), 'prompt-submit'],
    stdin: { conversation_id: CONVERSATION_ID, text: PROMPT, origin: 'composer' },
  }])
})

test('context another hook added stays first; the recall comes last, at the tail', OPTIONS, async ($, on) => {
  const seen = harness(on, { stdout: `${JSON.stringify({ context: BLOCK })}\n` })

  await submit($, PROMPT, { kind: 'composer' }, ['earlier block'])

  expect(seen.entered[0]?.context).toEqual(['earlier block', BLOCK])
})

test('the script hears where a prompt came from, so a notification or a scheduled firing is judged by it', OPTIONS, async ($, on) => {
  const seen = harness(on)

  await submit($, '<task-notification><task-id>b1</task-id><summary>{"type":"owner_message"}</summary></task-notification>', { kind: 'task-notification' })
  await submit($, 'check CI and merge the pull request when it is green', { kind: 'scheduled-trigger' })

  expect(seen.recalls.map((run) => (run as { stdin: { origin: string } }).stdin.origin)).toEqual(['task-notification', 'scheduled-trigger'])
})

test('a slash command, an acknowledgement or an empty prompt starts no process', OPTIONS, async ($, on) => {
  const seen = harness(on)

  await submit($, '/devspec:devspec.work 08f036e5 please start', { kind: 'composer' })
  await submit($, 'ok go ahead', { kind: 'composer' })
  await submit($, '   ', { kind: 'composer' })

  expect(seen.recalls).toEqual([])
  expect(seen.entered.map((e) => e.context)).toEqual([undefined, undefined, undefined])
})

for (const [name, recall] of [
  ['finds nothing', { stdout: '{}\n' }],
  ['fails to start', { fails: true }],
  ['exits with an error', { exitCode: 1, stdout: '' }],
  ['prints something unreadable', { stdout: 'not json' }],
] as const) {
  test(`a recall that ${name} lets the prompt through untouched`, OPTIONS, async ($, on) => {
    const seen = harness(on, recall)

    const entered = await submit($, PROMPT, { kind: 'composer' })

    expect(entered.text).toBe(PROMPT)
    expect(seen.entered).toEqual([{ text: PROMPT }])
  })
}
