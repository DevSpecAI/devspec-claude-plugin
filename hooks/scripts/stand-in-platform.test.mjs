#!/usr/bin/env node
/**
 * The git stand-in, on every platform Claude Code runs it on (item 4054ff58). Run:
 *   node --test hooks/scripts/stand-in-platform.test.mjs
 *
 * GitHub's Windows and Linux runners both run this (.github/workflows/stand-in.yml).
 * Commands go through the shell Claude Code uses: sh on macOS and Linux, Git Bash on
 * Windows. The conversation's environment file is sourced first, as Claude Code does,
 * then the command. Every path has a space in it.
 *
 * On native Windows the session-start hook does not start the stand-in yet (Claude
 * Code's PowerShell tool, git-observer.mjs standInAllowed); the first test checks that
 * with the real hook. The rest set it up directly, so the Windows job proves it works
 * there before it is switched on.
 *
 * Covered, as on Linux: a plain commit, a heredoc into -F -, -m with a command
 * substitution and -F <file> are tagged with the one claimed task and reported; with no
 * claim the commit is stopped before git runs; a repository outside the project is left
 * untouched; git -C works with both spellings of a Windows path (C:/… and /c/…); and
 * the online check of a reference the model wrote stops one that resolves to nothing
 * and lets the commit through when DevSpec cannot be reached.
 */
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { drainObserver, observerActive, observerDir, startObserver, toBashPath } from './git-observer.mjs'
import { handlePost } from './commit-provenance.mjs'
import { noClaimText } from './commit-stamp.mjs'

const WINDOWS = process.platform === 'win32'
const SESSION = 'conversation-4054ff58'
const CONNECTION = '11111111-1111-4111-8111-111111111111'
const PROJECT = '22222222-2222-4222-8222-222222222222'
const TASK = '33333333-3333-4333-8333-333333333333'
const OTHER_TASK = '44444444-4444-4444-8444-444444444444'
const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@example.invalid' }

/** The shell Claude Code runs commands in. */
const SHELL = WINDOWS ? (process.env.CLAUDE_CODE_GIT_BASH_PATH || 'C:\\Program Files\\Git\\bin\\bash.exe') : 'sh'
/** A path as a command line in that shell writes it. */
const inShell = (target) => (WINDOWS ? target.replace(/\\/g, '/') : target)

let home, envFile, stateDir, repo, outside, messageFile
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const body = (cwd = repo) => git(['log', '-1', '--format=%B'], cwd)

function shellEnv(extra = {}) {
  // Windows programs need their system variables; elsewhere PATH is enough.
  const base = WINDOWS ? Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE_|DEVSPEC_|GIT_TRACE2)/i.test(key))) : { PATH: process.env.PATH }
  return { ...base, HOME: home, USERPROFILE: home, ENV_FILE: inShell(envFile), CLAUDE_CODE_SESSION_ID: SESSION, ...IDENTITY, ...extra }
}
/** One command, the way Claude Code runs it for this conversation. */
const shell = (command, { cwd = repo, env = {} } = {}) => new Promise((resolve) => {
  execFile(SHELL, ['-c', `. "$ENV_FILE"; ${command}`], { cwd, encoding: 'utf8', env: shellEnv(env) },
    (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }))
})
const claim = (taskId) => handlePost({
  session_id: SESSION,
  cwd: outside,
  hook_event_name: 'PostToolUse',
  tool_name: 'mcp__plugin_devspec_devspec__claim_work_item',
  tool_input: { task_id: taskId },
  tool_response: { content: [{ type: 'text', text: JSON.stringify({ id: taskId, claim_success: true }) }] },
}, { env: { ...process.env, DEVSPEC_CLAUDE_STATE_DIR: stateDir } })
const init = (dir, origin) => {
  fs.mkdirSync(dir, { recursive: true })
  git(['init', '-q', '-b', 'main'], dir)
  git(['commit', '--allow-empty', '-qm', 'base'], dir)
  git(['remote', 'add', 'origin', origin], dir)
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec stand-in '))
  envFile = path.join(home, 'session-env.sh')
  fs.writeFileSync(envFile, '')
  stateDir = path.join(home, 'provenance state')
  repo = path.join(home, 'project repo')
  init(repo, 'git@github.com:Fixture/Project.git')
  outside = path.join(home, 'elsewhere repo')
  init(outside, 'https://github.com/fixture/elsewhere.git')
  messageFile = path.join(repo, 'message file.txt')
  const connections = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(connections, { recursive: true })
  fs.writeFileSync(path.join(connections, `${CONNECTION}.json`), JSON.stringify({ enabled: true, connection_id: CONNECTION, local_id: SESSION, agent_name: 'Claude Code' }), { mode: 0o600 })
  const facts = { project_id: PROJECT, status: 'available', repositories: [{ id: 'r1', full_name: 'Fixture/Project', provider: 'github', git_url: 'https://github.com/fixture/project.git', target_branch: 'staging', default_branch: 'main' }] }
  fs.writeFileSync(path.join(connections, `${CONNECTION}.repositories.json`), JSON.stringify({
    project_id: PROJECT, hash: 'x', text: `<devspec-repository-data>\n${JSON.stringify(facts)}\n</devspec-repository-data>`,
  }), { mode: 0o600 })
  const started = startObserver({ sessionId: SESSION, envFile, env: { ...process.env, DEVSPEC_CLAUDE_STATE_DIR: stateDir }, home })
  assert.equal(started.ok, true, started.reason)
})
after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

describe(`the git stand-in on ${process.platform}`, () => {
  it(WINDOWS ? 'is not started by the session-start hook on native Windows yet' : 'is started by the session-start hook', () => {
    const hookEnv = path.join(home, 'hook-env.sh')
    fs.writeFileSync(hookEnv, '')
    const hook = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'git-observer.mjs'), 'session-start'], {
      input: JSON.stringify({ session_id: 'hook-check', hook_event_name: 'SessionStart' }),
      encoding: 'utf8',
      env: { ...shellEnv(), CLAUDE_ENV_FILE: hookEnv, DEVSPEC_CLAUDE_STATE_DIR: stateDir },
    })
    assert.equal(hook.status, 0, hook.stderr)
    assert.equal(hook.stdout, '', 'a hook says nothing to the model')
    if (WINDOWS) {
      assert.equal(fs.readFileSync(hookEnv, 'utf8'), '', 'nothing is added to the environment file')
      assert.equal(observerActive('hook-check', home), false)
    } else {
      assert.match(fs.readFileSync(hookEnv, 'utf8'), /^export PATH='.*\/hook-check\/bin':"\$PATH"\n$/)
      assert.equal(observerActive('hook-check', home), true)
    }
  })

  it('is the git the shell runs, from the line the environment file adds to PATH', async () => {
    const bin = path.join(observerDir(SESSION, home), 'bin')
    const line = fs.readFileSync(envFile, 'utf8').trim()
    assert.equal(line, `export PATH='${WINDOWS ? toBashPath(bin) : bin}':"$PATH"`)
    const found = await shell('command -v git')
    assert.equal(found.stdout.trim(), `${WINDOWS ? toBashPath(bin) : bin}/git`)
  })

  it('stops a commit when no task is claimed, before git runs', async () => {
    const head = git(['rev-parse', 'HEAD'])
    const result = await shell('git commit --allow-empty -q -m "no claim yet"')
    assert.equal(result.status, 1, result.stderr)
    assert.equal(result.stderr.trim(), noClaimText())
    assert.equal(git(['rev-parse', 'HEAD']), head)
  })

  it('tags a plain commit, a heredoc into -F -, -m with a command substitution and -F <file>', async () => {
    claim(TASK)
    const tag = `[devspec:${TASK}]`
    const cases = [
      ['git commit --allow-empty -q -m "plain subject"', `plain subject ${tag}`],
      [`git commit --allow-empty -q -F - <<'EOF'\nheredoc subject\n\nheredoc body\nEOF`, `heredoc subject ${tag}\n\nheredoc body`],
      [`git commit --allow-empty -q -m "$(cat <<'EOF'\nsubstituted subject\n\nsubstituted body\nEOF\n)"`, `substituted subject ${tag}\n\nsubstituted body`],
    ]
    for (const [command, expected] of cases) {
      const result = await shell(command)
      assert.equal(result.status, 0, `${command}: ${result.stderr}`)
      assert.equal(body(), expected, command)
      assert.match(result.stderr, /DevSpec: added \[devspec:/)
    }
    fs.writeFileSync(messageFile, 'file subject\n\nfile body\n')
    const result = await shell(`git commit --allow-empty -q -F '${inShell(messageFile)}'`)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(body(), `file subject ${tag}\n\nfile body`)
    assert.equal(fs.readFileSync(messageFile, 'utf8'), 'file subject\n\nfile body\n', 'the person\'s own file is never edited')
  })

  it('leaves a repository outside the project untouched', async () => {
    const result = await shell(`git -C '${inShell(outside)}' commit --allow-empty -q -m "not the project's"`)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(body(outside), "not the project's")
  })

  it('tags git -C into the project from elsewhere, with the path as Git Bash spells it', async () => {
    const result = await shell(`git -C '${toBashPath(repo)}' commit --allow-empty -q -m "from elsewhere"`, { cwd: outside })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(body(), `from elsewhere [devspec:${TASK}]`)
  })

  describe('a reference the model wrote is confirmed online first', () => {
    let server
    const calls = []
    before(async () => {
      server = createServer(async (req, res) => {
        let raw = ''
        for await (const part of req) raw += part
        const request = raw ? JSON.parse(raw) : {}
        if (request.method === 'tools/call') calls.push(request.params)
        const result = request.method === 'tools/call'
          ? { content: [{ type: 'text', text: JSON.stringify({ shape: 'well_formed', online: { status: 'not_found' } }) }] }
          : { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    })
    after(() => { server.closeAllConnections(); server.close() })

    it('stops one that resolves to nothing, before git runs', async () => {
      const head = git(['rev-parse', 'HEAD'])
      const result = await shell(`git commit --allow-empty -q -m "mistyped [devspec:${OTHER_TASK}]"`, {
        env: { DEVSPEC_MCP_TOKEN: 'fixture-not-real', DEVSPEC_MCP_URL: `http://127.0.0.1:${server.address().port}/api/mcp` },
      })
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /resolves to no item in this project/)
      assert.equal(git(['rev-parse', 'HEAD']), head)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].name, 'validate_commit_reference')
    })

    it('lets the commit through when DevSpec cannot be reached', async () => {
      const result = await shell(`git commit --allow-empty -q -m "written by hand [devspec:${OTHER_TASK}]"`, {
        env: { DEVSPEC_MCP_TOKEN: 'fixture-not-real', DEVSPEC_MCP_URL: 'http://127.0.0.1:9/api/mcp' },
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(body(), `written by hand [devspec:${OTHER_TASK}]`)
    })
  })

  it('reports every commit it saw, once, with its full id and the repository\'s address', async () => {
    const calls = []
    const call = async (request) => { calls.push(request.arguments); return { recorded: true } }
    const boundConnection = () => ({ connection_id: CONNECTION, token: 'x', mcp_url: 'https://example.invalid/api/mcp' })
    for (let i = 0; i < 4; i += 1) await drainObserver({ sessionId: SESSION, home, boundConnection, call })
    // Every commit after each repository's first, oldest first.
    const made = (cwd) => git(['rev-list', '--reverse', 'HEAD'], cwd).split('\n').slice(1)
    const project = made(repo)
    assert.equal(project.length, 6, 'plain, heredoc, substituted, file, from elsewhere, written by hand')
    assert.deepEqual(calls.filter((report) => report.git_remote === 'git@github.com:Fixture/Project.git').map((report) => report.commit_sha), project)
    assert.deepEqual(calls.filter((report) => report.git_remote === 'https://github.com/fixture/elsewhere.git').map((report) => report.commit_sha), made(outside))
    assert.equal(calls.length, 7)
    for (const report of calls) assert.match(report.commit_sha, /^[0-9a-f]{40}$/)
  })
})
