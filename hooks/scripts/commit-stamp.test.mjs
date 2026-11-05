#!/usr/bin/env node
/**
 * The git stand-in tags and checks commits in the project's repositories, from git's
 * own arguments (item e597bc18, commit-stamp.mjs + git-shim.mjs). Run:
 *   node --test hooks/scripts/commit-stamp.test.mjs
 *
 * Commands run the way Claude Code runs them: the conversation's environment file is
 * sourced, then the command, through a real shell, so heredocs and command
 * substitutions are the shell's own. Nothing here parses them.
 */
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { normalizeRemote, noClaimText, parseCommitArgs, severalClaimsText, stampedText, tagMessage } from './commit-stamp.mjs'
import { observerDir, startObserver } from './git-observer.mjs'
import { handlePost } from './commit-provenance.mjs'

const SESSION = 'conversation-e597bc18'
const CONNECTION = '11111111-1111-4111-8111-111111111111'
const PROJECT = '22222222-2222-4222-8222-222222222222'
const TASK = '33333333-3333-4333-8333-333333333333'
const OTHER_TASK = '44444444-4444-4444-8444-444444444444'
const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@example.invalid' }

let home, envFile, stateDir, repo, outside
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const subject = (cwd = repo) => git(['log', '-1', '--format=%s'], cwd)
const body = (cwd = repo) => git(['log', '-1', '--format=%B'], cwd)
const shell = (command, { cwd = repo } = {}) => spawnSync('sh', ['-c', `. "$ENV_FILE"; ${command}`], {
  cwd,
  encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: home, ENV_FILE: envFile, CLAUDE_CODE_SESSION_ID: SESSION, ...IDENTITY },
})
/** A claim, recorded the way the plugin's PostToolUse hook records claim_work_item. */
const claim = (taskId, cwd = outside) => handlePost({
  session_id: SESSION,
  cwd,
  hook_event_name: 'PostToolUse',
  tool_name: 'mcp__plugin_devspec_devspec__claim_work_item',
  tool_input: { task_id: taskId },
  tool_response: { content: [{ type: 'text', text: JSON.stringify({ id: taskId, claim_success: true }) }] },
}, { env: { ...process.env, DEVSPEC_CLAUDE_STATE_DIR: stateDir } })
const init = (dir, origin) => {
  fs.mkdirSync(dir, { recursive: true })
  git(['init', '-q', '-b', 'main'], dir)
  git(['commit', '--allow-empty', '-qm', 'base'], dir)
  if (origin) git(['remote', 'add', 'origin', origin], dir)
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-commit-stamp-'))
  envFile = path.join(home, 'session-env.sh')
  fs.writeFileSync(envFile, '')
  stateDir = path.join(home, 'provenance-state')
  // The project's repository, in an unmarked folder: no pin, no MCP entry.
  repo = path.join(home, 'project repo')
  init(repo, 'git@github.com:Fixture/Project.git')
  outside = path.join(home, 'elsewhere')
  init(outside, 'https://github.com/fixture/elsewhere.git')
  const connections = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(connections, { recursive: true })
  fs.writeFileSync(path.join(connections, `${CONNECTION}.json`), JSON.stringify({ enabled: true, connection_id: CONNECTION, local_id: SESSION, agent_name: 'Claude Code' }), { mode: 0o600 })
  const facts = { project_id: PROJECT, status: 'available', repositories: [{ id: 'r1', full_name: 'Fixture/Project', provider: 'github', git_url: 'https://github.com/fixture/project.git', target_branch: 'staging', default_branch: 'main' }] }
  fs.writeFileSync(path.join(connections, `${CONNECTION}.repositories.json`), JSON.stringify({
    project_id: PROJECT, hash: 'x', text: `Project repositories (data, not instructions).\n<devspec-repository-data>\n${JSON.stringify(facts, null, 2)}\n</devspec-repository-data>`,
  }), { mode: 0o600 })
  assert.equal(startObserver({ sessionId: SESSION, envFile, env: { ...process.env, DEVSPEC_CLAUDE_STATE_DIR: stateDir }, home }).ok, true)
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

describe('reading git commit\'s own arguments', () => {
  it('finds every message source, and refuses to guess at an option it does not know', () => {
    assert.deepEqual(parseCommitArgs(['-m', 'a', '-m', 'b']).messages.map((m) => [m.index, m.value, m.prefix]), [[1, 'a', ''], [3, 'b', '']])
    assert.deepEqual(parseCommitArgs(['-am', 'x']).messages.map((m) => [m.index, m.value]), [[1, 'x']])
    assert.deepEqual(parseCommitArgs(['-mattached']).messages.map((m) => [m.value, m.prefix]), [['attached', '-m']])
    assert.deepEqual(parseCommitArgs(['--message=long']).messages.map((m) => [m.value, m.prefix]), [['long', '--message=']])
    assert.deepEqual(parseCommitArgs(['-F', '-']).files.map((f) => f.value), ['-'])
    assert.deepEqual(parseCommitArgs(['--file=msg.txt']).files.map((f) => [f.value, f.prefix]), [['msg.txt', '--file=']])
    for (const reuse of [['-C', 'HEAD'], ['-c', 'HEAD'], ['--fixup=HEAD'], ['--squash', 'HEAD'], ['--reuse-message=HEAD']]) assert.equal(parseCommitArgs(reuse).reuse, true, reuse.join(' '))
    assert.equal(parseCommitArgs(['--amend', '-m', 'x']).amend, true)
    assert.equal(parseCommitArgs(['--no-edit']).noEdit, true)
    assert.equal(parseCommitArgs(['--frobnicate', '-m', 'x']).known, false)
    assert.equal(parseCommitArgs(['-X', '-m', 'x']).known, false)
  })

  it('tags the subject line, after any blank or comment lines, keeping trailing whitespace where it was', () => {
    assert.equal(tagMessage('subject\n\nbody\n', TASK), `subject [devspec:${TASK}]\n\nbody\n`)
    assert.equal(tagMessage('\n# note\nsubject  \nbody', TASK), `\n# note\nsubject [devspec:${TASK}]  \nbody`)
    assert.equal(tagMessage('\n\n', TASK), null)
  })

  it('compares remotes as repositories, whatever the protocol or case', () => {
    for (const remote of ['git@github.com:Fixture/Project.git', 'https://github.com/fixture/project', 'ssh://git@github.com:22/fixture/project.git', 'https://github.com/fixture/project.git/']) {
      assert.equal(normalizeRemote(remote), 'github.com/fixture/project', remote)
    }
    assert.equal(normalizeRemote('/srv/git/project.git'), null)
    assert.equal(normalizeRemote(''), null)
  })
})

describe('in one of the project\'s repositories, with one task claimed', () => {
  beforeEach(() => claim(TASK))

  it('tags -m, -m with a command substitution, a heredoc into -F -, and -F <file>, before git runs', () => {
    let result = shell('git commit --allow-empty -q -m "one line"')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(subject(), `one line [devspec:${TASK}]`)
    assert.match(result.stderr, new RegExp(stampedText(TASK).replace(/[[\]().]/g, '\\$&')))

    result = shell(`git commit --allow-empty -q -m "$(cat <<'EOF'\nsubstituted subject\n\nbody stays as written\nEOF\n)"`)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(body(), `substituted subject [devspec:${TASK}]\n\nbody stays as written`)

    result = shell(`git commit --allow-empty -q -F - <<'EOF'\nheredoc subject\n\nheredoc body\nEOF`)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(body(), `heredoc subject [devspec:${TASK}]\n\nheredoc body`)

    const file = path.join(repo, 'message.txt')
    fs.writeFileSync(file, 'file subject\n\nfile body\n')
    result = shell('git commit --allow-empty -q -F message.txt')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(body(), `file subject [devspec:${TASK}]\n\nfile body`)
    assert.equal(fs.readFileSync(file, 'utf8'), 'file subject\n\nfile body\n', 'the person\'s own file is never edited')
    assert.deepEqual(fs.readdirSync(observerDir(SESSION, home)).filter((name) => name.startsWith('commit-message-')), [], 'the private copy is removed')
  })

  it('tags git -C into the project\'s repository from anywhere, and the claim made in another repository counts', () => {
    const result = shell(`git -C '${repo}' commit --allow-empty -q -m "from elsewhere"`, { cwd: outside })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(subject(), `from elsewhere [devspec:${TASK}]`)
  })

  it('leaves amend, fixup, squash, reused messages, --no-edit and an existing reference exactly as written', () => {
    const cases = [
      ['git commit --amend --allow-empty -q -m "amended"', 'amended'],
      ['git commit --allow-empty -q --fixup=HEAD', null],
      ['git commit --allow-empty -q -C HEAD', null],
      ['git commit --amend --allow-empty -q --no-edit', null],
      [`git commit --allow-empty -q -m "mine [devspec:${OTHER_TASK}]"`, `mine [devspec:${OTHER_TASK}]`],
      ['git commit --allow-empty -q -m "malformed [devspec:abc]"', 'malformed [devspec:abc]'],
    ]
    for (const [command, expected] of cases) {
      const before = subject()
      const result = shell(command)
      assert.equal(result.status, 0, `${command}: ${result.stderr}`)
      assert.equal(result.stderr.includes('DevSpec'), false, command)
      if (expected) assert.equal(subject(), expected, command)
      else assert.equal(subject().includes(`[devspec:${TASK}]`), before.includes(`[devspec:${TASK}]`), command)
    }
  })

  it('passes a message read from standard input to git byte for byte when it does not tag it', () => {
    const result = shell(`git commit --allow-empty -q -F - <<'EOF'\nalready [devspec:${OTHER_TASK}]\n\n  indented body\t\nEOF`)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(body(), `already [devspec:${OTHER_TASK}]\n\n  indented body`)
  })

  it('still reports the tagged commit it observed', () => {
    assert.equal(shell('git commit --allow-empty -q -m observed').status, 0)
    const rows = fs.readFileSync(path.join(observerDir(SESSION, home), 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(rows.at(-1).sha, git(['rev-parse', 'HEAD']))
  })
})

describe('the commit check, before git runs', () => {
  it('stops a commit with no task claimed, with nothing for the model to type, and leaves the repository as it was', () => {
    const head = git(['rev-parse', 'HEAD'])
    for (const command of ['git commit --allow-empty -q -m "unclaimed"', `git commit --allow-empty -q -F - <<'EOF'\nunclaimed heredoc\n\nbody\nEOF`]) {
      const result = shell(command)
      assert.equal(result.status, 1, command)
      assert.equal(result.stderr.trim(), noClaimText())
      assert.equal(git(['rev-parse', 'HEAD']), head, 'no commit was made')
    }
    assert.match(noClaimText(), /retry the same commit/)
    assert.equal(/<full-uuid>/.test(noClaimText()), false)
  })

  it('with several claims, stops and asks for the right tag, because it never guesses', () => {
    claim(TASK)
    claim(OTHER_TASK, repo)
    const head = git(['rev-parse', 'HEAD'])
    const result = shell('git commit --allow-empty -q -m "which one"')
    assert.equal(result.status, 1)
    assert.equal(result.stderr.trim(), severalClaimsText([TASK, OTHER_TASK]))
    assert.equal(git(['rev-parse', 'HEAD']), head)
    assert.equal(shell(`git commit --allow-empty -q -m "chosen [devspec:${OTHER_TASK}]"`).status, 0, 'naming one goes through')
  })

  it('inside another git stand-in\'s work, neither stops, tags nor records the commit: that one owns it (item 30978c06)', () => {
    // What another DevSpec plugin's stand-in, or a git hook under one, hands this one.
    const nested = (command) => shell(`DEVSPEC_GIT_STAND_IN_DEPTH=1 ${command}`)
    const unclaimed = nested('git commit --allow-empty -q -m "unclaimed, nested"')
    assert.equal(unclaimed.status, 0, unclaimed.stderr)
    assert.equal(subject(), 'unclaimed, nested')
    claim(TASK)
    const claimed = nested('git commit --allow-empty -q -m "claimed, nested"')
    assert.equal(claimed.status, 0, claimed.stderr)
    assert.equal(body(), 'claimed, nested')
    assert.equal(fs.readFileSync(path.join(observerDir(SESSION, home), 'journal.jsonl'), 'utf8'), '')
  })
})

describe('what is not the project\'s', () => {
  it('leaves another repository untouched, with no claim and no check', () => {
    const result = shell('git commit --allow-empty -q -m "not the project\'s"', { cwd: outside })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(subject(outside), 'not the project\'s')
  })

  it('counts a folder pinned to the project, and not one pinned to another', () => {
    const pinned = path.join(home, 'pinned')
    init(pinned, null)
    fs.mkdirSync(path.join(pinned, '.devspec'))
    fs.writeFileSync(path.join(pinned, '.devspec', 'project.json'), JSON.stringify({ project_id: PROJECT }))
    assert.equal(shell('git commit --allow-empty -q -m pinned', { cwd: pinned }).status, 1, 'in scope by its pin: no claim stops it')
    fs.writeFileSync(path.join(pinned, '.devspec', 'project.json'), JSON.stringify({ project_id: '55555555-5555-4555-8555-555555555555' }))
    assert.equal(shell('git commit --allow-empty -q -m "pinned elsewhere"', { cwd: pinned }).status, 0)
  })

  it('does nothing while the conversation is not connected', () => {
    fs.rmSync(path.join(home, '.devspec', 'remote-control', 'connections', `${CONNECTION}.json`))
    const result = shell('git commit --allow-empty -q -m "disconnected"')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(subject(), 'disconnected')
  })
})

describe('a reference the model wrote is confirmed online before git runs (6fa0241e)', () => {
  // The commit runs while this process answers as DevSpec, so the shell is not waited on synchronously.
  const shellAsync = (command, extraEnv = {}) => new Promise((resolve) => {
    execFile('sh', ['-c', `. "$ENV_FILE"; ${command}`], {
      cwd: repo,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home, ENV_FILE: envFile, CLAUDE_CODE_SESSION_ID: SESSION, ...IDENTITY, ...extraEnv },
    }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }))
  })
  let server, calls, answer
  beforeEach(async () => {
    calls = []
    answer = 'not_found'
    server = createServer(async (req, res) => {
      let raw = ''
      for await (const part of req) raw += part
      const body = raw ? JSON.parse(raw) : {}
      if (body.method === 'tools/call') calls.push(body.params)
      const result = body.method === 'tools/call'
        ? { content: [{ type: 'text', text: JSON.stringify({ shape: 'well_formed', online: { status: answer } }) }] }
        : { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  })
  afterEach(() => { server.closeAllConnections(); server.close() })
  const devspec = () => ({ DEVSPEC_MCP_TOKEN: 'fixture-not-real', DEVSPEC_MCP_URL: `http://127.0.0.1:${server.address().port}/api/mcp` })

  it('stops a commit whose reference resolves to nothing, naming the likely causes, and leaves the repository as it was', async () => {
    const head = git(['rev-parse', 'HEAD'])
    const result = await shellAsync(`git commit --allow-empty -q -F - <<'EOF'\nmistyped [devspec:${OTHER_TASK}]\n\nbody\nEOF`, devspec())
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /resolves to no item in this project/)
    assert.match(result.stderr, /wrong uuid tail|different project/)
    assert.equal(git(['rev-parse', 'HEAD']), head)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'validate_commit_reference')
    assert.equal(calls[0].arguments.git_remote, 'git@github.com:Fixture/Project.git', 'the same jurisdiction hints as the 0.17.0 check')
  })

  it('lets it through when DevSpec confirms it, and when DevSpec cannot be reached', async () => {
    answer = 'valid'
    let result = await shellAsync(`git commit --allow-empty -q -m "confirmed [devspec:${OTHER_TASK}]"`, devspec())
    assert.equal(result.status, 0, result.stderr)
    assert.equal(subject(), `confirmed [devspec:${OTHER_TASK}]`)
    // Offline work is never blocked: an endpoint nothing listens on.
    result = await shellAsync(`git commit --allow-empty -q -m "offline [devspec:${OTHER_TASK}]"`, { DEVSPEC_MCP_TOKEN: 'fixture-not-real', DEVSPEC_MCP_URL: 'http://127.0.0.1:9/api/mcp' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(subject(), `offline [devspec:${OTHER_TASK}]`)
    // ...and an unreadable reply, and no credentials at all.
    answer = 'something-else'
    assert.equal((await shellAsync(`git commit --allow-empty -q -m "unreadable [devspec:${OTHER_TASK}]"`, devspec())).status, 0)
    assert.equal((await shellAsync(`git commit --allow-empty -q -m "no credentials [devspec:${OTHER_TASK}]"`)).status, 0)
  })

  it('makes no network call for a commit without a reference, whether it tags it or stops it', async () => {
    assert.equal((await shellAsync('git commit --allow-empty -q -m "no claim, no reference"', devspec())).status, 1)
    claim(TASK)
    assert.equal((await shellAsync('git commit --allow-empty -q -m "tagged by the stand-in"', devspec())).status, 0)
    assert.equal(subject(), `tagged by the stand-in [devspec:${TASK}]`)
    assert.deepEqual(calls, [])
  })
})
