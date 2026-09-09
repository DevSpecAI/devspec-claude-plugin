#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import {
  STATE_ABSENT,
  STATE_OK,
  STATE_UNREADABLE,
  patchPrivateJson,
  readPrivateJson,
  readPrivateJsonResult,
  writePrivateJson,
} from './private-state.mjs'

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

  it('replaces the file by rename, so a concurrent reader never sees a partial write', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-private-state-'))
    const file = path.join(dir, 'state.json')
    try {
      // A bond-sized payload: the real files carry a token, cursors and a window,
      // and it is the multi-kilobyte ones whose truncation window is wide enough
      // to lose a race against a reader (item 3b88955e).
      const bond = {
        connection_id: 'c'.repeat(36),
        local_id: 'l'.repeat(36),
        token: 't'.repeat(512),
        canonical_window: Array.from({ length: 200 }, (_, i) => ({ seq: i, id: 'm'.repeat(36) })),
      }
      writePrivateJson(file, bond)

      // Hammer the file from a second process WHILE reading it here. Against the
      // old in-place writeFileSync this reliably caught a truncated file; through
      // the rename a reader sees either the old bond or the new one, never a torn
      // one. Reads run until the writer exits, so they genuinely overlap.
      const moduleUrl = new URL('./private-state.mjs', import.meta.url).href
      const writerSource = [
        `import { writePrivateJson } from ${JSON.stringify(moduleUrl)}`,
        `import fs from 'node:fs'`,
        `const bond = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf8'))`,
        `for (let i = 0; i < 3000; i++) {`,
        `  bond.cursor = i`,
        `  writePrivateJson(${JSON.stringify(file)}, bond)`,
        `}`,
      ].join('\n')
      const child = spawn(process.execPath, ['--input-type=module', '-e', writerSource], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let childStderr = ''
      child.stderr.on('data', (chunk) => {
        childStderr += chunk
      })
      const exited = new Promise((resolve) => child.on('close', resolve))

      let running = true
      exited.then(() => {
        running = false
      })
      let reads = 0
      while (running) {
        const result = readPrivateJsonResult(file)
        assert.notEqual(result.status, STATE_UNREADABLE, 'a read caught a partial file')
        assert.equal(result.value.token, bond.token)
        reads++
        await new Promise((resolve) => setImmediate(resolve))
      }

      assert.equal(await exited, 0, childStderr)
      assert.ok(reads > 100, `expected the reads to overlap the writes, got ${reads}`)
      // No temp files left behind.
      assert.deepEqual(fs.readdirSync(dir), ['state.json'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('tells an absent file apart from one it could not parse', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-private-state-'))
    try {
      const missing = path.join(dir, 'missing.json')
      assert.equal(readPrivateJsonResult(missing).status, STATE_ABSENT)
      assert.equal(readPrivateJson(missing), null)

      const torn = path.join(dir, 'torn.json')
      fs.writeFileSync(torn, '{"connection_id":"abc","tok', { mode: 0o600 })
      assert.equal(readPrivateJsonResult(torn).status, STATE_UNREADABLE)
      // The lenient reader keeps its old signature for callers that only read.
      assert.equal(readPrivateJson(torn), null)

      const good = path.join(dir, 'good.json')
      writePrivateJson(good, { a: 1 })
      assert.equal(readPrivateJsonResult(good).status, STATE_OK)
      assert.deepEqual(readPrivateJsonResult(good).value, { a: 1 })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to patch over a file it could not read, and patches an absent one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-private-state-'))
    try {
      const torn = path.join(dir, 'torn.json')
      const before = '{"connection_id":"abc","local_id":"conv-1","tok'
      fs.writeFileSync(torn, before, { mode: 0o600 })
      assert.equal(patchPrivateJson(torn, { cursor: 7 }), false)
      assert.equal(fs.readFileSync(torn, 'utf8'), before, 'unreadable state was overwritten')

      const fresh = path.join(dir, 'fresh.json')
      assert.equal(patchPrivateJson(fresh, { cursor: 7 }), true)
      assert.deepEqual(readPrivateJson(fresh), { cursor: 7 })

      const existing = path.join(dir, 'existing.json')
      writePrivateJson(existing, { local_id: 'conv-1', token: 'keep-me' })
      assert.equal(patchPrivateJson(existing, { cursor: 9 }), true)
      assert.deepEqual(readPrivateJson(existing), {
        local_id: 'conv-1',
        token: 'keep-me',
        cursor: 9,
      })
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
      'devspec-poll.mjs',
      'devspec-question.mjs',
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
