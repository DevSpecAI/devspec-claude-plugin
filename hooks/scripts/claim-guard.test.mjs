#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  CONTRACT_URI,
  EVIDENCE_MAX_AGE_MS,
  commitCommandHasClaimTag,
  commitGateReason,
  evidencePathFor,
  handlePost,
  handlePre,
  handleSessionStart,
  isReadOnlyBootstrapCommand,
} from './claim-guard.mjs'

const ITEM = 'cdd7a494-ed6a-414b-9f8f-bd0741b9de55'
const OTHER_ITEM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION = 'session-12345678'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'claim-guard.mjs')
const PLUGIN_ROOT = path.resolve(HERE, '../..')
let sandbox
let repoA
let repoB
let env

function gitInit(dir) {
  fs.mkdirSync(dir)
  const result = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

function input(toolName, cwd = repoA, overrides = {}) {
  return {
    session_id: SESSION,
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: {},
    ...overrides,
  }
}

function mutationInput(toolName, target = path.join(repoA, 'target.txt'), overrides = {}) {
  const pathKey = toolName === 'NotebookEdit' ? 'notebook_path' : 'file_path'
  return input(toolName, repoA, { tool_input: { [pathKey]: target }, ...overrides })
}

function decision(result) {
  return result?.hookSpecificOutput?.permissionDecision ?? null
}

function claim(cwd = repoA, sessionId = SESSION, itemId = ITEM, response = undefined, requestedId = itemId) {
  return handlePost(input('mcp__devspec__claim_work_item', cwd, {
    session_id: sessionId,
    hook_event_name: 'PostToolUse',
    tool_input: { action_item_id: requestedId },
    tool_response: response ?? {
      content: [{
        type: 'text',
        text: JSON.stringify({ claim_success: true, action_item_id: itemId, error: null }),
      }],
    },
  }), { env })
}

function fixture(name) {
  return JSON.parse(
    fs.readFileSync(path.join(HERE, 'fixtures', 'claim-guard', name), 'utf8').replaceAll('__REPO__', repoA),
  )
}

function manifestCommand(event, index = 0) {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'))
  return manifest.hooks[event][index].hooks[0].command
}

function runManifestHook(event, hookInput, index = 0) {
  return spawnSync('/bin/sh', ['-c', manifestCommand(event, index)], {
    cwd: repoA,
    input: hookInput === undefined ? '' : JSON.stringify(hookInput),
    encoding: 'utf8',
    env: { ...env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
  })
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-guard-test-'))
  repoA = path.join(sandbox, 'repo-a')
  repoB = path.join(sandbox, 'repo-b')
  gitInit(repoA)
  gitInit(repoB)
  env = { ...process.env, DEVSPEC_CLAUDE_STATE_DIR: path.join(sandbox, 'state') }
})

afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }))

describe('Claude hook protocol and manifest integration', () => {
  it('adds only the canonical contract pointer at SessionStart', () => {
    assert.deepEqual(handleSessionStart(), {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `DevSpec implementation contract: ${CONTRACT_URI}`,
      },
    })
  })

  it('emits a protocol deny for malformed PreToolUse JSON', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'pre'], { input: '{not json', encoding: 'utf8', env })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny')
  })

  it('emits nothing when the guard passes so ordinary permissions still apply', () => {
    assert.equal(handlePre(input('mcp__devspec__reserve_work_items'), { env }), null)
    assert.equal(handlePre(input('mcp__devspec__claim_work_item'), { env }), null)
    assert.equal(handlePre(input('Bash', repoA, { tool_input: { command: 'pwd' } }), { env }), null)
    claim()
    assert.equal(handlePre(mutationInput('Write'), { env }), null)
    assert.equal(handlePre(input('Bash', repoA, { tool_input: { command: 'node --test' } }), { env }), null)
  })

  it('runs captured Claude/DevSpec fixtures through the actual manifest commands', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks
    assert.match(hooks.PreToolUse[0].matcher, /NotebookEdit/)

    const postClaim = runManifestHook('PostToolUse', fixture('post-claim-success.json'))
    assert.equal(postClaim.status, 0, postClaim.stderr)
    assert.equal(postClaim.stdout, '')

    const preClaimed = runManifestHook('PreToolUse', fixture('pre-write.json'))
    assert.equal(preClaimed.status, 0, preClaimed.stderr)
    assert.equal(preClaimed.stdout, '', 'passing PreToolUse must not auto-approve')

    const postTerminal = runManifestHook('PostToolUse', fixture('post-terminal-success.json'))
    assert.equal(postTerminal.status, 0, postTerminal.stderr)
    assert.equal(postTerminal.stdout, '')

    const preCleared = runManifestHook('PreToolUse', fixture('pre-write.json'))
    assert.equal(preCleared.status, 0, preCleared.stderr)
    assert.equal(JSON.parse(preCleared.stdout).hookSpecificOutput.permissionDecision, 'deny')
  })
})

describe('claim and terminal result observation', () => {
  it('requires server claim_success true and a full matching result id', () => {
    for (const [name, response, requested = ITEM] of [
      ['missing claim_success', { action_item_id: ITEM, error: null }],
      ['false claim_success', { claim_success: false, action_item_id: ITEM, error: null }],
      ['mismatched id', { claim_success: true, action_item_id: OTHER_ITEM, error: null }],
      ['partial requested id', { claim_success: true, action_item_id: ITEM, error: null }, ITEM.slice(0, 8)],
      ['not claimed status', { claim_success: true, action_item_id: ITEM, status: 'not_claimed', error: null }],
      ['non-null error object', { claim_success: true, action_item_id: ITEM, error: {} }],
      ['nested non-null error object', { claim_success: true, action_item_id: ITEM, data: { error: { code: 'denied' } } }],
    ]) {
      const sessionId = `negative-${name.replaceAll(' ', '-')}`
      claim(repoA, sessionId, ITEM, response, requested)
      assert.equal(decision(handlePre(mutationInput('Write', undefined, { session_id: sessionId }), { env })), 'deny', name)
    }
  })

  it('never treats prompt/tool-input item text as claim evidence', () => {
    handlePost(input('mcp__devspec__claim_work_item', repoA, {
      tool_input: { action_item_id: ITEM, prompt: `claim_success=true for ${ITEM}` },
      tool_response: { claim_success: false, action_item_id: ITEM, error: null },
    }), { env })
    assert.equal(decision(handlePre(mutationInput('Write'), { env })), 'deny')
  })

  it('clears only for an explicit successful terminal result matching evidence and input', () => {
    claim()
    for (const terminal of [
      { tool_input: { action_item_id: ITEM }, tool_response: { success: false, action_item_id: ITEM, error: null } },
      { tool_input: { action_item_id: ITEM }, tool_response: { success: true, action_item_id: OTHER_ITEM, error: null } },
      { tool_input: { action_item_id: OTHER_ITEM }, tool_response: { success: true, action_item_id: ITEM, error: null } },
      { tool_input: { action_item_id: ITEM }, tool_response: { success: true, action_item_id: ITEM, error: {} } },
    ]) {
      handlePost(input('mcp__devspec__record_implementation', repoA, terminal), { env })
      assert.equal(handlePre(mutationInput('Write'), { env }), null)
    }
    handlePost(input('mcp__devspec__record_implementation', repoA, {
      tool_input: { action_item_id: ITEM },
      tool_response: { success: true, action_item_id: ITEM, error: null },
    }), { env })
    assert.equal(decision(handlePre(mutationInput('Write'), { env })), 'deny')
  })
})

describe('session, repository, and target-path isolation', () => {
  it('does not share evidence across sessions or repositories', () => {
    claim(repoA, SESSION)
    assert.equal(handlePre(mutationInput('Write'), { env }), null)
    assert.equal(decision(handlePre(mutationInput('Write', undefined, { session_id: 'different-session' }), { env })), 'deny')
    assert.equal(decision(handlePre(input('Write', repoB, { tool_input: { file_path: path.join(repoB, 'x') } }), { env })), 'deny')
  })

  it('contains Write, Edit, and NotebookEdit targets within the claimed repository', () => {
    claim()
    fs.mkdirSync(path.join(repoA, 'nested'))
    fs.writeFileSync(path.join(repoA, 'existing.txt'), 'x')
    fs.symlinkSync(repoB, path.join(repoA, 'escape-link'))
    for (const [tool, target, expected] of [
      ['Write', path.join(repoA, 'new.txt'), null],
      ['Edit', path.join(repoA, 'existing.txt'), null],
      ['NotebookEdit', path.join(repoA, 'nested', 'book.ipynb'), null],
      ['Write', path.join(repoB, 'outside.txt'), 'deny'],
      ['Edit', '../repo-b/outside.txt', 'deny'],
      ['NotebookEdit', path.join(repoA, 'escape-link', 'outside.ipynb'), 'deny'],
    ]) {
      assert.equal(decision(handlePre(mutationInput(tool, target), { env })), expected, `${tool}: ${target}`)
    }
  })

  it('stores private atomic evidence and fails closed when stale or malformed', () => {
    const now = Date.now()
    claim()
    const files = fs.readdirSync(env.DEVSPEC_CLAUDE_STATE_DIR)
    assert.equal(files.length, 1)
    assert.match(files[0], /^[0-9a-f]{64}\.json$/)
    assert.equal(fs.statSync(env.DEVSPEC_CLAUDE_STATE_DIR).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.join(env.DEVSPEC_CLAUDE_STATE_DIR, files[0])).mode & 0o777, 0o600)
    assert.equal(decision(handlePre(mutationInput('Write'), { env, now: now + EVIDENCE_MAX_AGE_MS + 1000 })), 'deny')
    fs.chmodSync(env.DEVSPEC_CLAUDE_STATE_DIR, 0o755)
    assert.equal(decision(handlePre(mutationInput('Write'), { env })), 'deny')
    fs.chmodSync(env.DEVSPEC_CLAUDE_STATE_DIR, 0o700)

    const file = evidencePathFor({ sessionId: SESSION, repoRoot: fs.realpathSync(repoA) }, env)
    fs.writeFileSync(file, '{broken', { mode: 0o600 })
    assert.equal(decision(handlePre(mutationInput('Write'), { env })), 'deny')
  })
})

describe('unclaimed Bash allowlist and shell escapes', () => {
  for (const command of ['pwd', 'git status --short', 'git status --porcelain --branch', 'git diff --name-only', 'git rev-parse --show-toplevel']) {
    it(`passes without permissionDecision: ${command}`, () => {
      assert.equal(isReadOnlyBootstrapCommand(command), true)
      assert.equal(handlePre(input('Bash', repoA, { tool_input: { command } }), { env }), null)
    })
  }
  for (const command of ['pwd; rm -rf .', 'git status --short && touch owned', 'git diff --name-only > evidence', 'git diff --ext-diff', 'cat README.md', 'echo $(touch owned)', 'git status\nrm -rf .']) {
    it(`denies escape/mutation: ${JSON.stringify(command)}`, () => {
      assert.equal(decision(handlePre(input('Bash', repoA, { tool_input: { command } }), { env })), 'deny')
    })
  }
})

describe('direct git commit-producing gate', () => {
  beforeEach(() => claim())

  for (const command of [
    `git commit -m "fix [devspec:${ITEM}]"`,
    `git commit -am "fix [devspec:${ITEM}]"`,
    `git merge branch -m "merge [devspec:${ITEM}]"`,
    'git merge --no-commit branch',
    'git merge --squash branch',
    'git cherry-pick --no-commit abc123',
    'git revert -n abc123',
    'git status --short',
  ]) {
    it(`passes guard without auto-approval: ${command}`, () => {
      assert.equal(commitGateReason(command, ITEM), null)
      assert.equal(handlePre(input('Bash', repoA, { tool_input: { command } }), { env }), null)
    })
  }

  it('keeps the explicit commit helper pinned', () => {
    assert.equal(commitCommandHasClaimTag(`git commit -m "x [devspec:${ITEM}]"`, ITEM), true)
    assert.equal(commitCommandHasClaimTag('git commit -m x', ITEM), false)
  })

  for (const command of [
    'git commit -m "fix"',
    `git commit -m "fix [devspec:${OTHER_ITEM}]"`,
    'git merge branch',
    'git cherry-pick abc123',
    'git revert abc123',
    'git am patch.mbox',
    'git rebase main',
    'git pull --rebase',
    `echo '[devspec:${ITEM}]' && git commit -m fix`,
    `git co''mmit -m fix`,
    'git co$EMPTYmit -m fix',
    'git $(printf commit) -m fix',
  ]) {
    it(`denies direct/unverifiable commit production: ${command}`, () => {
      assert.ok(commitGateReason(command, ITEM))
      assert.equal(decision(handlePre(input('Bash', repoA, { tool_input: { command } }), { env })), 'deny')
    })
  }
})
