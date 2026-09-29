import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkBundle } from '../../launcher/check-bundle.mjs'
test('Claude SessionStart uses a verified bundled launcher, not a network installer', () => {
  assert.ok(checkBundle().files.has('plugin-setup.mjs'))
  const hooks = JSON.parse(readFileSync(new URL('../hooks.json', import.meta.url), 'utf8'))
  assert.ok(hooks.hooks.SessionStart.flatMap(h => h.hooks).some(h => h.command.includes('/hooks/scripts/setup-launcher.mjs') && !h.command.includes('npx')))
})
