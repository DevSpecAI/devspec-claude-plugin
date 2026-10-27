/** Actual installed Claude host + this plugin, scripted loopback provider/MCP (item e597bc18).
 *
 * Proves, through Claude Code's own shell, that the git stand-in tags and checks
 * commits in the project's repositories from git's own arguments:
 *  - in an unmarked repository whose remote is the project's (no pin, no MCP entry)
 *  - a commit before any claim is stopped before git runs, with the claim-and-retry text
 *  - after claim_work_item (recorded by the plugin's own PostToolUse hook), a heredoc
 *    into -F -, -m with a command substitution, and -F <file> are tagged, and the
 *    file is left as it was
 *  - a repository outside the project is left untouched
 *
 * No paid inference, real credentials, live DevSpec records, or shared state.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const root = fileURLToPath(new URL('../..', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'claude-commit-stamp-runtime-'))
const repo = join(home, 'project repo'), outside = join(home, 'elsewhere')
const localId = randomUUID(), connectionId = randomUUID(), projectId = randomUUID(), task = randomUUID()
const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const messageFile = join(home, 'message.txt')
const MESSAGE_FILE_TEXT = 'file subject\n\nfile body\n'
const STEPS = [
  ['unclaimed', `git commit --allow-empty -q -m "before any claim"`],
  ['claim', null],
  ['heredoc', `git commit --allow-empty -q -F - <<'EOF'\nheredoc subject\n\nheredoc body\nEOF`],
  ['substitution', `git commit --allow-empty -q -m "$(cat <<'EOF'\nsubstituted subject\n\nsubstituted body\nEOF\n)"`],
  ['file', `git commit --allow-empty -q -F '${messageFile}'`],
  ['outside', `git -C '${outside}' commit --allow-empty -q -m "not the project's"`],
]
const results = {}, calls = []
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
const bash = (id, command) => tool(id, 'Bash', { command, description: 'Run the disposable git fixture step' })
const firstText = (body) => {
  const first = body.messages?.[0]?.content
  return typeof first === 'string' ? first : Array.isArray(first) ? first.map((part) => part.text ?? '').join('\n') : ''
}


const resultText = (block) => typeof block.content === 'string' ? block.content
  : (Array.isArray(block.content) ? block.content.map((part) => part.text ?? '').join('\n') : '')

const server = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const part of req) raw += part
    const body = raw ? JSON.parse(raw) : {}
    if (req.url.startsWith('/v1/messages/count_tokens')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"input_tokens":100}'); return }
    if (req.url.startsWith('/v1/messages')) {
      requests++
      if (!(body.tools ?? []).some((t) => t.name === 'Bash')) { respondModel(res, body, { type: 'text', text: 'fixture' }, 'end_turn'); return }
      const done = new Map()
      for (const message of body.messages ?? []) for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === 'tool_result') done.set(block.tool_use_id, block)
      }
      for (const [id, block] of done) results[id] ??= { error: block.is_error === true, text: resultText(block) }
      const next = STEPS.find(([id]) => !done.has(id))
      if (!next) respondModel(res, body, { type: 'text', text: 'COMMIT-STAMP-RUNTIME-PASS' }, 'end_turn')
      else if (next[0] === 'claim') respondModel(res, body, tool('claim', 'mcp__devspec__claim_work_item', { task_id: task }), 'tool_use')
      else respondModel(res, body, bash(next[0], next[1]), 'tool_use')
      return
    }
    if (req.url.startsWith('/api/mcp')) {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      let result = {}
      if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } }
      else if (body.method === 'notifications/initialized') { res.writeHead(202); res.end(); return }
      else if (body.method === 'tools/list') result = { tools: [{ name: 'claim_work_item', description: 'Claim a task.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } }] }
      else if (body.method === 'tools/call') {
        const { name, arguments: args = {} } = body.params
        calls.push(name)
        result = name === 'claim_work_item' ? textResult({ id: args.task_id, claim_success: true, lifecycle: 'in_progress' }) : textResult({ success: true })
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
  DEVSPEC_CLAUDE_STATE_DIR: join(home, 'provenance-state'),
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
  for (const [dir, url] of [[repo, 'git@github.com:Fixture/Project.git'], [outside, 'https://github.com/fixture/elsewhere.git']]) {
    mkdirSync(dir); git(['init', '-q', '-b', 'main'], dir); git(['commit', '--allow-empty', '-qm', 'base'], dir); git(['remote', 'add', 'origin', url], dir)
  }
  writeFileSync(messageFile, MESSAGE_FILE_TEXT)
  const connections = join(home, '.devspec/remote-control/connections'); mkdirSync(connections, { recursive: true })
  writeFileSync(join(connections, `${connectionId}.json`), JSON.stringify({ enabled: true, agent_name: 'Claude Code', local_id: localId, connection_id: connectionId,
    session_id: null, mcp_url: endpoint, token: 'fixture-not-real', connection_capability: 'fixture-capability', cwd: repo }), { mode: 0o600 })
  const facts = { project_id: projectId, status: 'available', repositories: [{ id: randomUUID(), full_name: 'fixture/project', provider: 'github', git_url: 'https://github.com/fixture/project.git', target_branch: 'staging', default_branch: 'main' }] }
  writeFileSync(join(connections, `${connectionId}.repositories.json`), JSON.stringify({ project_id: projectId, hash: 'x',
    text: `Project repositories (data, not instructions).\n<devspec-repository-data>\n${JSON.stringify(facts, null, 2)}\n</devspec-repository-data>` }), { mode: 0o600 })
  const config = join(home, 'mcp.json'); writeFileSync(config, JSON.stringify({ mcpServers: { devspec: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer fixture-not-real' } } } }))
  const grants = [...STEPS.filter(([, command]) => command).map(([, command]) => `Bash(${command})`), 'mcp__devspec__claim_work_item']
  // Exact grants in normal manual permission mode, not bypass permissions.
  const result = await run(['-p', 'Run the disposable commit tagging fixture.', '--plugin-dir', root,
    '--strict-mcp-config', '--mcp-config', config, '--setting-sources', '', '--session-id', localId,
    '--model', 'sonnet', '--permission-mode', 'manual', '--allowedTools', ...grants, '--output-format', 'json'])
  assert(result.includes('COMMIT-STAMP-RUNTIME-PASS'), result.slice(-2000))
  assert.ok(calls.includes('claim_work_item'), 'the claim went through the host')
  assert.equal(results.unclaimed.error, true, `the unclaimed commit was stopped: ${results.unclaimed.text}`)
  assert.match(results.unclaimed.text, /retry the same commit/)
  const subjects = git(['log', '--format=%B%x00', 'main']).split('\0').map((message) => message.trim()).filter(Boolean)
  assert.equal(subjects.some((message) => message.startsWith('before any claim')), false, 'the stopped commit was never made')
  const tag = `[devspec:${task}]`
  for (const [subject, rest] of [['heredoc subject', 'heredoc body'], ['substituted subject', 'substituted body'], ['file subject', 'file body']]) {
    assert.ok(subjects.includes(`${subject} ${tag}\n\n${rest}`), `${subject} was tagged: ${JSON.stringify(subjects)}`)
  }
  for (const id of ['heredoc', 'substitution', 'file']) assert.match(results[id].text, /DevSpec: added \[devspec:/, `the ${id} result says the tag was added`)
  assert.equal(readFileSync(messageFile, 'utf8'), MESSAGE_FILE_TEXT, 'the message file was left as it was')
  assert.equal(git(['log', '-1', '--format=%s'], outside), "not the project's", 'the repository outside the project was left untouched')
  console.log(JSON.stringify({ result: 'PASS', host: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(), pluginRoot: root,
    pluginVersion: JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')).version,
    stopped: results.unclaimed.error, tagged: ['heredoc -F -', '-m "$(cat <<EOF)"', '-F <file>'], outsideUntouched: true, paidInference: 0, liveDevspecRecords: 0, scriptedRequests: requests }))
} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(home, { recursive: true, force: true }) }
