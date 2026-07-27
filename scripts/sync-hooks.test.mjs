#!/usr/bin/env node
/**
 * Unit tests for sync-hooks' test-pairing rules (item b97a3521).
 * Run: node --test scripts/sync-hooks.test.mjs
 *
 * These two functions are the safety net for every downstream plugin's safety net:
 * they decide whether a shared file's test travels with it. When the pairing was
 * maintained by hand it rotted silently — `resolve-mcp-auth.mjs` was synced without
 * its test, so Cursor's suite could not even LOAD on main while `--check` cheerfully
 * reported everything in sync. A test asserting the pairing is the point of the item,
 * so the pairing logic itself is not allowed to be the untested part.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { withDerivedTests, ownsFile } from './sync-hooks.mjs'

/** A throwaway canonical dir containing exactly the named files. */
function withCanonical(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-sync-'))
  for (const f of files) fs.writeFileSync(path.join(dir, f), '// stub\n')
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('withDerivedTests — a test travels with its implementation', () => {
  it('pairs each implementation with its canonical test', () => {
    withCanonical(['a.mjs', 'a.test.mjs', 'b.mjs', 'b.test.mjs'], (dir) => {
      assert.deepEqual(withDerivedTests(['a.mjs', 'b.mjs'], dir), [
        'a.mjs',
        'a.test.mjs',
        'b.mjs',
        'b.test.mjs',
      ])
    })
  })

  it('skips an implementation that genuinely has no test', () => {
    withCanonical(['a.mjs', 'a.test.mjs', 'b.mjs'], (dir) => {
      // b has no test — it must not invent one, or apply() reports phantom drift
      // for a file that cannot be read from canonical.
      assert.deepEqual(withDerivedTests(['a.mjs', 'b.mjs'], dir), [
        'a.mjs',
        'a.test.mjs',
        'b.mjs',
      ])
    })
  })

  it('does not pair a test with a test (no a.test.test.mjs)', () => {
    withCanonical(['a.test.mjs', 'a.test.test.mjs'], (dir) => {
      // Guards against a list that still names a test by hand: the derived name
      // would exist in this fixture, so only the regex shape prevents the absurdity.
      const out = withDerivedTests(['a.test.mjs'], dir)
      assert.equal(out.filter((f) => f === 'a.test.test.mjs').length, 0)
    })
  })

  it('preserves order and does not duplicate', () => {
    withCanonical(['a.mjs', 'a.test.mjs'], (dir) => {
      const out = withDerivedTests(['a.mjs'], dir)
      assert.deepEqual(out, ['a.mjs', 'a.test.mjs'])
      assert.equal(new Set(out).size, out.length)
    })
  })
})

describe('ownsFile — owning an implementation owns its test', () => {
  // The live case: Grok Build owns three implementations because its host contract
  // differs, and a blanket sync nearly destroyed all three once (item 27058153).
  const grokOwns = ['resolve-mcp-auth.mjs', 'mirror-turn.mjs', 'remote-control-state.mjs']

  it('treats the test of an owned implementation as owned', () => {
    assert.equal(ownsFile(grokOwns, 'resolve-mcp-auth.test.mjs'), true)
    assert.equal(ownsFile(grokOwns, 'mirror-turn.test.mjs'), true)
  })

  it('still owns the implementation itself', () => {
    assert.equal(ownsFile(grokOwns, 'resolve-mcp-auth.mjs'), true)
  })

  it('does NOT own a shared file or its test', () => {
    // This is the bug direction: Grok must RECEIVE the poller and wait tests.
    assert.equal(ownsFile(grokOwns, 'devspec-remote-poll.mjs'), false)
    assert.equal(ownsFile(grokOwns, 'devspec-remote-poll.test.mjs'), false)
    assert.equal(ownsFile(grokOwns, 'devspec-remote-wait.test.mjs'), false)
  })

  it('accepts a Set as well as an array, and copes with no owns list', () => {
    assert.equal(ownsFile(new Set(grokOwns), 'mirror-turn.test.mjs'), true)
    assert.equal(ownsFile(undefined, 'anything.mjs'), false)
    assert.equal(ownsFile([], 'anything.test.mjs'), false)
  })

  it('does not treat an owned test as owning an unowned implementation', () => {
    // Ownership flows impl → test, never test → impl.
    assert.equal(ownsFile(['only.test.mjs'], 'only.mjs'), false)
  })
})
