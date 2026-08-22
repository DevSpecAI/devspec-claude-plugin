#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')

function source(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

describe('private remote-control state helper', () => {
  it('repairs an existing permissive file before reading and after writing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-private-state-'))
    const file = path.join(dir, 'state.json')
    try {
      fs.writeFileSync(file, JSON.stringify({ token: 'secret', value: 1 }), { mode: 0o644 })
      assert.deepEqual(readPrivateJson(file), { token: 'secret', value: 1 })
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)

      fs.chmodSync(file, 0o644)
      writePrivateJson(file, { connection_capability: 'hidden', value: 2 })
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
      assert.deepEqual(readPrivateJson(file), { connection_capability: 'hidden', value: 2 })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enumerates every secret-bearing state consumer through the centralized reader', () => {
    const runtimeFiles = fs.readdirSync(HERE)
      .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    const consumers = runtimeFiles.filter((name) => {
      const body = source(`hooks/scripts/${name}`)
      const inRemoteState = body.includes("'remote-control.json'") ||
        body.includes("'remote-control', 'connections'")
      const readsJsonState = body.includes("endsWith('.json')") ||
        body.includes("endsWith(\".json\")") ||
        body.includes('const statePath =') ||
        body.includes('LEGACY_STATE_PATH') ||
        body.includes('LEGACY_PATH')
      return inRemoteState && readsJsonState
    }).sort()
    const expected = [
      'commit-observation.mjs',
      'devspec-plan.mjs',
      'devspec-remote-poll.mjs',
      'devspec-remote-wait.mjs',
      'mirror-turn.mjs',
      'remote-control-state.mjs',
    ].sort()
    assert.deepEqual(consumers, expected)
    for (const name of consumers) {
      const body = source(`hooks/scripts/${name}`)
      assert.match(body, /from ['"]\.\/private-state\.mjs['"]/, `${name} must import private-state`)
      assert.doesNotMatch(
        body,
        /JSON\.parse\(fs\.readFileSync\((?:LEGACY_STATE_PATH|LEGACY_PATH|statePath\(|connectionPath\(|path\.join\(dir, name\))/,
        `${name} must not parse remote-control state directly`,
      )
    }
  })

  it('remote-stop directs only redacted resolver/status/list surfaces', () => {
    const command = source('commands/devspec.remote-stop.md')
    assert.match(command, /remote-control-state\.mjs" resolve-local/)
    assert.match(command, /remote-control-state\.mjs status/)
    assert.match(command, /remote-control-state\.mjs list/)
    assert.match(command, /Never open, cat, parse/)
    assert.doesNotMatch(command, /~\/\.devspec\/remote-control[^\s`]*\.json/)
  })
})
