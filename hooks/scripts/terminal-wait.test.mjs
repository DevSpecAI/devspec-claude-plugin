#!/usr/bin/env node
/**
 * Reporting a terminal wait to DevSpec (item acde245e).
 * Run: node --test hooks/scripts/terminal-wait.test.mjs
 *
 * What matters most: the tool's input never leaves the machine, an idle turn end is not
 * a wait, the tool name from PermissionRequest reaches the report, and a clear is sent
 * only for a wait that was actually reported.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-wait-'))
process.env.HOME = HOME
const { handle, labelFromMessage, toolLabel, waitFromNotification, waitStatePath } = await import('./terminal-wait.mjs')

after(() => fs.rmSync(HOME, { recursive: true, force: true }))

const state = { connection_id: 'conn-1' }
function recorder() {
  const sent = []
  return { sent, send: async (wait) => sent.push(wait) }
}

describe('naming what is waiting', () => {
  it('keeps built-in tools and names MCP tools by server', () => {
    assert.equal(toolLabel('Bash'), 'Bash')
    assert.equal(toolLabel('mcp__supabase__execute_sql'), 'Supabase · execute_sql')
    assert.equal(toolLabel('mcp__plugin_devspec_devspec__claim_work_item'), 'Devspec · claim_work_item')
    assert.equal(toolLabel(''), null)
  })

  it('reads the asker from a needs-your-input message, and nothing else from it', () => {
    assert.equal(labelFromMessage('Supabase needs your input'), 'Supabase')
    assert.equal(labelFromMessage('Claude needs your permission'), null)
  })

  it('treats only the needs-you notifications as waits', () => {
    assert.equal(waitFromNotification({ notification_type: 'idle_prompt' }, null), null)
    assert.equal(waitFromNotification({ notification_type: 'auth_success' }, null), null)
    assert.deepEqual(waitFromNotification({ notification_type: 'permission_prompt' }, { label: 'Bash' }), { kind: 'permission', label: 'Bash' })
    assert.deepEqual(waitFromNotification({ notification_type: 'permission_prompt' }, null), { kind: 'permission', label: 'a tool' })
    assert.deepEqual(waitFromNotification({ notification_type: 'elicitation_dialog', message: 'Supabase needs your input' }, null), { kind: 'input', label: 'Supabase' })
  })
})

describe('the hook sequence for a permission prompt', () => {
  it('remembers the tool, reports it when Claude Code raises its alert, and clears it after', async () => {
    const r = recorder()
    const request = JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf /secret' } })
    assert.deepEqual(await handle('request', request, { state, send: r.send }), { action: 'remembered', label: 'Bash' })
    assert.equal(r.sent.length, 0, 'nothing is sent when the prompt merely opens')
    assert.ok(!fs.readFileSync(waitStatePath('conn-1', path.join(HOME, '.devspec', 'remote-control', 'connections')), 'utf8').includes('rm -rf'), 'the input is never stored')

    const notify = JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' })
    await handle('notify', notify, { state, send: r.send })
    assert.deepEqual(r.sent, [{ kind: 'permission', label: 'Bash' }])

    await handle('clear', JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }), { state, send: r.send })
    assert.deepEqual(r.sent, [{ kind: 'permission', label: 'Bash' }, null])
  })

  it('sends nothing when a prompt was answered before Claude Code raised its alert', async () => {
    const r = recorder()
    await handle('request', JSON.stringify({ tool_name: 'Bash' }), { state, send: r.send })
    assert.deepEqual(await handle('clear', JSON.stringify({ hook_event_name: 'PostToolUse' }), { state, send: r.send }), { action: 'forgotten' })
    assert.deepEqual(r.sent, [])
  })

  it('does nothing on clear when nothing was waiting', async () => {
    const r = recorder()
    assert.deepEqual(await handle('clear', '{}', { state, send: r.send }), { action: 'none' })
    assert.deepEqual(r.sent, [])
  })

  it('does nothing for a conversation with no DevSpec connection', async () => {
    const r = recorder()
    assert.deepEqual(await handle('notify', JSON.stringify({ notification_type: 'permission_prompt' }), { state: null, send: r.send }), { action: 'unbound' })
    assert.deepEqual(r.sent, [])
  })
})
