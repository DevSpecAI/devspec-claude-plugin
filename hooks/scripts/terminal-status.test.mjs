/**
 * The terminal's DevSpec line (item c6dcb524), read from state written by the
 * plugin's REAL writers: the `write` command connect runs, the conversation
 * project store, and the poller's own state patches. If one of those moves a file
 * or renames a field, the line silently disappears, and this is what notices.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyWorkChange,
  formatStatusLine,
  readConnectionView,
  transitionToast,
  workChange,
} from './terminal-status.mjs'
import { saveConversationProject } from './conversation-project.mjs'
import { disabledStatePatch, patchConnectionState } from './devspec-remote-poll.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONNECTION_ID = '40fb7b3f-cfe4-4468-9485-42e7ed2ce2a3'
const CONVERSATION_ID = 'cb68f9e2-9c97-426a-92c9-3354acdc6930'
const SESSION_ID = '358f2225-413a-483e-9c05-1617aa278fc2'
const ITEM_ID = 'c6dcb524-b140-49ce-ab54-456849d1ce86'
const ENDPOINT = 'https://api.devspec.example/api/mcp'

const readText = (file) => fs.promises.readFile(file, 'utf8').catch(() => null)
const sha256Hex = async (text) => crypto.createHash('sha256').update(text).digest('hex')

const scratch = []
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }) })

/** A home holding one conversation connected the way connect leaves it. */
function connectedHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-terminal-status-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-terminal-status-cwd-'))
  scratch.push(home, cwd)
  const run = spawnSync(process.execPath, [
    path.join(HERE, 'remote-control-state.mjs'), 'write',
    '--connection-id', CONNECTION_ID,
    '--codename', 'Cosmic Raven',
    '--local-id', CONVERSATION_ID,
    '--cwd', cwd,
    '--host-token', 'dvs_terminal_status_test',
    '--no-poller',
  ], { env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home }, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  saveConversationProject(CONVERSATION_ID, ENDPOINT, {
    id: '24c4abaa-2cb9-496a-8492-cf1f1aa1090b',
    name: 'DevSpec',
    organization: { id: '9e0dd338-18b3-423b-8beb-df2d730ccc9f', name: 'DevSpec' },
  }, 'conversation', { home })
  const paths = {
    dir: path.join(home, '.devspec', 'remote-control', 'connections'),
    legacyPath: path.join(home, '.devspec', 'remote-control.json'),
  }
  const patch = (fields) => assert.equal(patchConnectionState(CONNECTION_ID, fields, paths), true)
  const view = () => readConnectionView({ home, conversationId: CONVERSATION_ID, readText, sha256Hex })
  return { home, patch, view }
}

test('a freshly connected conversation names its codename and project', async () => {
  const { view } = connectedHome()
  const v = await view()
  assert.equal(v.state, 'connected')
  assert.equal(formatStatusLine(v), 'Cosmic Raven · DevSpec')
})

test('an attached room is named by the title read for THAT room, and untitled otherwise', async () => {
  const { patch, view } = connectedHome()
  patch({ session_id: SESSION_ID, session_title: 'Fix the login redirect', session_title_for: SESSION_ID })
  assert.equal(formatStatusLine(await view()), 'Cosmic Raven · DevSpec · “Fix the login redirect”')

  // Reattached elsewhere, before the new room's title has been read.
  patch({ session_id: 'aaaaaaaa-1111-4222-8333-444444444444' })
  assert.equal(formatStatusLine(await view()), 'Cosmic Raven · DevSpec · untitled session')

  // The placeholder a brand-new room carries is not its name.
  patch({ session_id: SESSION_ID, session_title: 'New session', session_title_for: SESSION_ID })
  assert.equal(formatStatusLine(await view()), 'Cosmic Raven · DevSpec · untitled session')

  // Detached: the line stops naming a room.
  patch({ session_id: null, session_title: null, session_title_for: null })
  assert.equal(formatStatusLine(await view()), 'Cosmic Raven · DevSpec')
})

test('a room title cannot put control characters on the terminal', async () => {
  const { patch, view } = connectedHome()
  patch({ session_id: SESSION_ID, session_title: 'Fix\u001b[2J the\nlogin', session_title_for: SESSION_ID })
  const line = formatStatusLine(await view())
  assert.equal(line, 'Cosmic Raven · DevSpec · “Fix [2J the login”')
  assert.doesNotMatch(line, /[\u0000-\u001f]/)
})

test('an End from the Agents page reads as ended from DevSpec, and is announced once', async () => {
  const { patch, view } = connectedHome()
  const before = await view()
  patch(disabledStatePatch('ui'))
  const after = await view()
  assert.equal(formatStatusLine(after), 'Cosmic Raven · ended from DevSpec')
  assert.equal(
    transitionToast(before, after),
    'Cosmic Raven was ended from DevSpec. Run /devspec:devspec.remote to connect again.',
  )
  assert.equal(transitionToast(after, await view()), undefined)
})

test('a stop that was not an End from DevSpec reads as disconnected', async () => {
  const { patch, view } = connectedHome()
  const before = await view()
  patch(disabledStatePatch('local_stop'))
  const after = await view()
  assert.equal(formatStatusLine(after), 'Cosmic Raven · disconnected')
  assert.match(transitionToast(before, after), /disconnected from DevSpec/)
})

test('a conversation with no connection draws no line', async () => {
  const { home } = connectedHome()
  const v = await readConnectionView({ home, conversationId: 'some-other-conversation', readText, sha256Hex })
  assert.equal(v, null)
  assert.equal(formatStatusLine(v), undefined)
})

test('the first reading is never announced; connecting afterwards is', async () => {
  const { view } = connectedHome()
  const v = await view()
  assert.equal(transitionToast(undefined, v), undefined)
  assert.equal(transitionToast(null, v), 'Connected to DevSpec as Cosmic Raven.')
  assert.equal(transitionToast(v, v), undefined)
})

test('claimed work shows by short code and clears when the work is recorded', async () => {
  const { view } = connectedHome()
  const v = await view()
  const tool = 'mcp__plugin_devspec_devspec__claim_work_item'
  let work = applyWorkChange([], workChange({
    tool,
    input: { action_item_id: ITEM_ID },
    resultText: JSON.stringify({ id: ITEM_ID, title: 'x', claim_success: true }),
    isError: false,
  }))
  assert.equal(formatStatusLine(v, work), 'Cosmic Raven · DevSpec · working on c6dcb524')

  work = applyWorkChange(work, workChange({
    tool: 'mcp__devspec__record_implementation',
    input: { action_item_id: ITEM_ID },
    resultText: JSON.stringify({ lifecycle: 'implemented' }),
    isError: false,
  }))
  assert.deepEqual(work, [])
})

test('a refused or failed claim is not work in hand', () => {
  const tool = 'mcp__plugin_devspec_devspec__claim_work_item'
  const input = { action_item_id: ITEM_ID }
  assert.equal(workChange({ tool, input, resultText: JSON.stringify({ claim_success: false, id: ITEM_ID }), isError: false }), null)
  assert.equal(workChange({ tool, input, resultText: JSON.stringify({ error: 'possible_conflict' }), isError: false }), null)
  assert.equal(workChange({ tool, input, resultText: 'Action item is claimed by another agent', isError: true }), null)
  assert.equal(workChange({ tool: 'mcp__plugin_devspec_devspec__get_action_item', input, resultText: '{}', isError: false }), null)
})
