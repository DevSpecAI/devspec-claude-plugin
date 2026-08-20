#!/usr/bin/env node
/**
 * Tests for commit observation (item 27fab61a).
 *
 * The property under test: this reports a commit that happened, to the right agent, and
 * otherwise does nothing at all. The three ways it could be harmful are reporting a
 * commit that did not happen, attributing one to the wrong connection, and affecting
 * the command it is watching — so those are what the suite is built around.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  boundConnection,
  commitRepoDir,
  createdSha,
  handleBashPost,
  handleBashPre,
  looksCommitProducing,
  shortShaFromOutput,
} from './commit-observation.mjs'

const SESSION = 'observation-session-1'
let sandbox
let repo

function gitInit(dir) {
  fs.mkdirSync(dir, { recursive: true })
  assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0)
  for (const args of [['config', 'user.email', 't@t.t'], ['config', 'user.name', 'T']]) {
    assert.equal(spawnSync('git', args, { cwd: dir }).status, 0)
  }
  markDevspecProject(dir)
}

/** A folder DevSpec has positive local jurisdiction over. Normally untracked. */
function markDevspecProject(dir) {
  fs.writeFileSync(
    path.join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { devspec: { type: 'http', url: 'https://example.invalid/api/mcp' } } }),
  )
}
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const sh = (script, cwd = repo) => spawnSync('bash', ['-c', script], { cwd, encoding: 'utf8' })

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-test-'))
  repo = path.join(sandbox, 'repo')
  gitInit(repo)
  sh('echo one > a.txt && git add a.txt && git commit -q -m "base"')
  process.env.DEVSPEC_CLAUDE_STATE_DIR = path.join(sandbox, 'state')
})

afterEach(() => {
  delete process.env.DEVSPEC_CLAUDE_STATE_DIR
  fs.rmSync(sandbox, { recursive: true, force: true })
})

const fakeConnection = () => ({
  connection_id: 'conn-1',
  mcp_url: 'https://example.invalid/api/mcp',
  token: 'tok',
})

function recorder() {
  const calls = []
  return {
    calls,
    call: async (args) => {
      calls.push(args)
      return { ok: true }
    },
  }
}

describe('which commands are worth watching', () => {
  it('watches anything that can create a commit', () => {
    assert.equal(looksCommitProducing("git commit -q -F - <<'MSG'\nx\nMSG"), true)
    assert.equal(looksCommitProducing('git add -A && git commit -m "x"'), true)
    assert.equal(looksCommitProducing('cd /tmp/wt && git commit --amend -m "x"'), true)
    assert.equal(looksCommitProducing('git merge origin/main'), true)
    assert.equal(looksCommitProducing('git revert HEAD'), true)
    assert.equal(looksCommitProducing('git cherry-pick abc123'), true)
  })

  it('ignores everything else, and is loose on purpose', () => {
    // A false positive costs one rev-parse and reports nothing, because HEAD did not
    // move. A false negative costs the attribution. Loose is the cheaper mistake.
    assert.equal(looksCommitProducing('git status'), false)
    assert.equal(looksCommitProducing('git log --oneline'), false)
    assert.equal(looksCommitProducing('npm test'), false)
    assert.equal(looksCommitProducing('rm -rf node_modules'), false)
    assert.equal(looksCommitProducing(''), false)
    assert.equal(looksCommitProducing(undefined), false)
  })
})

describe('which repository HEAD actually moves in', () => {
  it('follows the two prefixes the worktree workflow produces', () => {
    assert.equal(commitRepoDir('cd /tmp/wt && git commit -m "x"', '/fallback'), '/tmp/wt')
    assert.equal(commitRepoDir('cd "/tmp/a b/wt" && git commit -m "x"', '/fallback'), '/tmp/a b/wt')
    assert.equal(commitRepoDir("cd '/tmp/a b/wt' && git commit -m \"x\"", '/fallback'), '/tmp/a b/wt')
    assert.equal(commitRepoDir('git -C /tmp/wt commit -m "x"', '/fallback'), '/tmp/wt')
    assert.equal(commitRepoDir('git --no-pager -C /tmp/wt commit -m "x"', '/fallback'), '/tmp/wt')
  })

  it('falls back to the tool cwd', () => {
    assert.equal(commitRepoDir('git commit -m "x"', '/fallback'), '/fallback')
    assert.equal(commitRepoDir(undefined, '/fallback'), '/fallback')
  })
})

describe('finding the sha git just created', () => {
  it('reads the [branch shortsha] line, including a root commit', () => {
    assert.equal(shortShaFromOutput('[staging 5bbfddb] fix: thing\n 1 file changed'), '5bbfddb')
    assert.equal(shortShaFromOutput('[main (root-commit) abc1234] first'), 'abc1234')
    assert.equal(shortShaFromOutput('nothing to commit, working tree clean'), null)
    assert.equal(shortShaFromOutput(''), null)
    assert.equal(shortShaFromOutput(undefined), null)
  })

  it('resolves a short sha from the output to the full one', () => {
    sh('echo two > b.txt && git add b.txt')
    const out = sh('git commit -m "second"').stdout
    const full = git(['rev-parse', 'HEAD'])
    assert.equal(createdSha({ output: out, repoDir: repo, before: { sha: null } }), full)
  })

  it('finds a QUIET commit, which prints nothing at all', () => {
    // This is the case that matters most: -q is what an agent actually writes, and it
    // gives the output-parsing path nothing to work with.
    const before = git(['rev-parse', 'HEAD'])
    sh('echo two > b.txt && git add b.txt && git commit -q -m "second"')
    const after = git(['rev-parse', 'HEAD'])
    assert.notEqual(before, after)
    assert.equal(createdSha({ output: '', repoDir: repo, before: { sha: before } }), after)
  })

  it('finds nothing when HEAD did not move', () => {
    const head = git(['rev-parse', 'HEAD'])
    assert.equal(createdSha({ output: '', repoDir: repo, before: { sha: head } }), null)
  })

  it('finds nothing when there was no marker, rather than blaming the current HEAD', () => {
    // "No marker" is not "HEAD was nothing". Without a marker we cannot tell whether
    // this command moved HEAD, so an older commit must not be attributed to us.
    assert.equal(createdSha({ output: '', repoDir: repo, before: null }), null)
  })

  it('still catches a genuine root commit, where there really was no HEAD', () => {
    const fresh = path.join(sandbox, 'fresh')
    gitInit(fresh)
    sh('echo x > x.txt && git add x.txt && git commit -q -m "root"', fresh)
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fresh, encoding: 'utf8' }).trim()
    assert.equal(createdSha({ output: '', repoDir: fresh, before: { sha: null } }), head)
  })
})

describe('reporting', () => {
  const preInput = (command) => ({ session_id: SESSION, cwd: repo, tool_input: { command } })

  it('reports a quiet commit end to end, with the full sha and the branch', async () => {
    const command = "git commit -q -F - <<'MSG'\nsecond\nMSG"
    handleBashPre(preInput(command))
    sh('echo two > b.txt && git add b.txt && git commit -q -m "second"')
    const head = git(['rev-parse', 'HEAD'])

    const rec = recorder()
    await handleBashPost(
      { ...preInput(command), tool_response: '' },
      { call: rec.call, boundConnection: fakeConnection },
    )
    assert.equal(rec.calls.length, 1)
    assert.equal(rec.calls[0].name, 'report_commit_provenance')
    assert.deepEqual(rec.calls[0].arguments, {
      connection_id: 'conn-1',
      commit_sha: head,
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    })
  })

  it('reports NOTHING for a commit that failed', async () => {
    // The whole reason HEAD is compared rather than trusting the command: a commit that
    // did not happen must not be attributed to anyone.
    const command = 'git commit -m "nothing staged"'
    handleBashPre(preInput(command))
    sh(command)
    const rec = recorder()
    await handleBashPost(
      { ...preInput(command), tool_response: 'nothing to commit, working tree clean' },
      { call: rec.call, boundConnection: fakeConnection },
    )
    assert.equal(rec.calls.length, 0)
  })

  it('reports nothing for a command that never touches history', async () => {
    const rec = recorder()
    await handleBashPost(
      { session_id: SESSION, cwd: repo, tool_input: { command: 'git status' }, tool_response: 'clean' },
      { call: rec.call, boundConnection: fakeConnection },
    )
    assert.equal(rec.calls.length, 0)
  })

  it('reports nothing when no connection is bound to this conversation', async () => {
    const command = 'git commit -q -m "second"'
    handleBashPre(preInput(command))
    sh('echo two > b.txt && git add b.txt && git commit -q -m "second"')
    const rec = recorder()
    await handleBashPost(
      { ...preInput(command), tool_response: '' },
      { call: rec.call, boundConnection: () => null },
    )
    assert.equal(rec.calls.length, 0)
  })

  it('never throws when the report fails — provenance is not permission', async () => {
    const command = 'git commit -q -m "second"'
    handleBashPre(preInput(command))
    sh('echo two > b.txt && git add b.txt && git commit -q -m "second"')
    await handleBashPost(
      { ...preInput(command), tool_response: '' },
      {
        boundConnection: fakeConnection,
        call: async () => {
          throw new Error('offline')
        },
      },
    )
    // Reaching here without throwing IS the assertion.
    assert.ok(true)
  })

  it('consumes the remembered HEAD, so it cannot leak into a later command', async () => {
    const command = 'git commit -q -m "second"'
    handleBashPre(preInput(command))
    sh('echo two > b.txt && git add b.txt && git commit -q -m "second"')
    const rec = recorder()
    await handleBashPost({ ...preInput(command), tool_response: '' }, { call: rec.call, boundConnection: fakeConnection })
    assert.equal(rec.calls.length, 1)
    // Second post with no fresh pre: the marker is gone and HEAD has not moved again.
    await handleBashPost({ ...preInput(command), tool_response: '' }, { call: rec.call, boundConnection: fakeConnection })
    assert.equal(rec.calls.length, 1, 'a stale marker must not produce a second report')
  })
})

describe('jurisdiction', () => {
  it('reports nothing for a repository this project has no claim over', async () => {
    // Found by the first live end-to-end run: an agent connected to one project still
    // runs commands in other repositories — a scratch clone, an unrelated tool. The
    // connection names the project, so reporting those would file someone else's
    // commits against a project they have nothing to do with.
    const foreign = path.join(sandbox, 'foreign')
    fs.mkdirSync(foreign, { recursive: true })
    assert.equal(spawnSync('git', ['init', '-q', foreign]).status, 0)
    for (const args of [['config', 'user.email', 't@t.t'], ['config', 'user.name', 'T']]) {
      assert.equal(spawnSync('git', args, { cwd: foreign }).status, 0)
    }
    // deliberately NOT marked as a DevSpec project

    const command = 'git commit -q -m "not ours"'
    const input = { session_id: SESSION, cwd: foreign, tool_input: { command } }
    handleBashPre(input)
    sh('echo x > x.txt && git add x.txt && git commit -q -m "not ours"', foreign)

    const rec = recorder()
    await handleBashPost(
      { ...input, tool_response: '' },
      { call: rec.call, boundConnection: fakeConnection },
    )
    assert.equal(rec.calls.length, 0, 'a commit outside our jurisdiction must never be reported')
  })

  it('reports a commit in a marked repository', async () => {
    const command = 'git commit -q -m "ours"'
    handleBashPre({ session_id: SESSION, cwd: repo, tool_input: { command } })
    sh('echo two > b.txt && git add b.txt && git commit -q -m "ours"')
    const rec = recorder()
    await handleBashPost(
      { session_id: SESSION, cwd: repo, tool_input: { command }, tool_response: '' },
      { call: rec.call, boundConnection: fakeConnection },
    )
    assert.equal(rec.calls.length, 1)
  })
})

describe('choosing the connection', () => {
  it('binds only by conversation id, never by agent name', () => {
    // selectBoundState offers an agent-name fallback for hosts with no conversation id.
    // It is deliberately not used here: attributing someone else's commit to this agent
    // is worse than reporting nothing.
    const dir = path.join(sandbox, 'connections')
    fs.mkdirSync(dir, { recursive: true })
    const write = (name, raw) => fs.writeFileSync(path.join(dir, name), JSON.stringify(raw))
    write('mine.json', { enabled: true, connection_id: 'mine', local_id: SESSION, agent_name: 'Claude Code' })
    write('other.json', { enabled: true, connection_id: 'other', local_id: 'a-different-session', agent_name: 'Claude Code' })
    write('off.json', { enabled: false, connection_id: 'disabled', local_id: SESSION })

    assert.equal(boundConnection(SESSION, dir)?.connection_id, 'mine')
    assert.equal(boundConnection('a-different-session', dir)?.connection_id, 'other')
    assert.equal(boundConnection('nobody-here', dir), null)
    assert.equal(boundConnection(null, dir), null)
  })

  it('returns null when there is no state directory at all', () => {
    assert.equal(boundConnection(SESSION, path.join(sandbox, 'does-not-exist')), null)
  })
})
