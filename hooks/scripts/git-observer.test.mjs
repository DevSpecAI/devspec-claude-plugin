#!/usr/bin/env node
/**
 * The git stand-in reports every commit the agent's shell makes, from git itself
 * (item 604c360a, git-observer.mjs + git-shim.mjs). Run:
 *   node --test hooks/scripts/git-observer.test.mjs
 *
 * The shell commands here run the way Claude Code runs them: the conversation's
 * environment file is sourced first, then the command. Nothing parses them.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { LIMITS, drainObserver, endObserver, logPath, observerActive, observerDir, reportArguments, startObserver } from './git-observer.mjs'
import { McpToolRefusalError } from './mcp-call.mjs'

const SESSION = 'conversation-604c360a'
const CONNECTION = '11111111-1111-4111-8111-111111111111'
const PROJECT = '22222222-2222-4222-8222-222222222222'
const ORIGIN = 'git@github.com:fixture/repo.git'
const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@example.invalid' }

let home, envFile, repo, state
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const connectionsDir = () => path.join(home, '.devspec', 'remote-control', 'connections')
/** This conversation's connection, as the plugin's own state file records it. */
const bond = (connectionId = CONNECTION) => {
  fs.mkdirSync(connectionsDir(), { recursive: true })
  fs.writeFileSync(path.join(connectionsDir(), `${connectionId}.json`), JSON.stringify({ enabled: true, connection_id: connectionId, local_id: SESSION, agent_name: 'Claude Code' }), { mode: 0o600 })
}
/** A shell command as Claude Code runs it for this conversation. */
const shell = (command, { cwd = repo, session = SESSION } = {}) => spawnSync('sh', ['-c', `. "$ENV_FILE"; ${command}`], {
  cwd,
  encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: home, ENV_FILE: envFile, ...(session ? { CLAUDE_CODE_SESSION_ID: session } : {}), ...IDENTITY },
})
const journal = () => {
  try {
    return fs.readFileSync(path.join(observerDir(SESSION, home), 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}
const drain = (options = {}) => {
  const calls = []
  return drainObserver({
    sessionId: SESSION,
    home,
    boundConnection: () => state,
    call: async (request) => { calls.push(request); return { recorded: true, repository_verified: true } },
    ...options,
  }).then((outcomes) => ({ outcomes, calls }))
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-git-observer-'))
  envFile = path.join(home, 'session-env.sh')
  fs.writeFileSync(envFile, '')
  repo = path.join(home, 'repo')
  fs.mkdirSync(repo)
  git(['init', '-q', '-b', 'main'])
  git(['commit', '--allow-empty', '-qm', 'base'])
  git(['remote', 'add', 'origin', ORIGIN])
  state = { connection_id: CONNECTION, token: 'fixture-token', mcp_url: 'https://example.invalid/api/mcp', connection_capability: 'fixture-capability' }
  bond()
  assert.equal(startObserver({ sessionId: SESSION, envFile, env: process.env, home }).ok, true)
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

describe('session start', () => {
  it('adds only the stand-in to PATH, in the environment file, and keeps git first-class', () => {
    const text = fs.readFileSync(envFile, 'utf8')
    assert.deepEqual(text.trim().split('\n'), [`export PATH='${path.join(observerDir(SESSION, home), 'bin')}':"$PATH"`])
    const resolved = shell('command -v git').stdout.trim()
    assert.equal(resolved, path.join(observerDir(SESSION, home), 'bin', 'git'))
    assert.equal(observerActive(SESSION, home), true)
    assert.equal(fs.statSync(observerDir(SESSION, home)).mode & 0o777, 0o700)
  })

  it('does not start where it cannot run', () => {
    assert.deepEqual(startObserver({ sessionId: 'other', envFile, home, platform: 'win32' }), { ok: false, reason: 'windows' })
    assert.deepEqual(startObserver({ sessionId: 'other', envFile: undefined, home }), { ok: false, reason: 'no CLAUDE_ENV_FILE' })
    assert.equal(observerActive('other', home), false)
  })
})

describe('what the stand-in records', () => {
  it('records each commit once, with the full id from git, however the command was written', async () => {
    const other = path.join(home, 'other repo')
    fs.mkdirSync(other)
    git(['init', '-q', '-b', 'trunk'], other)
    git(['commit', '--allow-empty', '-qm', 'base'], other)
    git(['remote', 'add', 'origin', 'https://github.com/fixture/other.git'], other)
    const worktree = path.join(home, 'linked worktree')
    git(['worktree', 'add', '-qb', 'topic', worktree])
    fs.writeFileSync(path.join(home, 'commit.sh'), '#!/bin/sh\ngit commit --allow-empty -q -m "from a script"\n', { mode: 0o755 })
    const expected = []
    const step = (command, cwd, where) => {
      const result = shell(command, { cwd })
      assert.equal(result.status, 0, `${command}: ${result.stderr}`)
      expected.push(...where())
    }
    step('git commit --allow-empty -q -m one', repo, () => [git(['rev-parse', 'HEAD'])])
    step(`git -C '${other}' commit --allow-empty -q -m two`, repo, () => [git(['rev-parse', 'HEAD'], other)])
    step('git commit --allow-empty -q -m three && echo done && git commit --allow-empty -q -m four', repo, () => [git(['rev-parse', 'HEAD~1']), git(['rev-parse', 'HEAD'])])
    step(`'${path.join(home, 'commit.sh')}'`, repo, () => [git(['rev-parse', 'HEAD'])])
    step('git commit --amend --allow-empty -q -m "four, amended"', repo, () => [git(['rev-parse', 'HEAD'])])
    step('git commit --allow-empty -q -m "in a worktree"', worktree, () => [git(['rev-parse', 'HEAD'], worktree)])
    step('git -c alias.save=commit save --allow-empty -q -m "by alias"', repo, () => [git(['rev-parse', 'HEAD'])])
    const rows = journal()
    assert.deepEqual(rows.map((row) => row.sha), expected)
    for (const row of rows) assert.match(row.sha, /^[0-9a-f]{40}$/)
    assert.deepEqual(rows.map((row) => row.amend), [false, false, false, false, false, true, false, false])
    assert.equal(rows[1].remote, 'https://github.com/fixture/other.git')
    assert.equal(rows[1].branch, 'trunk')
    assert.equal(rows[6].branch, 'topic')
    assert.equal(rows[6].remote, ORIGIN, 'a linked worktree shares its repository\'s origin')
    assert.ok(rows.every((row) => row.connection_id === CONNECTION && row.session_id === SESSION))

    // One hook sends at most LIMITS.perDrain; the next sends the rest.
    const first = await drain()
    assert.equal(first.calls.length, LIMITS.perDrain)
    const calls = [...first.calls, ...(await drain()).calls]
    assert.deepEqual(calls.map((call) => call.arguments.commit_sha), expected)
    assert.deepEqual(calls[1].arguments, {
      connection_id: CONNECTION, commit_sha: expected[1], observation_id: rows[1].observation_id, branch: 'trunk', git_remote: 'https://github.com/fixture/other.git',
    })
    assert.ok(calls.every((call) => call.name === 'report_commit_provenance' && call.connectionCapability === 'fixture-capability'))
    assert.equal((await drain()).calls.length, 0, 'each commit is reported once')
    assert.equal(fs.existsSync(path.join(observerDir(SESSION, home), 'pending')), false)
  })

  it('records nothing for commands that make no commit, and changes nothing git does', () => {
    const status = shell('git status --short; git log -1 --format=%s; git rev-parse --is-inside-work-tree')
    assert.equal(status.status, 0)
    assert.equal(status.stdout, 'base\ntrue\n')
    const failed = shell('git commit -q -m "nothing staged"')
    assert.equal(failed.status, 1, 'git\'s own exit status comes back')
    assert.match(failed.stdout + failed.stderr, /nothing to commit|nothing added/)
    const unknown = shell('git definitely-not-a-command')
    assert.notEqual(unknown.status, 0)
    assert.match(unknown.stderr, /not a git command/)
    assert.deepEqual(journal(), [])
  })

  it('installs nothing in the repository or its git configuration', () => {
    const before = { config: fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8'), hooks: fs.readdirSync(path.join(repo, '.git', 'hooks')).sort() }
    assert.equal(shell('git commit --allow-empty -q -m observed').status, 0)
    assert.equal(journal().length, 1)
    assert.deepEqual({ config: fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8'), hooks: fs.readdirSync(path.join(repo, '.git', 'hooks')).sort() }, before)
  })

  it('leaves another conversation\'s commits to that conversation', () => {
    assert.equal(shell('git commit --allow-empty -q -m "a nested claude"', { session: 'someone-else' }).status, 0)
    assert.deepEqual(journal(), [])
  })

  it('records a commit made while not connected as no connection\'s, and never reports it', async () => {
    fs.rmSync(path.join(connectionsDir(), `${CONNECTION}.json`))
    assert.equal(shell('git commit --allow-empty -q -m offline').status, 0)
    assert.equal(journal()[0].connection_id, null)
    const { calls, outcomes } = await drain()
    assert.equal(calls.length, 0)
    assert.equal(outcomes[0].outcome, 'skipped')
  })

  it('still runs git when observation cannot', () => {
    const dir = observerDir(SESSION, home)
    fs.chmodSync(path.join(dir, 'journal.jsonl'), 0o400) // the journal cannot be written
    fs.chmodSync(dir, 0o500)
    try {
      const result = shell('git commit --allow-empty -q -m "unobserved but made" && git log -1 --format=%s')
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, 'unobserved but made\n')
    } finally {
      fs.chmodSync(dir, 0o700)
      fs.chmodSync(path.join(dir, 'journal.jsonl'), 0o600)
    }
    // ...and with the stand-in's script gone, git runs directly.
    fs.rmSync(path.join(dir, 'git-shim.mjs'))
    const direct = shell('git commit --allow-empty -q -m "no stand-in" && git log -1 --format=%s')
    assert.equal(direct.status, 0, direct.stderr)
    assert.equal(direct.stdout, 'no stand-in\n')
    assert.deepEqual(journal(), [])
  })
})

describe('reporting', () => {
  const logged = () => fs.readFileSync(logPath(home), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))

  it('sends the origin, or with no origin the pin, and nothing for neither', () => {
    const item = { sha: 'a'.repeat(40), observation_id: '33333333-3333-4333-8333-333333333333', branch: 'main', worktree: repo }
    assert.deepEqual(reportArguments({ ...item, remote: ORIGIN }, CONNECTION).args.git_remote, ORIGIN)
    assert.deepEqual(reportArguments({ ...item, remote: null }, CONNECTION, { pin: () => ({ project_id: PROJECT }) }).args.pinned_project_id, PROJECT)
    assert.match(reportArguments({ ...item, remote: null }, CONNECTION, { pin: () => null }).skip, /no origin/)
    assert.match(reportArguments({ ...item, remote: 'https://user:secret@github.com/x/y.git' }, CONNECTION).skip, /credentials/)
  })

  it('logs a refusal, and never retries it', async () => {
    assert.equal(shell('git commit --allow-empty -q -m refused').status, 0)
    let attempts = 0
    const { outcomes } = await drain({ call: async () => { attempts += 1; throw new McpToolRefusalError('git_remote is not a repository tracked on this project') } })
    assert.deepEqual(outcomes.map((outcome) => outcome.outcome), ['refused'])
    await drain({ call: async () => { attempts += 1; throw new Error('should not be called') } })
    assert.equal(attempts, 1)
    const line = logged().find((entry) => entry.outcome === 'refused')
    assert.match(line.reason, /not a repository tracked/)
    assert.equal(line.sha, git(['rev-parse', 'HEAD']))
  })

  it('tries a failed send again, a bounded number of times, then logs it as dropped', async () => {
    assert.equal(shell('git commit --allow-empty -q -m offline-server').status, 0)
    const offline = async () => { throw Object.assign(new Error('fetch failed'), { transport: true }) }
    let now = Date.now()
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const { outcomes } = await drain({ call: offline, now })
      assert.deepEqual(outcomes.map((outcome) => outcome.outcome), attempt < 5 ? [] : ['dropped'])
      now += 11 * 60_000
    }
    assert.match(logged().find((entry) => entry.outcome === 'dropped').reason, /fetch failed \(after 5 attempts\)/)
    assert.equal(git(['log', '-1', '--format=%s']), 'offline-server')
  })

  it('reports at session end and removes the conversation\'s directory', async () => {
    assert.equal(shell('git commit --allow-empty -q -m last').status, 0)
    const calls = []
    await endObserver({ sessionId: SESSION, home, boundConnection: () => state, call: async (request) => { calls.push(request); return { recorded: true } } })
    assert.equal(calls.length, 1)
    assert.equal(fs.existsSync(observerDir(SESSION, home)), false)
    assert.equal(shell('git log -1 --format=%s').stdout, 'last\n', 'with the directory gone, git still runs')
    // A commit still waiting when the conversation ends is logged, not lost silently.
    assert.equal(startObserver({ sessionId: SESSION, envFile, env: process.env, home }).ok, true)
    assert.equal(shell('git commit --allow-empty -q -m "never sent"').status, 0)
    await endObserver({ sessionId: SESSION, home, boundConnection: () => null, call: async () => { throw new Error('not called') } })
    assert.equal(logged().filter((entry) => entry.outcome === 'dropped' && /ended while not connected/.test(entry.reason)).length, 1)
  })

  it('never reports a commit as a connection the conversation was not bound to when it was made', async () => {
    assert.equal(shell('git commit --allow-empty -q -m before-reconnect').status, 0)
    state = { ...state, connection_id: '44444444-4444-4444-8444-444444444444' }
    const { calls, outcomes } = await drain()
    assert.equal(calls.length, 0)
    assert.match(outcomes[0].reason, /different connection/)
  })
})
