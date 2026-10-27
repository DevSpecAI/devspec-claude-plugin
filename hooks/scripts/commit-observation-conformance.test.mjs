import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, test } from 'node:test'
import { handleBashPre, handleBashPost } from './commit-observation.mjs'

// P4 / 3d1f5f9d: moving a ref or observing an old object is not creating it.
let root, repo
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const original = { connection_id: '11111111-1111-4111-8111-111111111111', project_id: '22222222-2222-4222-8222-222222222222', mcp_url: 'https://example.invalid/api/mcp', token: 'fixture-token', connection_capability: 'fixture-capability' }
const input = (command) => ({ session_id: 'fixture-session', tool_use_id: 'fixture-tool', cwd: repo, tool_input: { command } })
const pre = (event) => handleBashPre(event, { boundConnection: () => original })
const reports = async (event, state = original) => {
  const calls = []
  await handleBashPost(event, { boundConnection: () => state, call: async (call) => { calls.push(call); return { ok: true } } })
  return calls
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-p4-observation-'))
  repo = path.join(root, 'repo'); fs.mkdirSync(repo)
  process.env.DEVSPEC_CLAUDE_STATE_DIR = path.join(root, 'state')
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  git('commit', '--allow-empty', '-qm', 'base')
  fs.mkdirSync(path.join(repo, '.devspec'))
  fs.writeFileSync(path.join(repo, '.devspec', 'project.json'), JSON.stringify({ project_id: original.project_id }))
})
afterEach(() => { delete process.env.DEVSPEC_CLAUDE_STATE_DIR; fs.rmSync(root, { recursive: true, force: true }) })

test('positive control: a direct commit retains exact observation and connection', async () => {
  const event = input('git commit --allow-empty -q -m "new"'); pre(event)
  git('commit', '--allow-empty', '-q', '-m', 'new')
  const calls = await reports({ ...event, tool_response: '' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].arguments.connection_id, original.connection_id)
  assert.equal(calls[0].arguments.commit_sha, git('rev-parse', 'HEAD'))
})

test('fast-forward merge never claims creation of the existing target commit', async () => {
  const branch = git('branch', '--show-current')
  git('checkout', '-qb', 'topic'); git('commit', '--allow-empty', '-qm', 'someone else'); git('checkout', '-q', branch)
  const event = input('git merge --ff-only topic'); pre(event)
  const output = git('merge', '--ff-only', 'topic')
  assert.equal((await reports({ ...event, tool_response: output })).length, 0)
})

test('replaying a commit summary without a pre-execution observation never attributes an old object', async () => {
  const event = input('git commit -m "nothing staged"')
  const output = `[${git('branch', '--show-current')} ${git('rev-parse', '--short', 'HEAD')}] base`
  assert.equal((await reports({ ...event, tool_response: output })).length, 0)
})

test('a reconnect between pre and post never restamps the observation with the new connection', async () => {
  const event = input('git commit --allow-empty -q -m "new"'); pre(event)
  git('commit', '--allow-empty', '-q', '-m', 'new')
  const calls = await reports({ ...event, tool_response: '' }, { ...original, connection_id: '33333333-3333-4333-8333-333333333333' })
  assert.ok(calls.every(call => call.arguments.connection_id === original.connection_id), 'a new bond must not own an older observation')
})

test('a failed command never reports a concurrently advanced HEAD', async () => {
  const event = input('git commit -q -m "nothing staged"'); pre(event)
  git('commit', '--allow-empty', '-qm', 'concurrent actor')
  assert.equal((await reports({ ...event, tool_response: { stdout: '', stderr: 'nothing to commit', exit_code: 1 } })).length, 0)
})
