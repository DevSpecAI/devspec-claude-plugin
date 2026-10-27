/** Actual installed Claude host + this plugin, scripted loopback provider/MCP (item 55feedd7).
 *
 * Proves that the host really delivers what room-unread.mjs produces:
 *  - the PostToolUse notice (matcher "*") reaches the model mid-turn, as counts only
 *  - a message arriving mid-turn holds the next room post once (PreToolUse deny)
 *  - the reader hands the messages over, after which the post goes through
 *  - the notice is not repeated for news the model already has
 *
 * No paid inference, real credentials, live DevSpec records, or shared state: a
 * disposable HOME holds the bond, connection and room copy.
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
const home = mkdtempSync(join(tmpdir(), 'claude-room-unread-runtime-'))
const work = join(home, 'work')
const localId = randomUUID(), connectionId = randomUUID(), sessionId = randomUUID()
const SELF = 'Claude Code · Fixture'
const connections = join(home, '.devspec/remote-control/connections')
const transcript = join(connections, `${connectionId}.${sessionId}.transcript.jsonl`)
const readCommand = `node '${join(root, 'hooks/scripts/room-unread.mjs')}' read --connection-id ${connectionId}`
const NOTICE = 'DevSpec room: there are messages here you have not read'
const FIRST = 'please check the deploy before you answer'
const SECOND = 'heads-up: I moved the file you are editing'

const room = []
const say = (fields) => {
  room.push({ seq: room.length + 1, at: new Date(Date.UTC(2026, 9, 6, 13, room.length)).toISOString(),
    message_id: randomUUID(), to: null, attachments: [], state: 'final', ...fields })
  writeFileSync(transcript, room.map((line) => JSON.stringify(line)).join('\n') + '\n', { mode: 0o600 })
}

const posts = [], seen = {}
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
const resultText = (block) => typeof block.content === 'string' ? block.content
  : (Array.isArray(block.content) ? block.content.map((part) => part.text ?? '').join('\n') : '')

const server = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const part of req) raw += part
    const body = raw ? JSON.parse(raw) : {}
    if (req.url.startsWith('/v1/messages/count_tokens')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"input_tokens":100}'); return }
    if (req.url.startsWith('/v1/messages')) {
      requests++
      if (!body.tools?.some((t) => t.name === 'Bash')) { respondModel(res, body, { type: 'text', text: 'fixture' }, 'end_turn'); return }
      const results = new Map()
      for (const message of body.messages ?? []) for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === 'tool_result') results.set(block.tool_use_id, block)
      }
      const everything = JSON.stringify(body.messages ?? [])
      const post = (id, message) => tool(id, 'mcp__devspec__post_session_message', { message, connection_id: connectionId })
      if (!results.has('ru_work')) {
        respondModel(res, body, tool('ru_work', 'Bash', { command: 'echo working', description: 'Do one step of the task' }), 'tool_use')
      } else if (!results.has('ru_post1')) {
        // After the first tool call the host must have shown the notice, counts only.
        seen.notice = everything.includes(NOTICE) && everything.includes('\\"unread\\":1')
        seen.noticeHadBody = everything.includes(FIRST)
        // Something arrives while the model is still working.
        say({ from: { label: 'Pi · Fixture (Ali Price)', kind: 'agent' }, text: SECOND })
        respondModel(res, body, post('ru_post1', 'first answer'), 'tool_use')
      } else if (!results.has('ru_read')) {
        const held = results.get('ru_post1')
        seen.hold = resultText(held).includes('Not posted yet') && resultText(held).includes('"unread":2')
        seen.postsBeforeRead = posts.length
        respondModel(res, body, tool('ru_read', 'Bash', { command: readCommand, description: 'Read the unread room messages' }), 'tool_use')
      } else if (!results.has('ru_post2')) {
        const read = resultText(results.get('ru_read'))
        seen.readBoth = read.includes(FIRST) && read.includes(SECOND)
        respondModel(res, body, post('ru_post2', 'answer after reading'), 'tool_use')
      } else {
        seen.secondPostAccepted = !resultText(results.get('ru_post2')).includes('Not posted yet')
        seen.noticeCount = everything.split(NOTICE).length - 1
        respondModel(res, body, { type: 'text', text: 'ROOM-UNREAD-RUNTIME-PASS' }, 'end_turn')
      }
      return
    }
    if (req.url.startsWith('/api/mcp')) {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      let result = {}
      if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } }
      else if (body.method === 'notifications/initialized') { res.writeHead(202); res.end(); return }
      else if (body.method === 'tools/list') {
        result = { tools: [{ name: 'post_session_message', description: 'Post a message into the room.',
          inputSchema: { type: 'object', properties: { message: { type: 'string' }, connection_id: { type: 'string' } }, required: ['message'] } }] }
      } else if (body.method === 'tools/call') {
        const { name, arguments: args = {} } = body.params
        if (name === 'post_session_message' && ['first answer', 'answer after reading'].includes(args.message)) posts.push(args.message)
        result = textResult({ success: true, delivery: { status: 'stored' } })
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}')
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })) }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`, endpoint = `${origin}/api/mcp`
const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'),
  ANTHROPIC_API_KEY: 'sk-ant-fixture-not-real', ANTHROPIC_BASE_URL: origin,
  DEVSPEC_MCP_TOKEN: 'fixture-not-real', DEVSPEC_MCP_URL: endpoint,
  CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  NO_PROXY: '127.0.0.1,localhost', NODE_OPTIONS: '' }
for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'DEVSPEC_REMOTE_LOCAL_ID_CLAUDE_CODE']) delete env[key]
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Host timeout: ${err.slice(-2000)} ${out.slice(-2000)}`)) }, 120_000)
    child.stdout.on('data', (data) => { out += data }); child.stderr.on('data', (data) => { err += data })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`Host exit ${code}: ${err.slice(-2000)} ${out.slice(-2000)}`)) })
  })
}
try {
  mkdirSync(work, { recursive: true }); mkdirSync(connections, { recursive: true })
  mkdirSync(join(home, '.devspec/remote-control/local/claude-code'), { recursive: true })
  writeFileSync(join(home, `.devspec/remote-control/local/claude-code/${localId}.json`), JSON.stringify({ connection_id: connectionId }), { mode: 0o600 })
  writeFileSync(join(connections, `${connectionId}.json`), JSON.stringify({ enabled: true, local_id: localId, connection_id: connectionId,
    session_id: sessionId, mcp_url: endpoint, token: 'fixture-not-real', connection_capability: 'fixture-capability', cwd: work }), { mode: 0o600 })
  writeFileSync(join(connections, `${connectionId}.${sessionId}.transcript-state.json`), JSON.stringify({ version: 1, self_label: SELF }), { mode: 0o600 })
  say({ from: { label: 'System', kind: 'system' }, text: '🔗 **Pi · Fixture** joined the session.' })
  say({ from: { label: 'Ali Price', kind: 'human' }, text: FIRST })
  const config = join(home, 'mcp.json')
  writeFileSync(config, JSON.stringify({ mcpServers: { devspec: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer fixture-not-real' } } } }))
  // Exact grants in normal manual permission mode, not bypass permissions.
  const result = await run(['-p', 'Do the disposable room fixture task.', '--plugin-dir', root,
    '--strict-mcp-config', '--mcp-config', config, '--setting-sources', '', '--session-id', localId,
    '--model', 'sonnet', '--permission-mode', 'manual',
    '--allowedTools', 'Bash(echo working)', `Bash(${readCommand})`, 'mcp__devspec__post_session_message', '--output-format', 'json'])
  assert(result.includes('ROOM-UNREAD-RUNTIME-PASS'), result.slice(-2000))
  assert.equal(seen.notice, true, 'the PostToolUse notice reached the model mid-turn, with the right count')
  assert.equal(seen.noticeHadBody, false, 'the notice carries counts, never a message body')
  assert.equal(seen.hold, true, 'a message that arrived mid-turn held the room post')
  assert.equal(seen.postsBeforeRead, 0, 'the held post never reached DevSpec')
  assert.equal(seen.readBoth, true, 'the reader handed over both messages, whole')
  assert.equal(seen.secondPostAccepted, true, 'after reading, the post went through')
  assert.deepEqual(posts, ['answer after reading'])
  assert.equal(seen.noticeCount, 1, 'news the model already had was not announced again')
  const read = JSON.parse(readFileSync(join(connections, `${connectionId}.${sessionId}.read.json`), 'utf8')).read
  assert.equal(Object.keys(read).length, 2, 'exactly the two real messages are marked read; the presence marker never counted')
  const version = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')).version
  console.log(JSON.stringify({ result: 'PASS', host: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(),
    pluginRoot: root, pluginVersion: version, ...seen, posts, paidInference: 0, liveDevspecRecords: 0, scriptedRequests: requests }))
} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(home, { recursive: true, force: true }) }
