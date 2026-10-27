import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = fileURLToPath(new URL('../../', import.meta.url))
test('Claude startup retains its connection hooks without a bundled launcher or setup hook', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks/hooks.json')))
  const text = JSON.stringify(hooks)
  assert.equal(fs.existsSync(path.join(root, 'launcher')), false)
  assert.equal(fs.existsSync(path.join(root, 'hooks/scripts/setup-launcher.mjs')), false)
  assert.doesNotMatch(text, /setup-launcher|launcher\/|launcher\\\\/)
  assert.match(text, /remote-session-lifecycle/)
  assert.match(text, /session-env-credentials/)
})
test('a fresh unconfigured SessionStart does not create an independent launcher', { skip: process.platform === 'win32' }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-clean-start-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks/hooks.json')))
  const commands = hooks.hooks.SessionStart.flatMap(group => group.hooks).map(hook => hook.command)
  // Refuse the dangerous regression before executing any fixture hook.
  assert.ok(commands.every(command => !command.includes('setup-launcher')))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DEVSPEC|CLAUDE)_/.test(key)))
  Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: root, CLAUDE_ENV_FILE: path.join(home, 'env'), XDG_CONFIG_HOME: path.join(home, '.config') })
  for (const command of commands) {
    const result = spawnSync('bash', ['-c', command], { cwd: home, env, input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'fixture-clean-start', cwd: home }), encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, 0, result.stderr)
  }
  assert.equal(fs.existsSync(path.join(home, '.devspec/launcher')), false)
})
