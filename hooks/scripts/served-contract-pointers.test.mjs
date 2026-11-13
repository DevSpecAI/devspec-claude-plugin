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
// The same holds for the remote ingress contract's `semantics` sections the plugin
// points at (devspec://product/remote-ingress-contract), such as
// `semantics.notice_audience` and `semantics.check_job.room` (item a868f41f).
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
const INGRESS_CONTRACT = 'packages/core/src/mcp/remote-ingress-contract.ts'
const INGRESS_POINTER = /\bsemantics(?:\.[a-z_]+)+/g
// A contract rule named by its id, such as `core.push-safely`.
const RULE_POINTER = /\bcore\.[a-z]+(?:-[a-z]+)+/g

function serverCheckout() {
  const named = process.env.DEVSPEC_V2_ROOT?.trim()
  if (named) return { root: path.resolve(named), named: true }
  for (let dir = path.dirname(ROOT); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'devspecv2')
    if (fs.existsSync(path.join(candidate, CONTRACT))) return { root: candidate, named: false }
    if (path.dirname(dir) === dir) return { root: null, named: false }
  }
}

function servedContract(root, file = CONTRACT, name = 'IMPLEMENTATION_CONTRACT') {
  const tsx = path.join(root, 'node_modules/.bin/tsx')
  assert.ok(fs.existsSync(tsx), `${root} has no node_modules/.bin/tsx; run npm ci there`)
  const script = `import { ${name} } from ${JSON.stringify(path.join(root, file))}
process.stdout.write(JSON.stringify(${name}))`
  return JSON.parse(execFileSync(tsx, ['-e', script], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
}

/** The contract paths in `pointers` that `contract` does not have. */
function missingFrom(contract, pointers) {
  const missing = []
  for (const [pointer, files] of pointers) {
    let node = contract
    for (const key of pointer.split('.')) node = node && typeof node === 'object' && Object.hasOwn(node, key) ? node[key] : undefined
    if (node === undefined) missing.push(`${pointer} (${[...files].join(', ')})`)
  }
  return missing
}

/** Each contract path the plugin names, with the files that name it. */
function pointers(pattern = POINTER) {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', 'skills', 'commands', 'hooks', 'README.md'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter((file) => /\.(?:md|mjs|ts|json)$/.test(file) && !/\.test\.(?:mjs|ts)$/.test(file))
  const found = new Map()
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
    for (const match of text.matchAll(pattern)) {
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
    assert.ok(
      named.has('core_implementation_contract') &&
        named.has('work_entry_contract') &&
        named.has('commit_provenance_contract'),
      'the scan found the implementation contract pointers',
    )
    assert.deepEqual(missingFrom(contract, named), [], `contract ${contract.contract_version} has no such section`)
  })

  it('and the remote ingress contract has every semantics section the plugin names', (t) => {
    const checkout = serverCheckout()
    if (!checkout.root || !fs.existsSync(path.join(checkout.root, INGRESS_CONTRACT))) {
      if (checkout.named) assert.fail(`DEVSPEC_V2_ROOT names ${checkout.root}, which has no ${INGRESS_CONTRACT}`)
      t.skip('no devspecv2 checkout beside this repo')
      return
    }
    const contract = servedContract(checkout.root, INGRESS_CONTRACT, 'REMOTE_INGRESS_CONTRACT')
    const named = pointers(INGRESS_POINTER)
    // The notice reply has pointed here since 8ad9f857; a scan that misses it is broken.
    assert.ok(named.has('semantics.notice_reply') && named.has('semantics.notice_audience'), 'the scan found the notice pointers')
    assert.deepEqual(missingFrom(contract, named), [], `remote ingress contract ${contract.contract_version} has no such section`)
  })

  it('and every contract rule it names by id is one the contract has', (t) => {
    const checkout = serverCheckout()
    if (!checkout.root || !fs.existsSync(path.join(checkout.root, CONTRACT))) {
      if (checkout.named) assert.fail(`DEVSPEC_V2_ROOT names ${checkout.root}, which has no ${CONTRACT}`)
      t.skip('no devspecv2 checkout beside this repo')
      return
    }
    const contract = servedContract(checkout.root)
    const rules = new Set(contract.core_implementation_contract.rules.map((rule) => rule.id))
    const named = pointers(RULE_POINTER)
    // The pull-request step has pointed here since 0.55.0; a scan that misses it is broken.
    assert.ok(named.has('core.push-safely'), 'the scan found the rule pointers')
    const missing = [...named].filter(([id]) => !rules.has(id)).map(([id, files]) => `${id} (${[...files].join(', ')})`)
    assert.deepEqual(missing, [], `contract ${contract.contract_version} has no such rule`)
  })
})
