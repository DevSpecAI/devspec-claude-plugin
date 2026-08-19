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
  handlePost,
  handlePre,
  handleSessionStart,
  isPluginControlPlaneCommand,
  isReadOnlyBootstrapCommand,
  shellSegments,
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

function gitCommit(dir) {
  const result = spawnSync(
    'git',
    ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '--allow-empty', '-q', '-m', 'init'],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
}

function addWorktree(repo, target) {
  const result = spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', target], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

/**
 * What makes a folder a DevSpec project folder as far as this guard is concerned.
 *
 * A real one carries a `.mcp.json` registering the DevSpec MCP server — and note it
 * is normally UNTRACKED, which is why a linked worktree cannot inherit it through
 * git and the main-checkout fallback exists.
 */
function writeDevspecMarker(dir) {
  fs.writeFileSync(
    path.join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { devspec: { type: 'http', url: 'https://example.invalid/api/mcp' } } }),
  )
}

function writeProjectPin(dir, projectId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') {
  fs.mkdirSync(path.join(dir, '.devspec'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.devspec', 'project.json'), JSON.stringify({ project_id: projectId }))
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

/** A parsed segment carrying no redirections — the shape `shellSegments` returns. */
function words(...list) {
  return { words: list, redirects: [] }
}

function claim(cwd = repoA, sessionId = SESSION, itemId = ITEM, response = undefined, requestedId = itemId) {
  return handlePost(input('mcp__devspec__claim_work_item', cwd, {
    session_id: sessionId,
    hook_event_name: 'PostToolUse',
    tool_input: { action_item_id: requestedId },
    tool_response: response ?? {
      content: [{
        type: 'text',
        text: JSON.stringify(serverClaimPayload(itemId)),
      }],
    },
  }), { env })
}

/**
 * The shape `claim_work_item` actually returns: the claimed row spread with the
 * server's own boolean — `{ ...claimed, claim_success: true, work_claim_ref }`.
 * The item is identified by `id`, and the payload is full of other uuids. The
 * suite used to assert against a hand-written `{claim_success, action_item_id}`
 * object no server ever sends, which is how a guard that could never observe a
 * real claim shipped green (devspec:4910e673).
 */
function serverClaimPayload(itemId = ITEM) {
  return {
    id: itemId,
    title: 'Fixture item',
    type: 'bug',
    lifecycle: 'open',
    agent_activity: 'implementing',
    project_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    user_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    parent_action_item_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    acceptance_criteria: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', text: 'a criterion' }],
    claim_success: true,
    work_claim_ref: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  }
}

/** `record_implementation` returns `{ ...updated, reservation, ... }` — no success flag. */
function serverRecordPayload(itemId = ITEM) {
  return {
    id: itemId,
    title: 'Fixture item',
    lifecycle: 'implemented',
    agent_activity: 'finished',
    verification_required: false,
    reservation: { member_state: 'recorded', assignment_id: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  }
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
  // Both stand in for folders that belong to a DevSpec project; without a marker the
  // guard has no jurisdiction and correctly ignores them (see its own describe below).
  writeDevspecMarker(repoA)
  writeDevspecMarker(repoB)
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

  it('treats the project claim as provenance authority across repository targets', () => {
    claim()
    for (const [tool, target] of [
      ['Write', path.join(repoA, 'new.txt')],
      ['Edit', path.join(repoB, 'existing.txt')],
      ['NotebookEdit', path.join(repoB, 'book.ipynb')],
    ]) {
      assert.equal(handlePre(mutationInput(tool, target), { env }), null, `${tool}: ${target}`)
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

    // Corrupt the file the guard actually wrote rather than re-deriving its
    // path here: a test that recomputes the key silently stops testing anything
    // the moment the key changes, which is exactly what happened when evidence
    // moved from the checkout to the repository (devspec:a0a90df4).
    fs.writeFileSync(path.join(env.DEVSPEC_CLAUDE_STATE_DIR, files[0]), '{broken', { mode: 0o600 })
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
  it('allows the reported compound inspection against another repository', () => {
    const command = [
      `WT=${repoB}`, "printf '%s\\n' status", 'git -C "$WT" status --short --branch',
      'git -C "$WT" diff --stat', 'git -C "$WT" ls-files --others --exclude-standard',
      'git -C "$WT" log --oneline --decorate -8',
    ].join('\n')
    assert.equal(isReadOnlyBootstrapCommand(command), true)
    assert.equal(handlePre(input('Bash', repoA, { tool_input: { command } }), { env }), null)
  })

  for (const command of [
    'pwd; rm -rf .', 'git status --short && touch owned', 'git status | tee evidence',
    'git diff --name-only > evidence', 'git diff --ext-diff', 'echo $(touch owned)', 'git status\nrm -rf .',
    'sort input -o owned', 'uniq input owned', 'find . -fprint0 owned', 'X=-delete; find . "$X"',
    'PATH=.:$PATH git status', 'GIT_EXTERNAL_DIFF=rm git diff', 'git -c alias.status=touch status',
    'git branch -D main', 'printf -v PATH .',
  ]) {
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
    'git merge --ff-only work/some-branch',
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
    `/usr/bin/git commit -m "fix [devspec:${ITEM}]"`,
  ]) {
    it(`denies direct/unverifiable commit production: ${command}`, () => {
      assert.ok(commitGateReason(command, ITEM))
      assert.equal(decision(handlePre(input('Bash', repoA, { tool_input: { command } }), { env })), 'deny')
    })
  }

  it('checks each segment of a compound instead of refusing every chained git command', () => {
    assert.equal(commitGateReason('git add file && git status --short', ITEM), null)
    assert.equal(commitGateReason(`git add file && git commit -m "fix [devspec:${ITEM}]"`, ITEM), null)
    assert.ok(commitGateReason('git add file && git commit -m fix', ITEM))
  })
})

describe('observation of the shapes the DevSpec server actually returns', () => {
  it('records evidence from a real claim_work_item result', () => {
    claim()
    assert.equal(handlePre(mutationInput('Write'), { env }), null)
  })

  it('requires the claimed id to sit on the object carrying claim_success', () => {
    claim(repoA, SESSION, ITEM, {
      content: [{ type: 'text', text: JSON.stringify({ claim_success: true, data: { id: ITEM } }) }],
    })
    assert.equal(decision(handlePre(mutationInput('Write'), { env })), 'deny')
  })

  it('ignores a real-shaped claim result for a different item', () => {
    claim(repoA, SESSION, ITEM, {
      content: [{ type: 'text', text: JSON.stringify(serverClaimPayload(OTHER_ITEM)) }],
    })
    assert.equal(decision(handlePre(mutationInput('Write'), { env })), 'deny')
  })

  it('clears evidence from a real record_implementation result', () => {
    claim()
    assert.equal(handlePre(mutationInput('Write'), { env }), null)
    handlePost(input('mcp__devspec__record_implementation', repoA, {
      hook_event_name: 'PostToolUse',
      tool_input: { action_item_id: ITEM },
      tool_response: { content: [{ type: 'text', text: JSON.stringify(serverRecordPayload()) }] },
    }), { env })
    assert.equal(decision(handlePre(mutationInput('Write'), { env })), 'deny')
  })

  it('keeps evidence when a terminal result names another item or reports an error', () => {
    for (const response of [
      { content: [{ type: 'text', text: JSON.stringify(serverRecordPayload(OTHER_ITEM)) }] },
      { content: [{ type: 'text', text: JSON.stringify({ ...serverRecordPayload(), error: 'nope' }) }] },
    ]) {
      claim()
      handlePost(input('mcp__devspec__record_implementation', repoA, {
        hook_event_name: 'PostToolUse',
        tool_input: { action_item_id: ITEM },
        tool_response: response,
      }), { env })
      assert.equal(handlePre(mutationInput('Write'), { env }), null)
    }
  })
})

describe('quote-aware classification of unclaimed shell commands', () => {
  it('allows read-only git inspection of a path containing spaces', () => {
    const spaced = path.join(sandbox, 'repo with space')
    gitInit(spaced)
    for (const command of [
      `git -C "${spaced}" log --oneline -3`,
      `git -C "${spaced}" status --short --branch`,
      `ls "${spaced}"`,
      `cat "${path.join(spaced, 'missing file.txt')}"`,
    ]) {
      assert.equal(isReadOnlyBootstrapCommand(command), true, command)
      assert.equal(handlePre(input('Bash', repoA, { tool_input: { command } }), { env }), null, command)
    }
  })

  it('allows a compound cross-repository inspection when both paths contain spaces', () => {
    const spacedA = path.join(sandbox, 'repo one with space')
    const spacedB = path.join(sandbox, 'repo two with space')
    gitInit(spacedA)
    gitInit(spacedB)
    const command = [
      `git -C "${spacedA}" status --short --branch`,
      `git -C "${spacedB}" diff --stat`,
      `git -C "${spacedB}" log --oneline --decorate -8`,
    ].join(' && ')
    assert.equal(isReadOnlyBootstrapCommand(command), true)
    assert.equal(handlePre(input('Bash', repoA, { tool_input: { command } }), { env }), null)
  })

  for (const command of ['grep -n "=>" README.md', 'grep -rn "a < b" .', "grep -n 'x > y' README.md"]) {
    it(`treats a redirection character inside quotes as literal text: ${command}`, () => {
      assert.equal(isReadOnlyBootstrapCommand(command), true)
      assert.equal(handlePre(input('Bash', repoA, { tool_input: { command } }), { env }), null)
    })
  }

  for (const command of [
    'git diff > out', 'echo `touch owned`', 'echo "`touch owned`"',
    '(touch owned)', 'git status --short; touch owned', 'ls "unterminated',
  ]) {
    it(`still denies real shell structure: ${JSON.stringify(command)}`, () => {
      assert.equal(isReadOnlyBootstrapCommand(command), false)
      assert.equal(decision(handlePre(input('Bash', repoA, { tool_input: { command } }), { env })), 'deny')
    })
  }
})

describe('redirections are parsed, not refused', () => {
  function bash(command, cwd = repoA) {
    return handlePre(input('Bash', cwd, { tool_input: { command } }), { env })
  }

  it('parses a redirection out of the words instead of rejecting the command', () => {
    assert.deepEqual(shellSegments('ls -a 2>&1'), [
      { words: ['ls', '-a'], redirects: [{ fd: '2', op: '>&', target: '1' }] },
    ])
    assert.deepEqual(shellSegments('grep x y 2>/dev/null'), [
      { words: ['grep', 'x', 'y'], redirects: [{ fd: '2', op: '>', target: '/dev/null' }] },
    ])
    assert.deepEqual(shellSegments('cat < in'), [
      { words: ['cat'], redirects: [{ fd: null, op: '<', target: 'in' }] },
    ])
    assert.deepEqual(shellSegments('echo hi >> log.txt'), [
      { words: ['echo', 'hi'], redirects: [{ fd: null, op: '>>', target: 'log.txt' }] },
    ])
    assert.deepEqual(shellSegments('make &> out'), [
      { words: ['make'], redirects: [{ fd: null, op: '&>', target: 'out' }] },
    ])
  })

  it('reads a digit as a descriptor only when it touches the operator', () => {
    // The shell writes "2" into the file here; the 2 is an argument, not an fd.
    assert.deepEqual(shellSegments('echo 2 > file'), [
      { words: ['echo', '2'], redirects: [{ fd: null, op: '>', target: 'file' }] },
    ])
  })

  it('refuses shapes it cannot model rather than half-understanding them', () => {
    for (const command of ['cat <<EOF', 'cat <<<"x"', 'ls >', 'ls > ; echo hi', 'ls > > f']) {
      assert.equal(shellSegments(command), null, command)
      assert.equal(isReadOnlyBootstrapCommand(command), false, command)
    }
  })

  /**
   * The defect this fixes: a redirect made the command unparseable, so every gate
   * failed closed and the deny message's promise of read-only investigation was
   * false for anything as ordinary as `2>/dev/null` (devspec:7be7469f).
   */
  it('allows read-only investigation carrying an inert redirection', () => {
    for (const command of [
      'grep -n x README.md 2>/dev/null',
      'ls -a 2>&1',
      'cat < in',
      'git -C . status --short 2>/dev/null',
      'ls -a 2>&1 | head -20',
      'grep -rn x . 2>/dev/null && ls 2>&1',
      'ls >/dev/null 2>&1',
    ]) {
      assert.equal(isReadOnlyBootstrapCommand(command), true, command)
      assert.equal(bash(command), null, command)
    }
  })

  it('still denies a redirection that can write to a real path', () => {
    for (const command of [
      'echo x > out.txt',
      'ls >> listing.txt',
      'cat a >| b',
      'ls &> everything.log',
      'ls >& everything.log',
      'grep x y 2> errors.log',
      'ls > "$HOME/x"',
      'cat a <> b',
    ]) {
      assert.equal(isReadOnlyBootstrapCommand(command), false, command)
      assert.equal(decision(bash(command)), 'deny', command)
    }
  })

  it('treats a duplication as inert only when its target is a descriptor', () => {
    for (const command of ['ls 2>&1', 'ls 2>&-', 'ls 2>&1-', 'ls <&0']) {
      assert.equal(isReadOnlyBootstrapCommand(command), true, command)
    }
    assert.equal(isReadOnlyBootstrapCommand('ls 2>&out'), false, 'bash sends both streams to a file here')
  })

  it('judges every segment of a compound, not just the first', () => {
    assert.equal(isReadOnlyBootstrapCommand('ls 2>&1 && echo x > owned'), false)
    assert.equal(isReadOnlyBootstrapCommand('ls 2>&1 | tee owned'), false)
  })
})

describe('the commit gate ignores redirections', () => {
  function bash(command) {
    return handlePre(input('Bash', repoA, { tool_input: { command } }), { env })
  }

  it('no longer calls a redirected read-only git command unverifiable', () => {
    claim()
    assert.equal(commitGateReason('git log --oneline -5 > out.txt', ITEM), null)
    assert.equal(bash('git log --oneline -5 > out.txt'), null)
  })

  it('still requires the claim tag on a commit that redirects its output', () => {
    claim()
    const command = 'git commit -m "no tag" > out.txt'
    assert.match(commitGateReason(command, ITEM), /needs \[devspec:/)
    assert.equal(decision(bash(command)), 'deny')
  })

  it('accepts a tagged commit that redirects its output', () => {
    claim()
    const command = `git commit -m "fix: thing [devspec:${ITEM}]" > out.txt`
    assert.equal(commitGateReason(command, ITEM), null)
    assert.equal(bash(command), null)
  })

  it('keeps failing closed on a git shape it cannot parse', () => {
    assert.match(commitGateReason('git commit <<EOF', ITEM), /cannot be verified/)
  })
})

/**
 * The guard is installed at USER scope, so its PreToolUse hook fires in every folder
 * on the machine. Gating each one on a DevSpec claim blocked ordinary work in
 * unrelated projects, where no such claim can ever arrive (devspec:7be7469f).
 */
describe('jurisdiction — only folders that belong to a DevSpec project', () => {
  let outside

  function writeIn(directory, tool = 'Write') {
    const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path'
    return input(tool, directory, { tool_input: { [key]: path.join(directory, 'x.ts') } })
  }

  beforeEach(() => {
    outside = path.join(sandbox, 'unrelated')
    gitInit(outside)
  })

  it('ignores every mutation in a folder carrying no DevSpec marker', () => {
    for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
      assert.equal(handlePre(writeIn(outside, tool), { env }), null, tool)
    }
    for (const command of ['echo x > out.txt', 'rm -rf .', 'git commit -m "untagged"']) {
      assert.equal(handlePre(input('Bash', outside, { tool_input: { command } }), { env }), null, command)
    }
  })

  it('takes jurisdiction from a .mcp.json that registers DevSpec', () => {
    writeDevspecMarker(outside)
    assert.equal(decision(handlePre(writeIn(outside), { env })), 'deny')
  })

  it('takes jurisdiction from a .devspec/project.json pin', () => {
    writeProjectPin(outside)
    assert.equal(decision(handlePre(writeIn(outside), { env })), 'deny')
  })

  it('takes jurisdiction from a project that enables the DevSpec plugin', () => {
    fs.mkdirSync(path.join(outside, '.claude'), { recursive: true })
    fs.writeFileSync(
      path.join(outside, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'devspec-autopilot@devspec': true } }),
    )
    assert.equal(decision(handlePre(writeIn(outside), { env })), 'deny')
  })

  it('does not take jurisdiction from a config that merely mentions devspec', () => {
    fs.writeFileSync(path.join(outside, '.mcp.json'), JSON.stringify({
      mcpServers: { supabase: { url: 'https://mcp.supabase.com/mcp' } },
      note: 'the devspec project lives elsewhere',
    }))
    assert.equal(handlePre(writeIn(outside), { env }), null)
  })

  it('ignores an unreadable or malformed marker rather than throwing', () => {
    fs.writeFileSync(path.join(outside, '.mcp.json'), '{not json')
    assert.equal(handlePre(writeIn(outside), { env }), null)
  })

  it('finds the marker from a subdirectory of the project', () => {
    const nested = path.join(repoA, 'apps', 'web')
    fs.mkdirSync(nested, { recursive: true })
    assert.equal(decision(handlePre(writeIn(nested), { env })), 'deny')
  })

  /**
   * The contract asks agents to work in a linked worktree, worktrees are routinely
   * created outside the repository root, and `.mcp.json` is untracked — so the
   * worktree's own checkout has no marker. Keying on the cwd chain alone would switch
   * the guard off for exactly the isolation the contract tells agents to use.
   */
  it('gives a linked worktree the repository jurisdiction its own checkout lacks', () => {
    gitCommit(repoA)
    const worktree = path.join(sandbox, 'wt-jurisdiction')
    addWorktree(repoA, worktree)
    assert.equal(fs.existsSync(path.join(worktree, '.mcp.json')), false, 'the marker is genuinely absent')
    assert.equal(decision(handlePre(writeIn(worktree), { env })), 'deny')
  })

  it('never takes jurisdiction from a marker at or above the home directory', () => {
    const home = fs.mkdtempSync(path.join(sandbox, 'home-'))
    writeDevspecMarker(home)
    const plain = path.join(home, 'somewhere')
    fs.mkdirSync(plain)
    assert.equal(handlePre(writeIn(plain), { env: { ...env, HOME: home, USERPROFILE: home } }), null)
  })

  it('keeps a tracking session fully gated even where jurisdiction is absent', () => {
    claim(outside)
    assert.equal(
      decision(handlePre(input('Bash', outside, { tool_input: { command: 'git commit -m "untagged"' } }), { env })),
      'deny',
      'a held claim still owes the commit gate its tag',
    )
  })

  it('stands down instead of denying when the hook input has no usable scope', () => {
    assert.equal(handlePre(input('Write', repoA, { session_id: '' }), { env }), null)
    assert.equal(handlePre(input('Write', path.join(sandbox, 'missing'), {}), { env }), null)
  })
})

describe('DevSpec control-plane commands before any claim', () => {
  const CONNECT = path.join(HERE, 'devspec-remote-connect.mjs')
  const STATE = path.join(HERE, 'remote-control-state.mjs')
  const WAIT = path.join(HERE, 'devspec-remote-wait.mjs')

  it('allows the documented /devspec.remote connect invocation', () => {
    const command = `node "${CONNECT}" \\\n  --agent "Claude Code" --owner-pid "$PPID"`
    assert.equal(isPluginControlPlaneCommand(command), true)
    assert.equal(handlePre(input('Bash', repoA, { tool_input: { command } }), { env }), null)
  })

  /**
   * The reported failure: `/devspec.remote` prints this command, an agent appends the
   * redirect to capture stderr, and the guard denied the one command that must work
   * before a claim can exist — so remote control could not be reached at all.
   */
  it('allows the connect invocation when it carries a stderr redirection', () => {
    for (const command of [
      `node "${CONNECT}" --agent "Claude Code" --owner-pid "$PPID" 2>&1`,
      `node "${CONNECT}" --agent "Claude Code" 2>/dev/null`,
      `node "${CONNECT}" --agent "Claude Code" >/dev/null 2>&1`,
    ]) {
      assert.equal(isPluginControlPlaneCommand(command), true, command)
      assert.equal(handlePre(input('Bash', repoA, { tool_input: { command } }), { env }), null, command)
    }
  })

  it('refuses a control-plane script whose redirection writes a file', () => {
    for (const command of [
      `node "${CONNECT}" > owned`,
      `node "${CONNECT}" 2> owned`,
      `node "${CONNECT}" >& owned`,
      `node "${CONNECT}" &> owned`,
    ]) {
      assert.equal(isPluginControlPlaneCommand(command), false, command)
      assert.equal(decision(handlePre(input('Bash', repoA, { tool_input: { command } }), { env })), 'deny', command)
    }
  })

  it('allows the /devspec.remote-stop and wait-stream invocations', () => {
    for (const command of [
      `node "${STATE}" resolve-local --agent "Claude Code"`,
      `node "${STATE}" disable --connection-id dddddddd-dddd-4ddd-8ddd-dddddddddddd`,
      `node "${WAIT}" --connection-id dddddddd-dddd-4ddd-8ddd-dddddddddddd --owner-pid "$PPID" --stream --from-end`,
    ]) {
      assert.equal(isPluginControlPlaneCommand(command), true, command)
      assert.equal(handlePre(input('Bash', repoA, { tool_input: { command } }), { env }), null, command)
    }
  })

  it('keys the allowance on script identity, not on the node program', () => {
    const impostor = path.join(sandbox, 'devspec-remote-connect.mjs')
    fs.writeFileSync(impostor, 'process.exit(0)\n')
    for (const command of [
      'node -e "fs.writeFileSync(0,0)"',
      'node -p 1',
      'node --eval "1"',
      `node --require /tmp/preload.js "${CONNECT}"`,
      `node --input-type=module -e "1"`,
      `node "${impostor}"`,
      `node "${path.join(HERE, 'claim-guard.mjs')}" pre`,
      `node "${CONNECT}" --agent \`whoami\``,
      `node "${CONNECT}" --agent "$(whoami)"`,
      `node "${CONNECT}" && touch owned`,
      `node "${CONNECT}" > owned`,
      `NODE_OPTIONS=--require/tmp/x node "${CONNECT}"`,
      `node "${path.relative(process.cwd(), CONNECT)}"`,
    ]) {
      assert.equal(isPluginControlPlaneCommand(command), false, command)
      assert.equal(decision(handlePre(input('Bash', repoA, { tool_input: { command } }), { env })), 'deny', command)
    }
  })

  it('does not turn into a general node allowance once claimed or unclaimed', () => {
    assert.equal(isPluginControlPlaneCommand('node --test'), false)
    assert.equal(isPluginControlPlaneCommand('node script.js'), false)
    assert.equal(decision(handlePre(input('Bash', repoA, { tool_input: { command: 'node --test' } }), { env })), 'deny')
  })

  it('accepts node.exe for the same script', () => {
    assert.equal(isPluginControlPlaneCommand(`node.exe "${CONNECT}" --agent "Claude Code"`), true)
    assert.equal(isPluginControlPlaneCommand(`node.exe -e "1"`), false)
  })
})

describe('cross-platform tokenisation', () => {
  it('keeps a backslash literal inside double quotes so Windows paths survive', () => {
    const spaced = path.join(sandbox, 'repo with space')
    gitInit(spaced)
    // A real shell only treats \ as an escape before $ ` " \ or a newline.
    assert.deepEqual(shellSegments('echo "C:\\Users\\x\\hooks"'), [words('echo', 'C:\\Users\\x\\hooks')])
    assert.deepEqual(shellSegments('echo "a\\"b"'), [words('echo', 'a"b')])
    assert.deepEqual(shellSegments('echo "a\\\\b"'), [words('echo', 'a\\b')])
    assert.equal(isReadOnlyBootstrapCommand(`ls "${spaced}"`), true)
  })

  it('treats a backslash before a newline as a line continuation, LF or CRLF', () => {
    assert.deepEqual(shellSegments('echo one \\\n  two'), [words('echo', 'one', 'two')])
    assert.deepEqual(shellSegments('echo one \\\r\n  two'), [words('echo', 'one', 'two')])
    assert.deepEqual(shellSegments('echo "one \\\r\ntwo"'), [words('echo', 'one two')])
  })

  it('allows the connect invocation when it arrives with CRLF line endings', () => {
    const command = `node "${path.join(HERE, 'devspec-remote-connect.mjs')}" \\\r\n  --agent "Claude Code" --owner-pid "$PPID"`
    assert.equal(isPluginControlPlaneCommand(command), true)
    assert.equal(handlePre(input('Bash', repoA, { tool_input: { command } }), { env }), null)
  })
})

describe('POSIX permission bits are asserted only where they mean something', () => {
  function claimThen(platform) {
    claim()
    return handlePre(mutationInput('Write'), { env, platform })
  }

  it('reads back a claim on a platform whose directory mode is synthetic', () => {
    claim()
    const dir = env.DEVSPEC_CLAUDE_STATE_DIR
    // What Node reports on Windows: 0o777 directories, 0o666 files.
    fs.chmodSync(dir, 0o777)
    fs.chmodSync(path.join(dir, fs.readdirSync(dir)[0]), 0o666)
    assert.equal(handlePre(mutationInput('Write'), { env, platform: 'win32' }), null)
    assert.equal(decision(handlePre(mutationInput('Write'), { env, platform: 'linux' })), 'deny')
  })

  it('still enforces the private modes on a POSIX platform', () => {
    assert.equal(claimThen('linux'), null)
    fs.chmodSync(env.DEVSPEC_CLAUDE_STATE_DIR, 0o755)
    assert.equal(decision(handlePre(mutationInput('Write'), { env, platform: 'linux' })), 'deny')
    fs.chmodSync(env.DEVSPEC_CLAUDE_STATE_DIR, 0o700)
  })

  it('records a claim without throwing where chmod cannot express the mode', () => {
    handlePost(input('mcp__devspec__claim_work_item', repoA, {
      hook_event_name: 'PostToolUse',
      tool_input: { action_item_id: ITEM },
      tool_response: { content: [{ type: 'text', text: JSON.stringify(serverClaimPayload()) }] },
    }), { env, platform: 'win32' })
    assert.equal(handlePre(mutationInput('Write'), { env, platform: 'win32' }), null)
  })
})

describe('writes the mutation gate has no interest in', () => {
  let home
  let memoryDir
  let scratchRoot
  let scratchDir

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(sandbox, 'home-'))
    memoryDir = path.join(home, '.claude', 'projects', '-home-someone-project', 'memory')
    fs.mkdirSync(memoryDir, { recursive: true })
    // A real scratchpad root, but a unique one: <tmp>/claude-<uid>/… is where
    // live sessions keep theirs, and this suite must never remove those.
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-guardtest-'))
    scratchDir = path.join(scratchRoot, 'proj', 'sess', 'scratchpad')
    fs.mkdirSync(scratchDir, { recursive: true })
    env = { ...env, HOME: home, USERPROFILE: home }
  })

  afterEach(() => fs.rmSync(scratchRoot, { recursive: true, force: true }))

  it('allows a memory write with no claim, and still allows it after the claim is settled', () => {
    const target = path.join(memoryDir, 'MEMORY.md')
    assert.equal(handlePre(mutationInput('Write', target), { env }), null)

    claim()
    handlePost(input('mcp__devspec__record_implementation', repoA, {
      hook_event_name: 'PostToolUse',
      tool_input: { action_item_id: ITEM },
      tool_response: { content: [{ type: 'text', text: JSON.stringify(serverRecordPayload()) }] },
    }), { env })
    assert.equal(decision(handlePre(mutationInput('Write'), { env })), 'deny', 'repo writes re-lock')
    assert.equal(handlePre(mutationInput('Write', target), { env }), null, 'memory writes do not')
  })

  it('allows a scratchpad write with no claim', () => {
    assert.equal(handlePre(mutationInput('Write', path.join(scratchDir, 'notes.md')), { env }), null)
  })

  it('never permits the claim state directory', () => {
    const forged = path.join(env.DEVSPEC_CLAUDE_STATE_DIR, 'forged.json')
    assert.equal(decision(handlePre(mutationInput('Write', forged), { env })), 'deny')
  })

  it('permits the memory directory only, not the rest of ~/.claude', () => {
    for (const target of [
      path.join(home, '.claude', 'settings.json'),
      path.join(home, '.claude', 'CLAUDE.md'),
      path.join(home, '.claude', 'plugins', 'evil.mjs'),
      path.join(home, '.claude', 'projects', '-home-someone-project', 'notes.md'),
      path.join(home, '.claude', 'projects', 'settings.json'),
    ]) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      assert.equal(decision(handlePre(mutationInput('Write', target), { env })), 'deny', target)
    }
  })

  it('resolves a symlink out of the memory directory before deciding', () => {
    const escape = path.join(memoryDir, 'escape')
    fs.symlinkSync(repoA, escape, 'dir')
    assert.equal(decision(handlePre(mutationInput('Write', path.join(escape, 'pwned.ts')), { env })), 'deny')
  })

  it('leaves ordinary repository writes denied', () => {
    assert.equal(decision(handlePre(mutationInput('Write'), { env })), 'deny')
    assert.equal(decision(handlePre(mutationInput('Write', path.join(repoB, 'x.ts')), { env })), 'deny')
  })
})

describe('evidence is scoped to the repository, not the checkout', () => {
  let worktree

  beforeEach(() => {
    gitCommit(repoA)
    worktree = path.join(sandbox, 'wt-a')
    addWorktree(repoA, worktree)
  })

  function writeIn(directory, overrides = {}) {
    return input('Write', directory, { tool_input: { file_path: path.join(directory, 'x.ts') }, ...overrides })
  }

  /**
   * A worktree's `--show-toplevel` is the worktree, so keying on it lost the
   * claim the moment the session cwd moved into one — which is exactly what the
   * implementation contract tells an agent to do, and what `Agent(isolation:
   * 'worktree')` does to a delegated subagent (devspec:a0a90df4).
   */
  it('shows a claim made in the main checkout to a session working in its worktree', () => {
    claim(repoA)
    assert.equal(handlePre(writeIn(worktree), { env }), null)
    assert.equal(handlePre(input('Bash', worktree, { tool_input: { command: 'node --test' } }), { env }), null)
  })

  it('shows a claim made in a worktree to the main checkout', () => {
    claim(worktree)
    assert.equal(handlePre(mutationInput('Write'), { env }), null)
  })

  it('still isolates another repository and another session', () => {
    claim(repoA)
    assert.equal(decision(handlePre(writeIn(repoB), { env })), 'deny')
    assert.equal(
      decision(handlePre(writeIn(worktree, { session_id: 'another-session-1234' }), { env })),
      'deny',
    )
  })

  it('falls back to the canonical directory outside a repository', () => {
    const plain = path.join(sandbox, 'not-a-repo')
    fs.mkdirSync(plain)
    // Marked, so this still tests claim scoping rather than passing for want of
    // jurisdiction — a pinned folder with no repo is the greenfield case.
    writeProjectPin(plain)
    claim(plain)
    assert.equal(handlePre(writeIn(plain), { env }), null)
    assert.equal(decision(handlePre(writeIn(repoB), { env })), 'deny')
  })
})
