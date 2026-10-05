/**
 * The module under Claude Code's own engine (`claude plugin test .`): it draws the
 * line from the conversation's files with no model turn, follows a claim, and
 * announces an End from DevSpec once. What the line SAYS is covered against the
 * real state writers in scripts/terminal-status.test.mjs.
 */
import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/someone'
const CONVERSATION_ID = 'cb68f9e2-9c97-426a-92c9-3354acdc6930'
const CONNECTION_ID = '40fb7b3f-cfe4-4468-9485-42e7ed2ce2a3'
const ITEM_ID = 'c6dcb524-b140-49ce-ab54-456849d1ce86'
const BOND = `${HOME}/.devspec/remote-control/local/claude-code/${CONVERSATION_ID}.json`
const CONNECTION = `${HOME}/.devspec/remote-control/connections/${CONNECTION_ID}.json`

// The manifest requires a token, and Claude Code admits the module only with
// options that fit it.
const OPTIONS = { options: { devspec_token: 'dvs_terminal_status_test' } }

const connected = {
  connection_id: CONNECTION_ID,
  enabled: true,
  session_codename: 'Cosmic Raven',
  session_id: null,
  ended_from_ui: false,
  end_reason: null,
}

test('the line appears when the conversation connects, follows a claim, and says when DevSpec ended it', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME })
  const files = new Map<string, string>()
  const lines: Array<string | undefined> = []
  const toasts: string[] = []
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('session.id', () => ({ value: CONVERSATION_ID }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.status', ($, e) => { lines.push(e.text); return { value: undefined } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('tool.call', { tool: 'mcp__plugin_devspec_devspec__claim_work_item' }, () => ({
    result: { content: [] },
    text: JSON.stringify({ id: ITEM_ID, title: 'Status line', claim_success: true }),
  }))

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  // Not connected yet (the listener registers a few seconds after launch): nothing.
  expect(lines).toEqual([])

  files.set(BOND, JSON.stringify({ status: 'live', connection_id: CONNECTION_ID }))
  files.set(CONNECTION, JSON.stringify(connected))
  await clock.advance(2_000)
  expect(lines.at(-1)).toBe('Cosmic Raven')
  expect(toasts).toEqual(['Connected to DevSpec as Cosmic Raven.'])

  await $.tool.call({ tool: 'mcp__plugin_devspec_devspec__claim_work_item', action_item_id: ITEM_ID, agent_branch: 'b' })
  expect(lines.at(-1)).toBe('Cosmic Raven · working on c6dcb524')

  files.set(CONNECTION, JSON.stringify({ ...connected, enabled: false, ended_from_ui: true, end_reason: 'ui' }))
  await clock.advance(2_000)
  expect(lines.at(-1)).toBe('Cosmic Raven · ended from DevSpec')
  expect(toasts.at(-1)).toBe('Cosmic Raven was ended from DevSpec. Run /devspec:devspec.remote to connect again.')

  // Said once: the next readings change nothing.
  const drawn = lines.length
  await clock.advance(6_000)
  expect(lines.length).toBe(drawn)
  expect(toasts.length).toBe(2)
})

test('a -p run draws nothing and reads nothing', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME })
  const reads: string[] = []
  const lines: Array<string | undefined> = []
  on('fs.read', ($, e) => { reads.push(e.path); throw new Error('ENOENT') })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.status', ($, e) => { lines.push(e.text); return { value: undefined } })

  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  await clock.advance(10_000)
  expect(reads).toEqual([])
  expect(lines).toEqual([])
})
