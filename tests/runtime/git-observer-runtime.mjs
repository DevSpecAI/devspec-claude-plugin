/** Actual installed Claude host + this plugin, scripted loopback provider/MCP (item 604c360a).
 *
 * Proves that the git stand-in reaches every way Claude Code runs a shell command,
 * and that each commit the agent makes is reported once, by itself:
 *  - the agent's own Bash command, git -C another repository, a chained command,
 *    a script, an amend and a linked worktree
 *  - a background Bash command, a subagent's Bash command and a Monitor command
 *  - in a repository with an origin but no DevSpec pin and no MCP entry
 *  - with nothing written to the repository or its git configuration
 *
 * No paid inference, real credentials, live DevSpec records, or shared state: a
 * disposable HOME holds the bond, the connection and the repositories.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const root = fileURLToPath(new URL('../..', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'claude-git-observer-runtime-'))
const repo = join(home, 'repo'), other = join(home, 'other repo'), worktree = join(home, 'linked worktree')
const localId = randomUUID(), connectionId = randomUUID()
const ORIGIN = 'git@github.com:fixture/repo.git', OTHER_ORIGIN = 'https://github.com/fixture/other.git'
const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const script = join(home, 'commit.sh')
const MAIN = [
  ['own', `git commit --allow-empty -q -m own`],
  ['other', `git -C '${other}' commit --allow-empty -q -m other`],
  ['chained', `git commit --allow-empty -q -m chained-1 && echo between && git commit --allow-empty -q -m chained-2`],
  ['script', `'${script}'`],
  // In the other repository, so it never contends with the next commit on main.
  ['background', `sleep 1; git -C '${other}' commit --allow-empty -q -m background`, { run_in_background: true }],
  // Claude Code asks before `cd <dir> && git ...`, so the linked worktree is named with -C.
  ['worktree', `git -C '${worktree}' commit --allow-empty -q -m worktree`],
]
const SETTLE = 'sleep 3; git commit --allow-empty -q -m to-amend && git commit --amend --allow-empty -q -m amended'
const reports = [], seen = {}
let requests = 0
const textResult = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
function respondModel(res, body, block, stop) {
  const message = { id: `fixture_${requests}`, type: 'message', role: 'assistant', model: body.model,
    content: [block], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }
  if (!body.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(message)); return }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  send('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } })
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } })
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } })
  send('content_block_stop', { type: 'content_block_stop', index: 0 })
  send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } })
  send('message_stop', { type: 'message_stop' }); res.end()
}
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input })
const bash = (id, command, extra = {}) => tool(id, 'Bash', { command, description: 'Run the disposable git fixture step', ...extra })
const firstText = (body) => {
  const first = body.messages?.[0]?.content
  return typeof first === 'string' ? first : Array.isArray(first) ? first.map((part) => part.text ?? '').join('\n') : ''
}

const server = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const part of req) raw += part
    const body = raw ? JSON.parse(raw) : {}
    if (req.url.startsWith('/v1/messages/count_tokens')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"input_tokens":100}'); return }
    if (req.url.startsWith('/v1/messages')) {
      requests++
      const names = (body.tools ?? []).map((t) => t.name)
      if (!names.includes('Bash')) { respondModel(res, body, { type: 'text', text: 'fixture' }, 'end_turn'); return }
      const results = new Set()
      for (const message of body.messages ?? []) for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === 'tool_result') results.add(block.tool_use_id)
      }
      if (firstText(body).includes('SUBAGENT-COMMIT')) {
        seen.subagentRan = true
        if (!results.has('sub_commit')) respondModel(res, body, bash('sub_commit', 'git commit --allow-empty -q -m subagent'), 'tool_use')
        else respondModel(res, body, { type: 'text', text: 'committed' }, 'end_turn')
        return
      }
      const next = MAIN.find(([id]) => !results.has(id))
      if (next) respondModel(res, body, bash(next[0], next[1], next[2]), 'tool_use')
      else if (!results.has('subagent')) respondModel(res, body, tool('subagent', 'Agent', { description: 'Commit in a subagent', prompt: 'SUBAGENT-COMMIT: make one empty commit', subagent_type: 'general-purpose' }), 'tool_use')
      else if (!results.has('load_monitor') && !names.includes('Monitor')) respondModel(res, body, tool('load_monitor', 'ToolSearch', { query: 'select:Monitor', max_results: 1 }), 'tool_use')
      else if (!results.has('monitor')) respondModel(res, body, tool('monitor', 'Monitor', { command: 'git commit --allow-empty -q -m monitor', description: 'Commit from a monitor', timeout_ms: 10000 }), 'tool_use')
      else if (!results.has('settle')) respondModel(res, body, bash('settle', SETTLE), 'tool_use')
      else respondModel(res, body, { type: 'text', text: 'GIT-OBSERVER-RUNTIME-PASS' }, 'end_turn')
      return
    }
    if (req.url.startsWith('/api/mcp')) {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      let result = {}
      if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } }
      else if (body.method === 'notifications/initialized') { res.writeHead(202); res.end(); return }
      else if (body.method === 'tools/list') result = { tools: [] }
      else if (body.method === 'tools/call') {
        const { name, arguments: args = {} } = body.params
        if (name === 'report_commit_provenance') {
          assert.equal(req.headers['x-devspec-connection-capability'], 'fixture-capability')
          reports.push(args); result = textResult({ recorded: true, repository_verified: true })
        } else result = textResult({ success: true })
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}')
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })) }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`, endpoint = `${origin}/api/mcp`
const env = { ...process.env, ...IDENTITY, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'),
  ANTHROPIC_API_KEY: 'sk-ant-fixture-not-real', ANTHROPIC_BASE_URL: origin,
  DEVSPEC_MCP_TOKEN: 'fixture-not-real', DEVSPEC_MCP_URL: endpoint,
  CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  NO_PROXY: '127.0.0.1,localhost', NODE_OPTIONS: '' }
for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'DEVSPEC_REMOTE_LOCAL_ID_CLAUDE_CODE', 'CLAUDE_ENV_FILE']) delete env[key]
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Host timeout: ${err.slice(-2000)} ${out.slice(-2000)}`)) }, 180_000)
    child.stdout.on('data', (data) => { out += data }); child.stderr.on('data', (data) => { err += data })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`Host exit ${code}: ${err.slice(-2000)} ${out.slice(-2000)}`)) })
  })
}
try {
  for (const [dir, url, branch] of [[repo, ORIGIN, 'main'], [other, OTHER_ORIGIN, 'trunk']]) {
    mkdirSync(dir); git(['init', '-q', '-b', branch], dir); git(['commit', '--allow-empty', '-qm', 'base'], dir); git(['remote', 'add', 'origin', url], dir)
  }
  git(['worktree', 'add', '-qb', 'topic', worktree])
  writeFileSync(script, '#!/bin/sh\ngit commit --allow-empty -q -m script\n', { mode: 0o755 })
  const before = { config: readFileSync(join(repo, '.git/config'), 'utf8'), hooks: readdirSync(join(repo, '.git/hooks')).sort() }
  const connections = join(home, '.devspec/remote-control/connections'); mkdirSync(connections, { recursive: true })
  writeFileSync(join(connections, `${connectionId}.json`), JSON.stringify({ enabled: true, agent_name: 'Claude Code', local_id: localId, connection_id: connectionId,
    session_id: null, mcp_url: endpoint, token: 'fixture-not-real', connection_capability: 'fixture-capability', cwd: repo }), { mode: 0o600 })
  const config = join(home, 'mcp.json'); writeFileSync(config, JSON.stringify({ mcpServers: {} }))
  const grants = [...MAIN.map(([, command]) => `Bash(${command})`), 'Bash(git commit --allow-empty -q -m subagent)', `Bash(${SETTLE})`, 'Agent', 'Monitor', 'ToolSearch']
  // Exact grants in normal manual permission mode, not bypass permissions.
  const result = await run(['-p', 'Run the disposable git observer fixture.', '--plugin-dir', root,
    '--strict-mcp-config', '--mcp-config', config, '--setting-sources', '', '--session-id', localId,
    '--model', 'sonnet', '--permission-mode', 'manual', '--allowedTools', ...grants, '--output-format', 'json'])
  assert(result.includes('GIT-OBSERVER-RUNTIME-PASS'), result.slice(-2000))
  assert.equal(seen.subagentRan, true, 'the subagent ran')

  const made = (dir, range) => git(['log', '--format=%H %s', range], dir).split('\n').filter(Boolean).map((line) => line.split(' '))
  const commits = [...made(repo, 'main'), ...made(other, 'trunk'), ...made(worktree, 'topic')].filter(([, subject]) => subject !== 'base')
  const subjects = commits.map(([, subject]) => subject).sort()
  assert.deepEqual(subjects, ['amended', 'background', 'chained-1', 'chained-2', 'monitor', 'other', 'own', 'script', 'subagent', 'worktree'].sort(),
    'every fixture commit was made')
  // The commit the amend replaced is no longer on the branch; it was reported when it was made.
  const replaced = reports.map((report) => report.commit_sha).filter((sha) => !commits.some(([made]) => made === sha))
  const bySha = new Map(reports.map((report) => [report.commit_sha, report]))
  for (const [sha, subject] of commits) assert.ok(bySha.has(sha), `the ${subject} commit was reported`)
  assert.equal(reports.length, commits.length + replaced.length, 'each commit reported once')
  assert.equal(replaced.length, 1, 'the commit the amend replaced was reported when it was made')
  assert.equal(new Set(reports.map((report) => report.observation_id)).size, reports.length)
  for (const report of reports) {
    assert.match(report.commit_sha, /^[0-9a-f]{40}$/)
    assert.equal(report.connection_id, connectionId)
    assert.equal(report.pinned_project_id, undefined, 'no pin: the origin is what is sent')
  }
  assert.equal(bySha.get(commits.find(([, subject]) => subject === 'other')[0]).git_remote, OTHER_ORIGIN)
  assert.equal(bySha.get(commits.find(([, subject]) => subject === 'worktree')[0]).branch, 'topic')
  assert.equal(bySha.get(commits.find(([, subject]) => subject === 'own')[0]).git_remote, ORIGIN)
  assert.deepEqual({ config: readFileSync(join(repo, '.git/config'), 'utf8'), hooks: readdirSync(join(repo, '.git/hooks')).sort() }, before, 'nothing installed in the repository')
  assert.equal(existsSync(join(repo, '.devspec')), false)
  const log = readFileSync(join(home, '.devspec/git-observer/commits.log'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.equal(log.filter((entry) => entry.outcome === 'reported').length, reports.length, 'every outcome is in the plugin log')
  const version = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')).version
  console.log(JSON.stringify({ result: 'PASS', host: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(),
    pluginRoot: root, pluginVersion: version, commitsMade: commits.length, reports: reports.length, amendedAway: replaced.length,
    paths: ['own', 'git -C', 'chained', 'script', 'background', 'worktree', 'subagent', 'monitor', 'amend'],
    paidInference: 0, liveDevspecRecords: 0, scriptedRequests: requests }))
} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(home, { recursive: true, force: true }) }
