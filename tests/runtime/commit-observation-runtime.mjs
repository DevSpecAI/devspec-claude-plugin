/** Actual installed Claude host + this plugin, scripted loopback provider/MCP.
 * No paid inference, real credentials, live DevSpec records, or shared Git changes.
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
const home = mkdtempSync(join(tmpdir(), 'claude-provenance-runtime-'))
const repo = join(home, 'repo'), wt = join(home, 'linked worktree')
const project = randomUUID(), localId = randomUUID(), connectionId = randomUUID(), item = randomUUID()
const reports = [], completed = new Set()
let requests = 0
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commands = [
  `git commit --allow-empty -q -m 'direct [devspec:${item}]'`,
  `git -C '${wt}' commit --allow-empty -q -m 'worktree [devspec:${item}]'`,
  `cd '${wt}' && git commit --allow-empty -q -m 'prefixed [devspec:${item}]'`,
  `git -C '${repo}' merge --ff-only topic`,
]
const textResult = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
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
const server = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const part of req) raw += part
    const body = raw ? JSON.parse(raw) : {}
    if (req.url.startsWith('/v1/messages/count_tokens')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"input_tokens":100}'); return }
    if (req.url.startsWith('/v1/messages')) {
      requests++
      if (!body.tools?.some(tool => tool.name === 'Bash')) { respondModel(res, body, { type: 'text', text: 'fixture' }, 'end_turn'); return }
      for (const message of body.messages ?? []) for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === 'tool_result') completed.add(block.tool_use_id)
      }
      const next = commands.findIndex((_, i) => !completed.has(`provenance_${i}`))
      if (next < 0) respondModel(res, body, { type: 'text', text: 'PROVENANCE-RUNTIME-PASS' }, 'end_turn')
      else respondModel(res, body, { type: 'tool_use', id: `provenance_${next}`, name: 'Bash', input: { command: commands[next], description: 'Execute the exact disposable Git fixture command' } }, 'tool_use')
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
          reports.push(args); result = textResult({ recorded: true })
        } else if (name === 'validate_commit_reference') result = textResult({ status: 'valid', valid: true, action_item_id: item })
        else result = textResult({ success: true, commands: [], project_id: project, connection_id: connectionId })
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}')
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`, endpoint = `${origin}/api/mcp`
const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'),
  ANTHROPIC_API_KEY: 'sk-ant-fixture-not-real', ANTHROPIC_BASE_URL: origin,
  DEVSPEC_MCP_TOKEN: 'fixture-not-real', DEVSPEC_MCP_URL: endpoint,
  DEVSPEC_CLAUDE_STATE_DIR: join(home, 'provenance-state'),
  CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  NO_PROXY: '127.0.0.1,localhost', NODE_OPTIONS: '' }
for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'DEVSPEC_REMOTE_LOCAL_ID_CLAUDE_CODE']) delete env[key]
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: wt, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Host timeout: ${err.slice(-2000)} ${out.slice(-2000)}`)) }, 120_000)
    child.stdout.on('data', data => { out += data }); child.stderr.on('data', data => { err += data })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`Host exit ${code}: ${err.slice(-2000)} ${out.slice(-2000)}`)) })
  })
}
try {
  mkdirSync(repo); git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid'])
  git(['commit', '--allow-empty', '-qm', 'base'])
  git(['worktree', 'add', '-qb', 'topic', wt])
  mkdirSync(join(repo, '.devspec')); writeFileSync(join(repo, '.devspec/project.json'), JSON.stringify({ project_id: project }))
  const connections = join(home, '.devspec/remote-control/connections'); mkdirSync(connections, { recursive: true })
  writeFileSync(join(connections, `${connectionId}.json`), JSON.stringify({ enabled: true, local_id: localId,
    connection_id: connectionId, session_id: null, mcp_url: endpoint, token: 'fixture-not-real', connection_capability: 'fixture-capability', cwd: repo }), { mode: 0o600 })
  const config = join(home, 'mcp.json'); writeFileSync(config, JSON.stringify({ mcpServers: {} }))
  // Exact-command grants in normal manual permission mode, not bypass permissions.
  const result = await run(['-p', 'Run the disposable provenance fixture.', '--plugin-dir', root,
    '--strict-mcp-config', '--mcp-config', config, '--setting-sources', '', '--session-id', localId,
    '--model', 'sonnet', '--permission-mode', 'manual', '--allowedTools', ...commands.map(command => `Bash(${command})`), '--output-format', 'json'])
  assert(result.includes('PROVENANCE-RUNTIME-PASS'), result.slice(-2000))
  assert.equal(completed.size, 4)
  assert.equal(git(['rev-parse', 'HEAD']), git(['rev-parse', 'HEAD'], wt), 'the host must actually execute the fast-forward, not merely return a denied/failed tool result')
  assert.equal(reports.length, 3, 'only the three direct commits are observations; ff merge is not creation')
  assert.equal(new Set(reports.map(report => report.observation_id)).size, 3)
  for (const report of reports) {
    assert.equal(report.connection_id, connectionId); assert.equal(report.pinned_project_id, project)
    assert.match(report.commit_sha, /^[0-9a-f]{40}$/)
  }
  assert.deepEqual(reports.map(report => git(['show', '-s', '--format=%s', report.commit_sha])),
    ['direct', 'worktree', 'prefixed'].map(subject => `${subject} [devspec:${item}]`))
  const version = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')).version
  console.log(JSON.stringify({ result: 'PASS', host: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(),
    pluginRoot: root, pluginVersion: version, directReports: reports.length, fastForwardAttributed: false,
    literalWorktreeForms: ['cd', 'git -C'], paidInference: 0, liveDevspecRecords: 0, scriptedRequests: requests }))
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(home, { recursive: true, force: true }) }
