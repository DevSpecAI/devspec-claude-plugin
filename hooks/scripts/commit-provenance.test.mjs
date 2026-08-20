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
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  CONTRACT_URI,
  ONLINE_TIMEOUT_MS,
  confirmReferenceOnline,
  handlePost,
  handlePre,
  handleSessionStart,
  isSimpleGitPush,
  readClaims,
  heredocGitCommit,
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

const bash = (command, overrides, extra = {}) =>
  handlePre(input('Bash', { command }, overrides), { env, ...extra })
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
  // Real credentials in the developer's shell would otherwise send these tests at the
  // live server. The online block below supplies its own endpoint explicitly.
  const {
    DEVSPEC_MCP_TOKEN: _t, DEVSPEC_TOKEN: _t2, DEVSPEC_MCP_URL: _u,
    CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: _p, ...ambient
  } = process.env
  env = { ...ambient, DEVSPEC_CLAUDE_STATE_DIR: path.join(sandbox, 'state') }
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
    it(`allows: ${command}`, async () => {
      assert.equal(decision(await bash(command)), null, command)
    })
  }

  it('never denies a file edit, with or without a claim', async () => {
    for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
      const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path'
      assert.equal(decision(await handlePre(input(tool, { [key]: path.join(repo, 'x.ts') }), { env })), null, tool)
    }
    claim()
    for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
      const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path'
      assert.equal(await handlePre(input(tool, { [key]: path.join(repo, 'x.ts') }), { env }), null, tool)
    }
  })

  it('has no unattended or delegated special case that could deny', async () => {
    for (const overrides of [
      { unattended: true },
      { dispatch_mode: 'unattended' },
      { agent_type: 'subagent' },
      { session_id: 'delegated-subagent-99' },
    ]) {
      assert.equal(decision(await bash('rm -rf apps', overrides)), null, JSON.stringify(overrides))
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

  it('needs no allowance for the plugin\'s own control-plane commands', async () => {
    const connect = path.join(HERE, 'devspec-remote-connect.mjs')
    assert.equal(decision(await bash(`node "${connect}" --agent "Claude Code" --owner-pid "$PPID" 2>&1`)), null)
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

  it('still refuses prefixes and separators it cannot vouch for', async () => {
    for (const command of [
      'cd /tmp/wt; git commit -m "x"',            // ; is not the separator it reads
      'cd /tmp/a && cd /tmp/b && git commit -m "x"', // more than one separator
      'npm test && git commit -m "x"',            // a test command can write anything
      'cd -P /tmp/wt && git commit -m "x"',       // cd with an option
      'cd && git commit -m "x"',                  // cd with no path
      'cd /a /b && git commit -m "x"',            // cd with two words
      'git -C commit -m "x"',                     // -C swallowing the verb
      'git --git-dir=/x commit -m "x"',           // an option that could take a value
    ]) {
      assert.equal(simpleGitCommit(command), null, command)
      assert.equal(decision(await bash(command)), null, `${command} must be allowed`)
    }
  })

  it('reads past a `git add …` prefix, which is how an agent actually commits', () => {
    // REVERSED DELIBERATELY (item e6873db2). This used to assert null with the comment
    // "prefix is not cd". The bar for reading past a prefix is a property, not a
    // preference: it must be incapable of authoring a commit AND incapable of changing
    // which verb runs in the following segment. `git add` stages existing files and
    // exits, so it clears that bar — arguably more cleanly than `cd`, which at least
    // changes which repository the commit lands in. It matters because the shell cwd
    // resets between tool calls, so staging and committing arrive as ONE command: all
    // three commits that exposed this class of hole were `git add … && git commit`.
    assert.equal(simpleGitCommit('git add -A && git commit -m "hello"').message, 'hello')
    assert.equal(simpleGitCommit('git add . && git commit -m "hello"').message, 'hello')
    assert.equal(simpleGitCommit('git add -u src && git commit -m "hello"').message, 'hello')
    assert.equal(simpleGitCommit('git add -- "a b.ts" && git commit -m "hello"').message, 'hello')
    // Composes with the multi-line shapes, which is the combination that matters.
    assert.equal(
      heredocGitCommit(`git add -A && git commit -q -F - <<'MSG'\nsubject\n\nbody\nMSG`).message,
      'subject\n\nbody',
    )
  })

  it('still refuses every prefix that could author or redirect the commit', () => {
    for (const command of [
      'npm test && git commit -m "x"',              // can write the file being committed
      'make build && git commit -m "x"',
      './script.sh && git commit -m "x"',
      'git add -A; git commit -m "x"',              // ; is not the separator it reads
      'git add && git commit -m "x"',               // bare add stages nothing
      'git -C /tmp/wt add . && git commit -m "x"',  // -C could take a value
      'git commit -m "x" && git add -A',            // prefix/verb order reversed
      'git add -A && npm test && git commit -m "x"', // more than one separator
    ]) {
      assert.equal(simpleGitCommit(command), null, command)
    }
  })

  it('keeps shell-special characters that are legitimate message text', () => {
    // Refusing these would hand ordinary messages to the analyzer for no reason.
    assert.equal(simpleGitCommit('git commit -m "fix(api): handle {a,b}; done"').message, 'fix(api): handle {a,b}; done')
    assert.equal(simpleGitCommit("git commit -m 'cost is $5 & rising'").message, 'cost is $5 & rising')
  })

  it('refuses — and therefore allows — everything it cannot read honestly', async () => {
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
      'git commit -m "x" | tee log',
      'git commit -m "unterminated',
      'git commit -m "back\\slash"',
    ]) {
      assert.equal(simpleGitCommit(command), null, command)
      assert.equal(decision(await bash(command)), null, `${command} must be allowed`)
    }
  })

  it('never treats a push as a commit, and never blocks one', async () => {
    assert.equal(isSimpleGitPush('git push origin main'), true)
    assert.equal(isSimpleGitPush('git push'), true)
    assert.equal(isSimpleGitPush('git commit -m "x"'), false)
    // Push has no safe non-destructive recovery implemented, so it must not block.
    for (const command of ['git push', 'git push origin main', 'git push --force-with-lease']) {
      assert.equal(decision(await bash(command)), null, command)
    }
  })

  it('finds a reference only in its full-uuid form', () => {
    assert.equal(referenceIn(`fix: thing [devspec:${ITEM}]`), ITEM)
    assert.equal(referenceIn('fix: thing [devspec:cdd7a494]'), null, 'short code is not a link')
    assert.equal(referenceIn('fix: thing'), null)
  })
})

describe('a reference is a link — a live claim is not required', () => {
  it('allows a referenced commit with no claim at all', async () => {
    assert.equal(await bash(`git commit -m "fix: thing [devspec:${ITEM}]"`), null)
  })

  /** The exact regression that made the predecessor unusable after recording. */
  it('allows a referenced commit after record_implementation released the claim', async () => {
    claim()
    record()
    assert.deepEqual(readClaims(scope(), { env }), [])
    assert.equal(await bash(`git commit -m "follow-up [devspec:${ITEM}]"`), null)
  })

  it('allows a reference to an item other than the one currently claimed', async () => {
    claim(ITEM)
    assert.equal(await bash(`git commit -m "cross-repo work [devspec:${OTHER}]"`), null)
  })
})

describe('stamping, only when exactly one claim is unambiguous', () => {
  it('appends the reference inside the quoted message and reports it', async () => {
    claim(ITEM)
    const result = await bash('git commit -m "fix: the thing"')
    assert.equal(decision(result), null, 'stamping is not a denial')
    assert.equal(updated(result), `git commit -m "fix: the thing [devspec:${ITEM}]"`)
    assert.match(result.systemMessage, new RegExp(`stamped \\[devspec:${ITEM}\\]`))
  })

  it('preserves the rest of the command exactly', async () => {
    claim(ITEM)
    assert.equal(
      updated(await bash('git commit -a -m "subject" --no-verify')),
      `git commit -a -m "subject [devspec:${ITEM}]" --no-verify`,
    )
    assert.equal(updated(await bash("git commit -m 'single quoted'")), `git commit -m 'single quoted [devspec:${ITEM}]'`)
    assert.equal(updated(await bash('git commit -m"joined"')), `git commit -m"joined [devspec:${ITEM}]"`)
  })

  it('stamps the worktree-reaching forms at the right offset', async () => {
    claim(ITEM)
    assert.equal(
      updated(await bash('cd /tmp/wt && git commit -m "fix: thing"')),
      `cd /tmp/wt && git commit -m "fix: thing [devspec:${ITEM}]"`,
    )
    assert.equal(
      updated(await bash('git -C /tmp/wt commit -m "fix: thing"')),
      `git -C /tmp/wt commit -m "fix: thing [devspec:${ITEM}]"`,
    )
    assert.equal(
      updated(await bash('cd "/tmp/a b/wt" && git commit -a -m "subject" --no-verify')),
      `cd "/tmp/a b/wt" && git commit -a -m "subject [devspec:${ITEM}]" --no-verify`,
    )
  })

  it('refuses to guess between two active claims', async () => {
    claim(ITEM)
    claim(OTHER)
    assert.deepEqual(readClaims(scope(), { env }).sort(), [OTHER, ITEM].sort())
    const result = await bash('git commit -m "which item?"')
    assert.equal(decision(result), 'deny')
    assert.equal(updated(result), null, 'nothing may be stamped when ambiguous')
    const reason = result.hookSpecificOutput.permissionDecisionReason
    assert.match(reason, new RegExp(ITEM))
    assert.match(reason, new RegExp(OTHER))
  })

  it('resumes stamping once the ambiguity is resolved', async () => {
    claim(ITEM)
    claim(OTHER)
    record(OTHER)
    assert.deepEqual(readClaims(scope(), { env }), [ITEM])
    assert.equal(updated(await bash('git commit -m "now unambiguous"')), `git commit -m "now unambiguous [devspec:${ITEM}]"`)
  })

  it('does not stamp an unquoted message it cannot append to safely', async () => {
    claim(ITEM)
    const result = await bash('git commit -m bare')
    assert.equal(updated(result), null, 'appending would create a separate argument')
    assert.equal(decision(result), 'deny', 'so it asks the agent instead of corrupting the command')
  })
})

describe('denial is non-terminating and independently recoverable', () => {
  it('denies an unreferenced commit with a complete recovery route', async () => {
    const result = await bash('git commit -m "untracked work"')
    assert.equal(decision(result), 'deny')
    const reason = result.hookSpecificOutput.permissionDecisionReason
    for (const expected of [/create_action_item|search_action_items/, /\[devspec:/, /retry/i, /Nothing else is blocked/]) {
      assert.match(reason, expected)
    }
    assert.match(reason, new RegExp(CONTRACT_URI.replace(/[/:]/g, '\\$&')))
  })

  it('carries no field that would end the turn', async () => {
    const result = await bash('git commit -m "untracked work"')
    assert.equal(result.terminate, undefined)
    assert.equal(result.continue, undefined)
    assert.equal(result.stopReason, undefined)
    assert.equal(result.decision, undefined)
    assert.deepEqual(Object.keys(result), ['hookSpecificOutput'])
  })

  it('does not demand a full criteria set merely to commit', async () => {
    const reason = (await bash('git commit -m "x"')).hookSpecificOutput.permissionDecisionReason
    assert.match(reason, /thin\s+last-mile item is fine|smallest item/)
  })
})

describe('one nudge per session and repository, never more', () => {
  const editInput = () => input('Write', { file_path: path.join(repo, 'x.ts') })

  it('reminds once, then stays quiet', async () => {
    const first = await handlePre(editInput(), { env })
    assert.match(first.systemMessage, /no work item is claimed/i)
    assert.equal(decision(first), null, 'a nudge is never a denial')
    assert.equal(await handlePre(editInput(), { env }), null)
    assert.equal(await handlePre(editInput(), { env }), null)
  })

  it('reaches the agent, not only the terminal', async () => {
    // systemMessage renders in the terminal. Work here is routinely driven from a
    // phone, where there is no terminal to render into, and the party that can act on
    // the reminder is the agent — which reads additionalContext.
    const first = await handlePre(editInput(), { env })
    assert.match(first.hookSpecificOutput.additionalContext, /no work item is claimed/i)
    assert.equal(first.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.equal(first.hookSpecificOutput.permissionDecision, undefined, 'still never a denial')
    assert.equal(first.hookSpecificOutput.additionalContext, first.systemMessage)
  })

  it('asks for the right thing instead of describing a safety net', async () => {
    // An agent that believes something downstream will tidy up after it has less
    // reason to do the cheap correct thing now. The text must not offer that comfort,
    // and must not promise a refusal that only holds for the shapes this can read.
    const { additionalContext: text } = (await handlePre(editInput(), { env })).hookSpecificOutput
    assert.match(text, /Claim one before you commit/i)
    assert.match(text, /create_action_item/)
    assert.match(text, /\[devspec:<full-uuid>\]/)
    assert.equal(/refus/i.test(text), false, 'must not promise a refusal')
    assert.equal(/analy[sz]er|reconcil/i.test(text), false, 'must not name a backstop')
  })

  it('says nothing at all when a claim is held', async () => {
    claim()
    assert.equal(await handlePre(editInput(), { env }), null)
  })

  it('says nothing outside a DevSpec project', async () => {
    fs.rmSync(path.join(repo, '.mcp.json'))
    assert.equal(await handlePre(editInput(), { env }), null)
  })
})

describe('jurisdiction is positive and local', () => {
  it('ignores a folder with no DevSpec marker', async () => {
    const outside = path.join(sandbox, 'unrelated')
    gitInit(outside)
    assert.equal(await handlePre(input('Bash', { command: 'git commit -m "x"' }, { cwd: outside }), { env }), null)
  })

  it('takes jurisdiction from a .devspec/project.json pin', async () => {
    const pinned = path.join(sandbox, 'pinned')
    gitInit(pinned)
    fs.mkdirSync(path.join(pinned, '.devspec'))
    fs.writeFileSync(path.join(pinned, '.devspec', 'project.json'), JSON.stringify({ project_id: OTHER }))
    assert.equal(
      decision(await handlePre(input('Bash', { command: 'git commit -m "x"' }, { cwd: pinned }), { env })),
      'deny',
    )
  })

  it('covers a linked worktree through the main checkout, whose marker is untracked', async () => {
    spawnSync('git', ['-C', repo, '-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '--allow-empty', '-q', '-m', 'init'])
    const worktree = path.join(sandbox, 'wt')
    const added = spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', worktree], { encoding: 'utf8' })
    assert.equal(added.status, 0, added.stderr)
    assert.equal(fs.existsSync(path.join(worktree, '.mcp.json')), false, 'marker genuinely absent')
    assert.equal(
      decision(await handlePre(input('Bash', { command: 'git commit -m "x"' }, { cwd: worktree }), { env })),
      'deny',
    )
  })

  it('never reads a marker at or above the home directory', async () => {
    const home = fs.mkdtempSync(path.join(sandbox, 'home-'))
    markDevspecProject(home)
    const plain = path.join(home, 'work')
    fs.mkdirSync(plain)
    assert.equal(
      await handlePre(input('Bash', { command: 'git commit -m "x"' }, { cwd: plain }), { env: { ...env, HOME: home, USERPROFILE: home } }),
      null,
    )
  })

  it('writes no pin and touches no folder of its own accord', async () => {
    const before = fs.readdirSync(repo).sort()
    await handlePre(input('Write', { file_path: path.join(repo, 'x.ts') }), { env })
    await bash('git commit -m "x"')
    assert.deepEqual(fs.readdirSync(repo).sort(), before, 'the hook must not create .devspec or anything else')
  })
})

describe('uncertainty always allows', () => {
  it('allows when the hook input has no usable scope', async () => {
    assert.equal(await handlePre(input('Bash', { command: 'git commit -m "x"' }, { session_id: '' }), { env }), null)
    assert.equal(await handlePre(input('Bash', { command: 'git commit -m "x"' }, { cwd: path.join(sandbox, 'gone') }), { env }), null)
  })

  it('allows when claim state is unreadable', async () => {
    claim()
    fs.rmSync(path.join(sandbox, 'state'), { recursive: true, force: true })
    assert.equal(decision(await bash(`git commit -m "x [devspec:${ITEM}]"`)), null)
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
  /**
   * The command for the hook that runs a given SCRIPT, not the one at a given array
   * index. The manifest has more than one entry per event (commit observation joined
   * the gate), and an index would silently run a different hook than the test names —
   * green, and proving nothing.
   */
  function manifest(event, script = 'commit-provenance.mjs') {
    const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks
    const commands = (hooks[event] ?? []).flatMap((entry) => entry.hooks.map((h) => h.command))
    const matching = commands.filter((c) => c.includes(script))
    assert.equal(matching.length, 1, `expected exactly one ${event} hook running ${script}`)
    return matching[0]
  }

  function run(event, hookInput, script = 'commit-provenance.mjs') {
    return spawnSync('/bin/sh', ['-c', manifest(event, script)], {
      cwd: repo,
      input: hookInput === undefined ? '' : JSON.stringify(hookInput),
      encoding: 'utf8',
      env: { ...env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    })
  }

  it('points every hook at commit-provenance and never denies on failure', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks
    const gate = hooks.PreToolUse.find((entry) =>
      entry.hooks.some((h) => h.command.includes('commit-provenance.mjs')),
    )
    assert.ok(gate, 'the provenance gate must be installed')
    assert.match(gate.matcher, /Write\|Edit\|NotebookEdit\|Bash/)
    const pre = gate.hooks[0].command
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

  it('stamps from a real claim, then keeps the link after a real record_implementation', async () => {
    handlePost(fixture('post-claim-success.json'), { env })
    assert.equal(updated(await fixtureBash('git commit -m "real work"')), `git commit -m "real work [devspec:${ITEM}]"`)

    handlePost(fixture('post-terminal-success.json'), { env })
    assert.deepEqual(readClaims(scope(repo, FIXTURE_SESSION), { env }), [])
    assert.equal(await fixtureBash(`git commit -m "after recording [devspec:${ITEM}]"`), null)
    assert.equal(decision(await fixtureBash('git commit -m "after recording, unlinked"')), 'deny')
  })

  it('keeps one session\'s claim invisible to another', async () => {
    handlePost(fixture('post-claim-success.json'), { env })
    assert.deepEqual(readClaims(scope(), { env }), [], 'a different session must not inherit it')
    assert.equal(decision(await bash('git commit -m "other session"')), 'deny')
  })

  it('allows the real captured unclaimed Write payload', async () => {
    assert.equal(decision(await handlePre(fixture('pre-write.json'), { env })), null)
  })
})

/**
 * The one network call this hook makes, and the single rule that governs it: only a
 * definitive "no such item" denies.
 *
 * These drive a REAL server and a REAL closed port rather than a stubbed caller,
 * because every outcome that must ALLOW is a transport failure. A stub can show the
 * branch exists; only a socket shows the branch is reachable from the hook — and the
 * whole point of this item is that a network dependency must not be able to stop work.
 */
describe('confirming a present reference online (item 6fa0241e)', () => {
  let server
  let requests
  let reply
  let held

  const rpcText = (payload) => JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
  })

  const answer = (status, extra = {}) => ({
    local: { status: 'well_formed', shape: 'full_uuid', reference: ITEM },
    online: { status, ...extra },
  })

  const sendJson = (res, payload) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(rpcText(payload))
  }

  beforeEach(async () => {
    requests = []
    held = []
    reply = (res) => sendJson(res, answer('valid', { action_item_id: ITEM }))
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        requests.push({ url: req.url, authorization: req.headers.authorization, body })
        reply(res, body)
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  })

  afterEach(async () => {
    for (const res of held) res.destroy()
    await new Promise((resolve) => server.close(resolve))
  })

  const endpoint = () => `http://127.0.0.1:${server.address().port}/api/mcp`

  const online = (extra = {}) => ({
    env: { ...env, DEVSPEC_MCP_URL: endpoint(), DEVSPEC_MCP_TOKEN: 'test-token' },
    ...extra,
  })

  const commit = (message, extra = {}) => bash(`git commit -m "${message}"`, undefined, online(extra))
  const referenced = (extra = {}) => commit(`work done [devspec:${ITEM}]`, extra)

  it('allows a reference the server resolves, and asks exactly once', async () => {
    assert.equal(await referenced(), null)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].authorization, 'Bearer test-token')
    const sent = JSON.parse(requests[0].body)
    assert.equal(sent.params.name, 'validate_commit_reference')
    assert.equal(sent.params.arguments.commit_message, `work done [devspec:${ITEM}]`)
  })

  it('denies a definitive not_found, and names the cause rather than the rule', async () => {
    reply = (res) => sendJson(res, answer('not_found'))
    const result = await referenced()
    assert.equal(decision(result), 'deny')
    const reason = result.hookSpecificOutput.permissionDecisionReason
    assert.match(reason, new RegExp(ITEM))
    assert.match(reason, /resolves to no item/)
    assert.match(reason, /wrong uuid tail|different project/)
    assert.match(reason, /retry/)
  })

  it('keeps that denial non-terminating', async () => {
    reply = (res) => sendJson(res, answer('not_found'))
    const result = await referenced()
    const serialised = JSON.stringify(result)
    for (const forbidden of ['stopReason', 'continue', 'suppressOutput', 'terminate']) {
      assert.doesNotMatch(serialised, new RegExp(forbidden), `${forbidden} would end the turn`)
    }
  })

  /**
   * The contract's own words: unavailable and indeterminate "must never be collapsed
   * into not-found". Each of these is a way of not getting an answer.
   */
  it('allows every way of not getting an answer', async () => {
    const ways = [
      ['unavailable', (res) => sendJson(res, answer('unavailable', { reason: 'db down' }))],
      ['indeterminate', (res) => sendJson(res, answer('indeterminate', { reason: 'short code matched two' }))],
      ['not_run', (res) => sendJson(res, { local: { status: 'malformed' }, online: { status: 'not_run' } })],
      ['a body that is not JSON', (res) => { res.writeHead(200); res.end('<html>gateway</html>') }],
      ['a result with no online field', (res) => sendJson(res, { local: { status: 'well_formed' } })],
      ['HTTP 500', (res) => { res.writeHead(500); res.end('boom') }],
      ['HTTP 401', (res) => { res.writeHead(401); res.end('bad token') }],
      ['an MCP-level error', (res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'project could not be resolved' } }))
      }],
      ['an isError tool result', (res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { isError: true, content: [{ type: 'text', text: 'This call needs a project' }] },
        }))
      }],
    ]
    for (const [name, responder] of ways) {
      reply = responder
      assert.equal(await referenced(), null, name)
    }
  })

  it('allows when nothing is listening on the endpoint at all', async () => {
    const dead = http.createServer()
    await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${dead.address().port}/api/mcp`
    await new Promise((resolve) => dead.close(resolve))

    const result = await bash(`git commit -m "offline work [devspec:${ITEM}]"`, undefined, {
      env: { ...env, DEVSPEC_MCP_URL: url, DEVSPEC_MCP_TOKEN: 'test-token' },
    })
    assert.equal(result, null, 'a refused connection must allow the commit')
    assert.equal(requests.length, 0)
  })

  it('allows a server that never answers, well inside the hook budget', async () => {
    reply = (res) => { held.push(res) }
    const started = process.hrtime.bigint()
    const result = await referenced({ timeoutMs: 150 })
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    assert.equal(result, null)
    assert.ok(elapsedMs < 2_000, `waited ${elapsedMs}ms`)
  })

  it('makes no call at all when no credentials are configured', async () => {
    const result = await bash(`git commit -m "no endpoint [devspec:${ITEM}]"`, undefined, {
      env: { ...env, DEVSPEC_MCP_URL: endpoint() },
    })
    assert.equal(result, null)
    assert.equal(requests.length, 0, 'no token means nothing to send')
  })

  it('leaves the no-reference path entirely local', async () => {
    assert.equal(decision(await commit('unlinked work')), 'deny')
    claim()
    assert.equal(
      updated(await commit('stamped work')),
      `git commit -m "stamped work [devspec:${ITEM}]"`,
    )
    assert.equal(requests.length, 0, 'the local paths must never reach the network')
  })

  it('sends the jurisdiction hints the folder actually carries', async () => {
    const project = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    fs.mkdirSync(path.join(repo, '.devspec'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.devspec', 'project.json'), JSON.stringify({ project_id: project }))
    spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:Acme/App.git'], { encoding: 'utf8' })

    assert.equal(await referenced(), null)
    const sent = JSON.parse(requests[0].body).params.arguments
    assert.equal(sent.pinned_project_id, project)
    assert.equal(sent.git_remote, 'git@github.com:Acme/App.git')
  })

  /**
   * Found by driving the real server, not by reading the code: credentials live in an
   * untracked `.mcp.json`, a linked worktree therefore has none, and the contract
   * REQUIRES work to happen in one. Resolving only from the cwd left the check inert
   * for the only workflow it protects — the same mistake 0.16.0 made about the commit
   * shape, one layer down.
   */
  it('finds credentials from the main worktree when the linked one has none', async () => {
    const worktree = path.join(sandbox, 'linked')
    const git = (...args) => spawnSync('git', [
      '-C', repo,
      '-c', 'user.email=test@example.invalid',
      '-c', 'user.name=test',
      '-c', 'commit.gpgsign=false',
      ...args,
    ], { encoding: 'utf8' })
    const seeded = git('commit', '-q', '--allow-empty', '-m', 'seed')
    assert.equal(seeded.status, 0, seeded.stderr)
    const added = git('worktree', 'add', '--detach', worktree)
    assert.equal(added.status, 0, added.stderr)
    fs.writeFileSync(
      path.join(repo, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          devspec: { type: 'http', url: endpoint(), headers: { Authorization: 'Bearer from-main-worktree' } },
        },
      }),
    )
    assert.ok(!fs.existsSync(path.join(worktree, '.mcp.json')), 'the linked worktree carries no config')

    reply = (res) => sendJson(res, answer('not_found'))
    const result = await handlePre(
      input('Bash', { command: `git commit -m "from a worktree [devspec:${ITEM}]"` }, { cwd: worktree }),
      { env },
    )
    assert.equal(decision(result), 'deny', 'the check must reach the server from a worktree')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].authorization, 'Bearer from-main-worktree')
  })

  it('bounds itself well inside the manifest hook timeout', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks
    const budgetMs =
      hooks.PreToolUse.find((entry) =>
        entry.hooks.some((h) => h.command.includes('commit-provenance.mjs')),
      ).hooks[0].timeout * 1000
    assert.ok(ONLINE_TIMEOUT_MS * 3 <= budgetMs, `${ONLINE_TIMEOUT_MS}ms is not a small share of ${budgetMs}ms`)
  })

  it('reports the contract outcome directly, for a caller that wants it', async () => {
    reply = (res) => sendJson(res, answer('not_found'))
    assert.equal(
      await confirmReferenceOnline(`x [devspec:${ITEM}]`, {
        cwd: repo,
        env: { ...env, DEVSPEC_MCP_URL: endpoint(), DEVSPEC_MCP_TOKEN: 'test-token' },
      }),
      'not_found',
    )
    assert.equal(await confirmReferenceOnline('x', { cwd: repo, env }), 'unavailable')
  })

  /**
   * Spawned ASYNCHRONOUSLY on purpose: `spawnSync` blocks this process's event loop,
   * so the test server could never answer the child and the hook would time out into
   * an allow — a green test proving the opposite of what it claims.
   */
  it('denies an unresolvable reference through the installed manifest, end to end', async () => {
    reply = (res) => sendJson(res, answer('not_found'))
    // Resolved by SCRIPT, not by array index: the manifest gained a second PreToolUse
    // entry (commit observation) and an index would have silently run the wrong hook
    // here — a green test proving nothing about the gate.
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'))
    const commands = manifest.hooks.PreToolUse.flatMap((entry) => entry.hooks.map((h) => h.command))
    const matching = commands.filter((c) => c.includes('commit-provenance.mjs'))
    assert.equal(matching.length, 1, 'exactly one PreToolUse hook must run the provenance gate')
    const command = matching[0]

    const child = spawn('/bin/sh', ['-c', command], {
      cwd: repo,
      env: {
        ...env,
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        DEVSPEC_MCP_URL: endpoint(),
        DEVSPEC_MCP_TOKEN: 'test-token',
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.stdin.end(JSON.stringify({
      session_id: SESSION,
      cwd: repo,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: `git commit -m "wrong tail [devspec:${ITEM}]"` },
    }))
    const status = await new Promise((resolve) => child.on('close', resolve))

    assert.equal(status, 0, stderr)
    assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, 'deny')
    assert.equal(requests.length, 1, 'the installed hook must make the call itself')
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

describe('the multi-line message forms, which is where almost every commit lives', () => {
  // Why this block exists: on one repository's staging branch over 14 days, 59 commits
  // carried no reference and every single one of them was multi-line — a commit with a
  // body cannot be written as one quoted `-m` argument, so the check was never reached
  // by real work (item 022e487b).
  const A = (body) => `git commit -q -F - <<'MSG'\n${body}\nMSG`
  const B = (body) => `git commit -q -m "$(cat <<'MSG'\n${body}\nMSG\n)"`

  it('reads a single-quoted heredoc on stdin, body and all', () => {
    assert.equal(heredocGitCommit(A('subject')).message, 'subject')
    assert.equal(heredocGitCommit(A('subject\n\nbody line')).message, 'subject\n\nbody line')
    assert.equal(heredocGitCommit(A('subject\nMSGX\nstill body')).message, 'subject\nMSGX\nstill body')
    assert.equal(heredocGitCommit(`${A('subject')}\n`).message, 'subject')
  })

  it('reads `-m "$(cat <<\'X\')"`, the other way a body gets written', () => {
    assert.equal(heredocGitCommit(B('subject')).message, 'subject')
    assert.equal(heredocGitCommit(B('subject\n\nbody line')).message, 'subject\n\nbody line')
  })

  it('honours the prefix and global-option rules by reusing the simple reader', () => {
    assert.equal(heredocGitCommit(`cd /tmp/wt && git commit -F - <<'MSG'\nsubject\nMSG`).message, 'subject')
    assert.equal(heredocGitCommit(`git -C /tmp/wt commit -F - <<'MSG'\nsubject\nMSG`).message, 'subject')
    assert.equal(heredocGitCommit(`git --no-pager commit -m "$(cat <<'MSG'\nsubject\nMSG\n)"`).message, 'subject')
  })

  it('refuses — and therefore allows — every form whose message it cannot be sure of', () => {
    for (const command of [
      `git commit -F - <<MSG\nsubject\nMSG`,              // unquoted: expansion applies
      `git commit -F - <<-'MSG'\nsubject\nMSG`,           // <<- strips tabs, different text
      `git commit -F - <<'A'\nx\nA\ncat <<'B'\ny\nB`,     // two heredocs
      `git commit -F - <<'MSG'\nsubject`,                 // no terminator
      `git commit -F - <<'MSG'\nsubject\nMSGX\n`,         // terminator not alone on its line
      `git commit -F - <<'MSG'\nx\nMSG\n; rm -rf /`,      // trailing structure
      "git commit -F - <<'MSG'\n`whoami`\nMSG",           // backtick anywhere
      `git commit -F - $EXTRA <<'MSG'\nx\nMSG`,           // expansion in the head
      `git commit -m "$(printf <<'MSG'\nx\nMSG\n)"`,      // substitution is not cat
      `git commit -m "$(cat <<'MSG'\nx\nMSG\n)$(date)"`,  // a second substitution
      `git commit -m "a" -m "$(cat <<'MSG'\nx\nMSG\n)"`,  // two message parts
      `g commit -F - <<'MSG'\nx\nMSG`,                    // aliased git
      `git commit -F msg.txt`,                            // a file, deliberately not read
      `git commit --file=msg.txt`,
    ]) {
      assert.equal(heredocGitCommit(command), null, command)
    }
  })

  it('denies an unreferenced multi-line commit, with the same recovery text', async () => {
    for (const command of [A('fix: subject'), B('fix: subject')]) {
      const result = await bash(command)
      assert.equal(decision(result), 'deny', command)
      assert.match(result.hookSpecificOutput.permissionDecisionReason, /\[devspec:<full-uuid>\]/)
    }
  })

  it('allows a multi-line commit that already carries a reference', async () => {
    assert.equal(await bash(A(`fix: subject [devspec:${ITEM}]`)), null)
    assert.equal(await bash(B(`fix: subject\n\nbody [devspec:${ITEM}]`)), null)
  })

  it('stamps the subject line inside the heredoc, never the trailer or past the delimiter', async () => {
    claim()
    const body = 'fix: subject\n\nbody paragraph\nCo-Authored-By: Someone <x@y.z>'
    for (const command of [A(body), B(body)]) {
      const result = await bash(command)
      const rewritten = updated(result)
      assert.ok(rewritten, `expected a rewrite for ${command}`)
      assert.match(rewritten, new RegExp(`fix: subject \\[devspec:${ITEM}\\]`))
      // The trailer must survive untouched, and nothing may land after the delimiter.
      assert.match(rewritten, /Co-Authored-By: Someone <x@y\.z>\n/)
      assert.equal(/MSG[^\n]*devspec/.test(rewritten), false, 'reference must not follow the delimiter')
      assert.equal(referenceIn(heredocGitCommit(rewritten).message), ITEM)
    }
  })

  it('produces a command git actually accepts (run, not reasoned about)', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-exec-'))
    gitInit(scratch)
    for (const [name, make] of [['A', A], ['B', B]]) {
      const command = make(`fix: form ${name}\n\nbody\nCo-Authored-By: X <x@y.z>`)
      const commit = heredocGitCommit(command)
      const stamped = `${command.slice(0, commit.insertOffset)} [devspec:${ITEM}]${command.slice(commit.insertOffset)}`
      fs.writeFileSync(path.join(scratch, `${name}.txt`), name)
      for (const args of [['config', 'user.email', 't@t.t'], ['config', 'user.name', 'T'], ['add', '-A']]) {
        assert.equal(spawnSync('git', args, { cwd: scratch }).status, 0)
      }
      const run = spawnSync('bash', ['-c', stamped], { cwd: scratch, encoding: 'utf8' })
      assert.equal(run.status, 0, `${name}: ${run.stderr}`)
      const message = spawnSync('git', ['log', '-1', '--format=%B'], { cwd: scratch, encoding: 'utf8' }).stdout
      assert.match(message, new RegExp(`fix: form ${name} \\[devspec:${ITEM}\\]`))
      assert.match(message, /Co-Authored-By: X <x@y\.z>/)
    }
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  it('stamps a `git add <paths> && git commit` without disturbing what gets staged', () => {
    // The combination that all three of the commits which exposed this actually used.
    // Two things must hold at once: the reference lands in the message, and the `git
    // add` pathspec is untouched — a stamp that shifted the prefix would silently
    // commit the wrong files, which is worse than not stamping at all.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-prefix-'))
    gitInit(scratch)
    fs.mkdirSync(path.join(scratch, 'src'))
    fs.writeFileSync(path.join(scratch, 'src', 'wanted.ts'), 'keep')
    fs.writeFileSync(path.join(scratch, 'noise.ts'), 'skip')
    for (const args of [['config', 'user.email', 't@t.t'], ['config', 'user.name', 'T']]) {
      assert.equal(spawnSync('git', args, { cwd: scratch }).status, 0)
    }

    const command = `git add src/wanted.ts && git commit -q -F - <<'MSG'\nfix: only the wanted file\n\nbody\nCo-Authored-By: X <x@y.z>\nMSG`
    const commit = heredocGitCommit(command)
    assert.ok(commit, 'prefix + heredoc must be readable')
    const stamped = `${command.slice(0, commit.insertOffset)} [devspec:${ITEM}]${command.slice(commit.insertOffset)}`

    const run = spawnSync('bash', ['-c', stamped], { cwd: scratch, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)

    const message = spawnSync('git', ['log', '-1', '--format=%B'], { cwd: scratch, encoding: 'utf8' }).stdout
    assert.match(message, new RegExp(`fix: only the wanted file \\[devspec:${ITEM}\\]`))
    assert.match(message, /Co-Authored-By: X <x@y\.z>/)

    const files = spawnSync('git', ['show', '--stat', '--format=', 'HEAD'], { cwd: scratch, encoding: 'utf8' }).stdout
    assert.match(files, /src\/wanted\.ts/)
    assert.equal(/noise\.ts/.test(files), false, 'only the named pathspec may be committed')

    const status = spawnSync('git', ['status', '--porcelain'], { cwd: scratch, encoding: 'utf8' }).stdout
    assert.match(status, /\?\? noise\.ts/, 'the unnamed file stays untracked')

    fs.rmSync(scratch, { recursive: true, force: true })
  })
})
