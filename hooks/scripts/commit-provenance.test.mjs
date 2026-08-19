#!/usr/bin/env node
/**
 * Tests for DevSpec commit provenance assistance (item e21d7d4b, ADR 71c23b46).
 *
 * The suite is organised around the property that replaced the old guard: this hook
 * blocks only on certainty, and everything else — including every command shape the
 * previous classifier argued about — is allowed. So the largest block below is a list
 * of things that must NEVER be denied, and it is deliberately stocked with the exact
 * commands that were denied in the field.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  CONTRACT_URI,
  handlePost,
  handlePre,
  handleSessionStart,
  isSimpleGitPush,
  readClaims,
  referenceIn,
  simpleGitCommit,
} from './commit-provenance.mjs'

const ITEM = 'cdd7a494-ed6a-414b-9f8f-bd0741b9de55'
const OTHER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION = 'session-12345678'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'commit-provenance.mjs')
const PLUGIN_ROOT = path.resolve(HERE, '../..')
let sandbox
let repo
let env

function gitInit(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const result = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

/** A folder DevSpec has positive local jurisdiction over. Normally untracked. */
function markDevspecProject(dir) {
  fs.writeFileSync(
    path.join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { devspec: { type: 'http', url: 'https://example.invalid/api/mcp' } } }),
  )
}

function input(toolName, toolInput, overrides = {}) {
  return {
    session_id: SESSION,
    cwd: repo,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    ...overrides,
  }
}

const bash = (command, overrides) => handlePre(input('Bash', { command }, overrides), { env })
const decision = (result) => result?.hookSpecificOutput?.permissionDecision ?? null
const updated = (result) => result?.hookSpecificOutput?.updatedInput?.command ?? null

function claim(itemId = ITEM, cwd = repo) {
  return handlePost({
    session_id: SESSION,
    cwd,
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__devspec__claim_work_item',
    tool_input: { action_item_id: itemId },
    tool_response: { content: [{ type: 'text', text: JSON.stringify({ id: itemId, claim_success: true }) }] },
  }, { env })
}

function record(itemId = ITEM, cwd = repo) {
  return handlePost({
    session_id: SESSION,
    cwd,
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__devspec__record_implementation',
    tool_input: { action_item_id: itemId },
    tool_response: {
      content: [{ type: 'text', text: JSON.stringify({ id: itemId, lifecycle: 'implemented' }) }],
    },
  }, { env })
}

function scope(cwd = repo, sessionId = SESSION) {
  return { sessionId, cwd: fs.realpathSync(cwd), repoRoot: fs.realpathSync(path.join(cwd, '.git')) }
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-test-'))
  repo = path.join(sandbox, 'repo')
  gitInit(repo)
  markDevspecProject(repo)
  env = { ...process.env, DEVSPEC_CLAUDE_STATE_DIR: path.join(sandbox, 'state') }
})

afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }))

describe('nothing is ever denied for lack of a claim', () => {
  /**
   * Every entry here was denied by the predecessor in real use. They are the reason
   * the enforcement object moved from behaviour to the commit artifact.
   */
  const NEVER_DENIED = [
    'rm -rf apps',
    'echo x > apps/web/lib/thing.ts',
    'sed -i "s/a/b/" file.ts',
    'npm run typecheck',
    'npm test',
    'node --test hooks/scripts',
    'node probe.mjs',
    'ls -a 2>&1',
    'grep -rn devspec apps 2>/dev/null',
    'cat <<EOF > out.txt',
    'P="/tmp/x"; git -C "$P" status',
    'git fetch origin',
    'git rebase origin/main',
    'git stash',
    'git pull --ff-only',
    'ls | tee owned',
    '(touch owned)',
    'echo `touch owned`',
    'git commit --amend --no-edit',
    'mkdir -p build && cp a b',
    'npx playwright test',
  ]

  for (const command of NEVER_DENIED) {
    it(`allows: ${command}`, () => {
      assert.equal(decision(bash(command)), null, command)
    })
  }

  it('never denies a file edit, with or without a claim', () => {
    for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
      const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path'
      assert.equal(decision(handlePre(input(tool, { [key]: path.join(repo, 'x.ts') }), { env })), null, tool)
    }
    claim()
    for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
      const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path'
      assert.equal(handlePre(input(tool, { [key]: path.join(repo, 'x.ts') }), { env }), null, tool)
    }
  })

  it('has no unattended or delegated special case that could deny', () => {
    for (const overrides of [
      { unattended: true },
      { dispatch_mode: 'unattended' },
      { agent_type: 'subagent' },
      { session_id: 'delegated-subagent-99' },
    ]) {
      assert.equal(decision(bash('rm -rf apps', overrides)), null, JSON.stringify(overrides))
    }
  })
})

describe('the old classifier is gone, not dormant', () => {
  it('removed claim-guard.mjs entirely', () => {
    assert.equal(fs.existsSync(path.join(HERE, 'claim-guard.mjs')), false)
    assert.equal(fs.existsSync(path.join(HERE, 'claim-guard.test.mjs')), false)
  })

  it('exports no read-only allowlist, tokenizer or control-plane allowance', async () => {
    const module = await import('./commit-provenance.mjs')
    for (const gone of [
      'isReadOnlyBootstrapCommand',
      'isPluginControlPlaneCommand',
      'shellSegments',
      'commitGateReason',
      'commitCommandHasClaimTag',
    ]) {
      assert.equal(module[gone], undefined, `${gone} must not come back`)
    }
  })

  it('needs no allowance for the plugin\'s own control-plane commands', () => {
    const connect = path.join(HERE, 'devspec-remote-connect.mjs')
    assert.equal(decision(bash(`node "${connect}" --agent "Claude Code" --owner-pid "$PPID" 2>&1`)), null)
  })
})

describe('reading a commit message only where it is unambiguous', () => {
  it('recognises the simple forms and locates the message', () => {
    assert.equal(simpleGitCommit('git commit -m "hello"').message, 'hello')
    assert.equal(simpleGitCommit("git commit -m 'hello'").message, 'hello')
    assert.equal(simpleGitCommit('git commit -m "hello" --no-verify').message, 'hello')
    assert.equal(simpleGitCommit('git commit --message="hello"').message, 'hello')
    assert.equal(simpleGitCommit('git commit -m"hello"').message, 'hello')
    assert.equal(simpleGitCommit('git commit -a -m "hello"').message, 'hello')
  })

  /**
   * The forms that actually reach a worktree. Claude resets the shell cwd every call,
   * so isolated work — which the implementation contract requires — can only commit
   * through one of these two. Refusing them left the check unable to read any commit
   * real agent work produces.
   */
  it('reads the two forms that reach a worktree', () => {
    assert.equal(simpleGitCommit('cd /tmp/wt && git commit -m "hello"').message, 'hello')
    assert.equal(simpleGitCommit('cd "/tmp/a b/wt" && git commit -m "hello"').message, 'hello')
    assert.equal(simpleGitCommit('git -C /tmp/wt commit -m "hello"').message, 'hello')
    assert.equal(simpleGitCommit('git -C /tmp/wt commit -a -m "hello"').message, 'hello')
    assert.equal(simpleGitCommit('git --no-pager commit -m "hello"').message, 'hello')
    assert.equal(simpleGitCommit('cd /tmp/wt && git -C /other commit -m "hello"').message, 'hello')
  })

  it('still refuses prefixes and separators it cannot vouch for', () => {
    for (const command of [
      'cd /tmp/wt; git commit -m "x"',            // ; is not the separator it reads
      'cd /tmp/a && cd /tmp/b && git commit -m "x"', // more than one separator
      'npm test && git commit -m "x"',            // prefix is not cd
      'git add -A && git commit -m "x"',          // prefix is not cd
      'cd -P /tmp/wt && git commit -m "x"',       // cd with an option
      'cd && git commit -m "x"',                  // cd with no path
      'cd /a /b && git commit -m "x"',            // cd with two words
      'git -C commit -m "x"',                     // -C swallowing the verb
      'git --git-dir=/x commit -m "x"',           // an option that could take a value
    ]) {
      assert.equal(simpleGitCommit(command), null, command)
      assert.equal(decision(bash(command)), null, `${command} must be allowed`)
    }
  })

  it('keeps shell-special characters that are legitimate message text', () => {
    // Refusing these would hand ordinary messages to the analyzer for no reason.
    assert.equal(simpleGitCommit('git commit -m "fix(api): handle {a,b}; done"').message, 'fix(api): handle {a,b}; done')
    assert.equal(simpleGitCommit("git commit -m 'cost is $5 & rising'").message, 'cost is $5 & rising')
  })

  it('refuses — and therefore allows — everything it cannot read honestly', () => {
    for (const command of [
      'git commit',                                   // editor supplies the message
      'git commit -m "$MSG"',                         // expansion
      'git commit -m "a" -m "b"',                     // two message parts
      'git commit -F msg.txt',
      'git commit --file=msg.txt',
      'git commit --amend -m "x"',
      'git commit -C HEAD',
      'git commit --squash HEAD -m "x"',
      '/usr/bin/git commit -m "x"',                   // path-qualified
      'g commit -m "x"',                              // alias
      'git add -A && git commit -m "x"',              // compound
      'git commit -m "x" | tee log',
      'git commit -m "unterminated',
      'git commit -m "back\\slash"',
    ]) {
      assert.equal(simpleGitCommit(command), null, command)
      assert.equal(decision(bash(command)), null, `${command} must be allowed`)
    }
  })

  it('never treats a push as a commit, and never blocks one', () => {
    assert.equal(isSimpleGitPush('git push origin main'), true)
    assert.equal(isSimpleGitPush('git push'), true)
    assert.equal(isSimpleGitPush('git commit -m "x"'), false)
    // Push has no safe non-destructive recovery implemented, so it must not block.
    for (const command of ['git push', 'git push origin main', 'git push --force-with-lease']) {
      assert.equal(decision(bash(command)), null, command)
    }
  })

  it('finds a reference only in its full-uuid form', () => {
    assert.equal(referenceIn(`fix: thing [devspec:${ITEM}]`), ITEM)
    assert.equal(referenceIn('fix: thing [devspec:cdd7a494]'), null, 'short code is not a link')
    assert.equal(referenceIn('fix: thing'), null)
  })
})

describe('a reference is a link — a live claim is not required', () => {
  it('allows a referenced commit with no claim at all', () => {
    assert.equal(bash(`git commit -m "fix: thing [devspec:${ITEM}]"`), null)
  })

  /** The exact regression that made the predecessor unusable after recording. */
  it('allows a referenced commit after record_implementation released the claim', () => {
    claim()
    record()
    assert.deepEqual(readClaims(scope(), { env }), [])
    assert.equal(bash(`git commit -m "follow-up [devspec:${ITEM}]"`), null)
  })

  it('allows a reference to an item other than the one currently claimed', () => {
    claim(ITEM)
    assert.equal(bash(`git commit -m "cross-repo work [devspec:${OTHER}]"`), null)
  })
})

describe('stamping, only when exactly one claim is unambiguous', () => {
  it('appends the reference inside the quoted message and reports it', () => {
    claim(ITEM)
    const result = bash('git commit -m "fix: the thing"')
    assert.equal(decision(result), null, 'stamping is not a denial')
    assert.equal(updated(result), `git commit -m "fix: the thing [devspec:${ITEM}]"`)
    assert.match(result.systemMessage, new RegExp(`stamped \\[devspec:${ITEM}\\]`))
  })

  it('preserves the rest of the command exactly', () => {
    claim(ITEM)
    assert.equal(
      updated(bash('git commit -a -m "subject" --no-verify')),
      `git commit -a -m "subject [devspec:${ITEM}]" --no-verify`,
    )
    assert.equal(updated(bash("git commit -m 'single quoted'")), `git commit -m 'single quoted [devspec:${ITEM}]'`)
    assert.equal(updated(bash('git commit -m"joined"')), `git commit -m"joined [devspec:${ITEM}]"`)
  })

  it('stamps the worktree-reaching forms at the right offset', () => {
    claim(ITEM)
    assert.equal(
      updated(bash('cd /tmp/wt && git commit -m "fix: thing"')),
      `cd /tmp/wt && git commit -m "fix: thing [devspec:${ITEM}]"`,
    )
    assert.equal(
      updated(bash('git -C /tmp/wt commit -m "fix: thing"')),
      `git -C /tmp/wt commit -m "fix: thing [devspec:${ITEM}]"`,
    )
    assert.equal(
      updated(bash('cd "/tmp/a b/wt" && git commit -a -m "subject" --no-verify')),
      `cd "/tmp/a b/wt" && git commit -a -m "subject [devspec:${ITEM}]" --no-verify`,
    )
  })

  it('refuses to guess between two active claims', () => {
    claim(ITEM)
    claim(OTHER)
    assert.deepEqual(readClaims(scope(), { env }).sort(), [OTHER, ITEM].sort())
    const result = bash('git commit -m "which item?"')
    assert.equal(decision(result), 'deny')
    assert.equal(updated(result), null, 'nothing may be stamped when ambiguous')
    const reason = result.hookSpecificOutput.permissionDecisionReason
    assert.match(reason, new RegExp(ITEM))
    assert.match(reason, new RegExp(OTHER))
  })

  it('resumes stamping once the ambiguity is resolved', () => {
    claim(ITEM)
    claim(OTHER)
    record(OTHER)
    assert.deepEqual(readClaims(scope(), { env }), [ITEM])
    assert.equal(updated(bash('git commit -m "now unambiguous"')), `git commit -m "now unambiguous [devspec:${ITEM}]"`)
  })

  it('does not stamp an unquoted message it cannot append to safely', () => {
    claim(ITEM)
    const result = bash('git commit -m bare')
    assert.equal(updated(result), null, 'appending would create a separate argument')
    assert.equal(decision(result), 'deny', 'so it asks the agent instead of corrupting the command')
  })
})

describe('denial is non-terminating and independently recoverable', () => {
  it('denies an unreferenced commit with a complete recovery route', () => {
    const result = bash('git commit -m "untracked work"')
    assert.equal(decision(result), 'deny')
    const reason = result.hookSpecificOutput.permissionDecisionReason
    for (const expected of [/create_action_item|search_action_items/, /\[devspec:/, /retry/i, /Nothing else is blocked/]) {
      assert.match(reason, expected)
    }
    assert.match(reason, new RegExp(CONTRACT_URI.replace(/[/:]/g, '\\$&')))
  })

  it('carries no field that would end the turn', () => {
    const result = bash('git commit -m "untracked work"')
    assert.equal(result.terminate, undefined)
    assert.equal(result.continue, undefined)
    assert.equal(result.stopReason, undefined)
    assert.equal(result.decision, undefined)
    assert.deepEqual(Object.keys(result), ['hookSpecificOutput'])
  })

  it('does not demand a full criteria set merely to commit', () => {
    const reason = bash('git commit -m "x"').hookSpecificOutput.permissionDecisionReason
    assert.match(reason, /thin\s+last-mile item is fine|smallest item/)
  })
})

describe('one nudge per session and repository, never more', () => {
  const editInput = () => input('Write', { file_path: path.join(repo, 'x.ts') })

  it('reminds once, then stays quiet', () => {
    const first = handlePre(editInput(), { env })
    assert.match(first.systemMessage, /no work item is claimed/i)
    assert.equal(decision(first), null, 'a nudge is never a denial')
    assert.equal(handlePre(editInput(), { env }), null)
    assert.equal(handlePre(editInput(), { env }), null)
  })

  it('says nothing at all when a claim is held', () => {
    claim()
    assert.equal(handlePre(editInput(), { env }), null)
  })

  it('says nothing outside a DevSpec project', () => {
    fs.rmSync(path.join(repo, '.mcp.json'))
    assert.equal(handlePre(editInput(), { env }), null)
  })
})

describe('jurisdiction is positive and local', () => {
  it('ignores a folder with no DevSpec marker', () => {
    const outside = path.join(sandbox, 'unrelated')
    gitInit(outside)
    assert.equal(handlePre(input('Bash', { command: 'git commit -m "x"' }, { cwd: outside }), { env }), null)
  })

  it('takes jurisdiction from a .devspec/project.json pin', () => {
    const pinned = path.join(sandbox, 'pinned')
    gitInit(pinned)
    fs.mkdirSync(path.join(pinned, '.devspec'))
    fs.writeFileSync(path.join(pinned, '.devspec', 'project.json'), JSON.stringify({ project_id: OTHER }))
    assert.equal(
      decision(handlePre(input('Bash', { command: 'git commit -m "x"' }, { cwd: pinned }), { env })),
      'deny',
    )
  })

  it('covers a linked worktree through the main checkout, whose marker is untracked', () => {
    spawnSync('git', ['-C', repo, '-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '--allow-empty', '-q', '-m', 'init'])
    const worktree = path.join(sandbox, 'wt')
    const added = spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', worktree], { encoding: 'utf8' })
    assert.equal(added.status, 0, added.stderr)
    assert.equal(fs.existsSync(path.join(worktree, '.mcp.json')), false, 'marker genuinely absent')
    assert.equal(
      decision(handlePre(input('Bash', { command: 'git commit -m "x"' }, { cwd: worktree }), { env })),
      'deny',
    )
  })

  it('never reads a marker at or above the home directory', () => {
    const home = fs.mkdtempSync(path.join(sandbox, 'home-'))
    markDevspecProject(home)
    const plain = path.join(home, 'work')
    fs.mkdirSync(plain)
    assert.equal(
      handlePre(input('Bash', { command: 'git commit -m "x"' }, { cwd: plain }), { env: { ...env, HOME: home, USERPROFILE: home } }),
      null,
    )
  })

  it('writes no pin and touches no folder of its own accord', () => {
    const before = fs.readdirSync(repo).sort()
    handlePre(input('Write', { file_path: path.join(repo, 'x.ts') }), { env })
    bash('git commit -m "x"')
    assert.deepEqual(fs.readdirSync(repo).sort(), before, 'the hook must not create .devspec or anything else')
  })
})

describe('uncertainty always allows', () => {
  it('allows when the hook input has no usable scope', () => {
    assert.equal(handlePre(input('Bash', { command: 'git commit -m "x"' }, { session_id: '' }), { env }), null)
    assert.equal(handlePre(input('Bash', { command: 'git commit -m "x"' }, { cwd: path.join(sandbox, 'gone') }), { env }), null)
  })

  it('allows when claim state is unreadable', () => {
    claim()
    fs.rmSync(path.join(sandbox, 'state'), { recursive: true, force: true })
    assert.equal(decision(bash(`git commit -m "x [devspec:${ITEM}]"`)), null)
  })

  it('ignores a stale or forged claim file rather than stamping from it', () => {
    claim()
    const stateFiles = fs.readdirSync(path.join(sandbox, 'state'))
    const claimsFile = path.join(sandbox, 'state', stateFiles.find((f) => f.endsWith('.claims.json')))
    fs.writeFileSync(claimsFile, JSON.stringify({ schema: 1, claims: [ITEM], updated_at: 0 }))
    assert.deepEqual(readClaims(scope(), { env }), [], 'an expired claim record is not a claim')
  })

  it('never invents a claim from a failed tool result', () => {
    handlePost({
      session_id: SESSION,
      cwd: repo,
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__devspec__claim_work_item',
      tool_input: { action_item_id: ITEM },
      tool_response: { content: [{ type: 'text', text: JSON.stringify({ error: 'already claimed' }) }] },
    }, { env })
    assert.deepEqual(readClaims(scope(), { env }), [])
  })
})

describe('the installed hook, run the way Claude runs it', () => {
  function manifest(event, index = 0) {
    const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks
    return hooks[event][index].hooks[0].command
  }

  function run(event, hookInput, index = 0) {
    return spawnSync('/bin/sh', ['-c', manifest(event, index)], {
      cwd: repo,
      input: hookInput === undefined ? '' : JSON.stringify(hookInput),
      encoding: 'utf8',
      env: { ...env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    })
  }

  it('points every hook at commit-provenance and never denies on failure', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks
    assert.match(hooks.PreToolUse[0].matcher, /Write\|Edit\|NotebookEdit\|Bash/)
    const pre = hooks.PreToolUse[0].hooks[0].command
    assert.match(pre, /commit-provenance\.mjs" pre/)
    assert.match(pre, /\|\| true$/, 'a hook failure must allow, never deny')
    assert.doesNotMatch(pre, /permissionDecision/, 'the manifest must not be able to emit a denial')
    assert.doesNotMatch(JSON.stringify(hooks), /claim-guard/)
  })

  it('allows an unclaimed edit and an unclaimed shell command end to end', () => {
    const write = run('PreToolUse', {
      session_id: SESSION, cwd: repo, hook_event_name: 'PreToolUse',
      tool_name: 'Write', tool_input: { file_path: path.join(repo, 'x.ts'), content: 'x' },
    })
    assert.equal(write.status, 0, write.stderr)
    assert.equal(decision(write.stdout ? JSON.parse(write.stdout) : null), null)

    const shell = run('PreToolUse', {
      session_id: SESSION, cwd: repo, hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_input: { command: 'rm -rf apps' },
    })
    assert.equal(shell.status, 0, shell.stderr)
    assert.equal(shell.stdout.trim(), '', 'no output at all means allow')
  })

  it('observes a real claim and stamps a real commit end to end', () => {
    const post = run('PostToolUse', {
      session_id: SESSION, cwd: repo, hook_event_name: 'PostToolUse',
      tool_name: 'mcp__devspec__claim_work_item',
      tool_input: { action_item_id: ITEM },
      tool_response: { content: [{ type: 'text', text: JSON.stringify({ id: ITEM, claim_success: true }) }] },
    })
    assert.equal(post.status, 0, post.stderr)

    const commit = run('PreToolUse', {
      session_id: SESSION, cwd: repo, hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_input: { command: 'git commit -m "real commit"' },
    })
    assert.equal(commit.status, 0, commit.stderr)
    const parsed = JSON.parse(commit.stdout)
    assert.equal(parsed.hookSpecificOutput.updatedInput.command, `git commit -m "real commit [devspec:${ITEM}]"`)
  })

  it('denies an unreferenced commit and survives malformed input', () => {
    const denied = run('PreToolUse', {
      session_id: SESSION, cwd: repo, hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_input: { command: 'git commit -m "unlinked"' },
    })
    assert.equal(denied.status, 0, denied.stderr)
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny')

    const malformed = spawnSync('/bin/sh', ['-c', manifest('PreToolUse')], {
      cwd: repo, input: '{not json', encoding: 'utf8',
      env: { ...env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    })
    assert.equal(malformed.status, 0)
    assert.equal(malformed.stdout.trim(), '', 'malformed input must allow, not deny')
  })

  it('still contributes only the contract pointer at SessionStart', () => {
    assert.deepEqual(handleSessionStart(), {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `DevSpec implementation contract: ${CONTRACT_URI}`,
      },
    })
    const started = run('SessionStart', undefined)
    assert.equal(started.status, 0, started.stderr)
    assert.match(JSON.parse(started.stdout).hookSpecificOutput.additionalContext, /implementation-contract/)
  })
})

/**
 * Real captured payloads, not hand-written ones. A previous guard shipped green while
 * being unable to observe a single real claim, because its suite asserted against an
 * object no server ever sends (devspec:4910e673).
 */
describe('the shapes the DevSpec server actually returns', () => {
  // The captured payloads carry their own session id; claims are scoped per session.
  const FIXTURE_SESSION = 'fixture-session-1234'

  function fixture(name) {
    return JSON.parse(
      fs.readFileSync(path.join(HERE, 'fixtures', 'commit-provenance', name), 'utf8').replaceAll('__REPO__', repo),
    )
  }

  const fixtureBash = (command) => handlePre({
    session_id: FIXTURE_SESSION,
    cwd: repo,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  }, { env })

  it('observes a claim from a real claim_work_item response', () => {
    handlePost(fixture('post-claim-success.json'), { env })
    assert.deepEqual(readClaims(scope(repo, FIXTURE_SESSION), { env }), [ITEM])
  })

  it('stamps from a real claim, then keeps the link after a real record_implementation', () => {
    handlePost(fixture('post-claim-success.json'), { env })
    assert.equal(updated(fixtureBash('git commit -m "real work"')), `git commit -m "real work [devspec:${ITEM}]"`)

    handlePost(fixture('post-terminal-success.json'), { env })
    assert.deepEqual(readClaims(scope(repo, FIXTURE_SESSION), { env }), [])
    assert.equal(fixtureBash(`git commit -m "after recording [devspec:${ITEM}]"`), null)
    assert.equal(decision(fixtureBash('git commit -m "after recording, unlinked"')), 'deny')
  })

  it('keeps one session\'s claim invisible to another', () => {
    handlePost(fixture('post-claim-success.json'), { env })
    assert.deepEqual(readClaims(scope(), { env }), [], 'a different session must not inherit it')
    assert.equal(decision(bash('git commit -m "other session"')), 'deny')
  })

  it('allows the real captured unclaimed Write payload', () => {
    assert.equal(decision(handlePre(fixture('pre-write.json'), { env })), null)
  })
})

describe('the capability table is published', () => {
  it('documents every surface the item requires', () => {
    const doc = fs.readFileSync(path.join(PLUGIN_ROOT, 'docs', 'commit-provenance.md'), 'utf8')
    for (const row of [
      /edit event/i, /commit message/i, /transform/i, /push/i,
      /project association/i, /offline/i, /non-terminating|continuation/i, /installed test/i,
    ]) {
      assert.match(doc, row)
    }
  })
})
