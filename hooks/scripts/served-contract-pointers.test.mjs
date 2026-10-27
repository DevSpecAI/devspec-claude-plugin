#!/usr/bin/env node
// Every part of the served implementation contract this plugin points at exists.
//
// The plugin's messages, skills and hooks point at the contract by section, for
// example "the work_entry_contract in devspec://product/implementation-contract" or
// `commit_provenance_contract.validation.online_outcomes`, instead of restating its
// rules (item 3e24523e). A pointer is only worth something while it names something.
// This reads the contract from a devspecv2 checkout beside this repo and fails on a
// path it does not have. A clause or version the server adds never fails it; a
// section renamed or removed does.
//
// With no checkout beside it the test skips, as server-tool-names.test.mjs does.
// Name one with DEVSPEC_V2_ROOT; once named, it must be there.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const SELF = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SELF), '../..')
const CONTRACT = 'packages/core/src/mcp/implementation-contract.ts'
const SECTIONS = ['instruction_boundary', 'core_implementation_contract', 'work_entry_contract', 'commit_provenance_contract', 'authority_contract']
const POINTER = new RegExp(`\\b(${SECTIONS.join('|')})((?:\\.[a-z_]+)*)`, 'g')

function serverCheckout() {
  const named = process.env.DEVSPEC_V2_ROOT?.trim()
  if (named) return { root: path.resolve(named), named: true }
  for (let dir = path.dirname(ROOT); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'devspecv2')
    if (fs.existsSync(path.join(candidate, CONTRACT))) return { root: candidate, named: false }
    if (path.dirname(dir) === dir) return { root: null, named: false }
  }
}

function servedContract(root) {
  const tsx = path.join(root, 'node_modules/.bin/tsx')
  assert.ok(fs.existsSync(tsx), `${root} has no node_modules/.bin/tsx; run npm ci there`)
  const script = `import { IMPLEMENTATION_CONTRACT } from ${JSON.stringify(path.join(root, CONTRACT))}
process.stdout.write(JSON.stringify(IMPLEMENTATION_CONTRACT))`
  return JSON.parse(execFileSync(tsx, ['-e', script], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
}

/** Each contract path the plugin names, with the files that name it. */
function pointers() {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', 'skills', 'commands', 'hooks', 'README.md'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter((file) => /\.(?:md|mjs|ts|json)$/.test(file) && !/\.test\.(?:mjs|ts)$/.test(file))
  const found = new Map()
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
    for (const match of text.matchAll(POINTER)) {
      const at = found.get(match[0]) ?? new Set()
      at.add(file)
      found.set(match[0], at)
    }
  }
  return found
}

describe('the served contract sections this plugin points at', () => {
  it('all exist in the contract the server serves', (t) => {
    const checkout = serverCheckout()
    if (!checkout.root || !fs.existsSync(path.join(checkout.root, CONTRACT))) {
      if (checkout.named) assert.fail(`DEVSPEC_V2_ROOT names ${checkout.root}, which has no ${CONTRACT}`)
      t.skip('no devspecv2 checkout beside this repo')
      return
    }
    const contract = servedContract(checkout.root)
    const named = pointers()
    // The commit messages name both; a scan that finds neither is broken, not clean.
    assert.ok(named.has('work_entry_contract') && named.has('commit_provenance_contract'), 'the scan found the commit messages\' pointers')
    const missing = []
    for (const [pointer, files] of named) {
      let node = contract
      for (const key of pointer.split('.')) node = node && typeof node === 'object' && Object.hasOwn(node, key) ? node[key] : undefined
      if (node === undefined) missing.push(`${pointer} (${[...files].join(', ')})`)
    }
    assert.deepEqual(missing, [], `contract ${contract.contract_version} has no such section`)
  })
})
