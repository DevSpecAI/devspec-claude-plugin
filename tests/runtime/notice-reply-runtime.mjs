/** Actual installed Claude host + this plugin, scripted loopback provider/MCP (item 8ad9f857).
 *
 * Proves what only the host can show about a reply to a DevSpec notice:
 *  - a conversation whose tool list predates system_notice_ids (the host then hands
 *    the ids over as one string) still sends DevSpec the array it takes, with the
 *    conversation's own connection and no request_ref
 *  - a notice reply with complete_turn leaves the turn Working; the command's own
 *    final answer still ends it
 *  - a refused notice reply reaches the model with DevSpec's reason
 *
 * No paid inference, real credentials, live DevSpec records, or shared state: a
 * disposable HOME holds the bond and the connection.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const root = fileURLToPath(new URL('../..', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'claude-notice-reply-runtime-'))
const work = join(home, 'work')
const localId = randomUUID(), connectionId = randomUUID(), sessionId = randomUUID()
const NOTICE_A = randomUUID(), NOTICE_B = randomUUID()
const connections = join(home, '.devspec/remote-control/connections')
const turnMarker = join(connections, `${connectionId}.turn`)
const requestLog = join(connections, `${connectionId}.requests.jsonl`)
const commandRequest = randomUUID()
const NOT_ATTACHED = 'Your connection is not attached to a room, so there is nowhere to post this reply. Nothing was posted: tell the person at your terminal instead.'

const posts = [], seen = {}
let requests = 0
const textResult = (data, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) })
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
const post = (id, input) => ({ type: 'tool_use', id, name: 'mcp__devspec__post_session_message', input })
const resultText = (block) => typeof block.content === 'string' ? block.content
  : (Array.isArray(block.content) ? block.content.map((part) => part.text ?? '').join('\n') : '')

// What DevSpec answers, as the server does (apps/web/lib/mcp/notice-reply-post.ts).
function postSessionMessage(args) {
  if (args.system_notice_ids === undefined) {
    return textResult({ success: true, delivery: { status: 'stored', message_id: randomUUID() }, turn_effect: args.complete_turn ? 'completed' : 'none' })
  }
  if (!Array.isArray(args.system_notice_ids)) return { content: [{ type: 'text', text: `system_notice_ids: must be an array; got a ${typeof args.system_notice_ids}` }], isError: true }
  if (args.system_notice_ids.includes(NOTICE_B)) return textResult({ delivery: { status: 'rejected', reason: 'not_attached' }, error: NOT_ATTACHED }, true)
  const messageId = randomUUID()
  return textResult({ delivery: { status: 'stored', message_id: messageId }, message_id: messageId, session_id: sessionId, connection_id: connectionId,
    message_type: 'external_agent', phase: 'answer', notice_reply: { notice_ids: args.system_notice_ids }, turn_effect: 'none', complete_turn: false,
    ...(args.complete_turn === true ? { note: 'complete_turn has no effect on a reply to a DevSpec notice.' } : {}) })
}

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
      if (!results.has('nr_notice')) {
        seen.workingAtStart = existsSync(turnMarker)
        // The tool list predates the argument, so the host hands the ids over as a string.
        respondModel(res, body, post('nr_notice', { message: 'DevSpec found that my change clashes with a decision.', system_notice_ids: JSON.stringify([NOTICE_A]), complete_turn: true }), 'tool_use')
      } else if (!results.has('nr_refused')) {
        const stored = results.get('nr_notice')
        seen.noticeReplyStored = !stored.is_error && resultText(stored).includes('"turn_effect":"none"')
        seen.workingAfterNoticeReply = existsSync(turnMarker)
        seen.commandAnsweredByNoticeReply = readFileSync(requestLog, 'utf8').includes('"op":"answered"')
        respondModel(res, body, post('nr_refused', { message: 'Another finding.', system_notice_ids: [NOTICE_B] }), 'tool_use')
      } else if (!results.has('nr_answer')) {
        const refused = results.get('nr_refused')
        seen.refusalReachedModel = refused.is_error === true && resultText(refused).includes('not_attached') && resultText(refused).includes('tell the person at your terminal instead')
        respondModel(res, body, post('nr_answer', { message: 'Here is the answer to your command.', complete_turn: true }), 'tool_use')
      } else {
        // Once: a Stop the fixture leaves blocked (no listener armed) opens the turn again.
        seen.answerEndedTurn ??= !existsSync(turnMarker)
        respondModel(res, body, { type: 'text', text: 'NOTICE-REPLY-RUNTIME-PASS' }, 'end_turn')
      }
      return
    }
    if (req.url.startsWith('/api/mcp')) {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      let result = {}
      if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } }
      else if (body.method === 'notifications/initialized') { res.writeHead(202); res.end(); return }
      else if (body.method === 'tools/list') {
        // The schema a conversation started before the server took system_notice_ids.
        result = { tools: [{ name: 'post_session_message', description: 'Post a message into the room.',
          inputSchema: { type: 'object', properties: { message: { type: 'string' }, connection_id: { type: 'string' }, complete_turn: { type: 'boolean' } }, required: ['message'] } }] }
      } else if (body.method === 'tools/call') {
        const { name, arguments: args = {} } = body.params
        if (name === 'post_session_message' && args.turn_kind !== 'local_prompt') { posts.push(args); result = postSessionMessage(args) }
        else result = textResult({ success: true })
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
  writeFileSync(join(connections, `${connectionId}.json`), JSON.stringify({ enabled: true, agent_name: 'Claude Code', local_id: localId, connection_id: connectionId,
    session_id: sessionId, mcp_url: endpoint, token: 'fixture-not-real', connection_capability: 'fixture-capability', cwd: work }), { mode: 0o600 })
  // A room command's turn is Working, and the command is what the turn serves.
  writeFileSync(turnMarker, JSON.stringify({ startedAt: Date.now() }), { mode: 0o600 })
  writeFileSync(requestLog, [{ op: 'open', id: commandRequest, kind: 'command', provenance_ref: randomUUID(), requested_by: randomUUID() },
    { op: 'current', ref: commandRequest }].map((event) => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 })
  const config = join(home, 'mcp.json')
  writeFileSync(config, JSON.stringify({ mcpServers: { devspec: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer fixture-not-real' } } } }))
  // An exact grant in normal manual permission mode, not bypass permissions.
  const result = await run(['-p', 'Tell the room about the DevSpec notice, then answer the command.', '--plugin-dir', root,
    '--strict-mcp-config', '--mcp-config', config, '--setting-sources', '', '--session-id', localId,
    '--model', 'sonnet', '--permission-mode', 'manual',
    '--allowedTools', 'mcp__devspec__post_session_message', '--output-format', 'json'])
  assert(result.includes('NOTICE-REPLY-RUNTIME-PASS'), result.slice(-2000))
  const [noticeReply, refused, answer] = posts
  assert.equal(posts.length, 3, JSON.stringify(posts))
  assert.deepEqual(noticeReply.system_notice_ids, [NOTICE_A], 'the ids reached DevSpec as an array, from a tool list that predates them')
  assert.equal(noticeReply.connection_id, connectionId, 'the conversation\'s own connection was stamped')
  assert.equal(Object.hasOwn(noticeReply, 'request_ref'), false, 'a notice reply names no request')
  assert.deepEqual(refused.system_notice_ids, [NOTICE_B])
  assert.equal(Object.hasOwn(answer, 'system_notice_ids'), false, 'the command\'s answer was never stamped as a notice reply')
  assert.equal(seen.noticeReplyStored, true, 'the notice reply was stored as one')
  assert.equal(seen.workingAtStart, true, 'precondition: the command\'s turn was Working')
  assert.equal(seen.workingAfterNoticeReply, true, 'a notice reply with complete_turn left the turn Working')
  assert.equal(seen.commandAnsweredByNoticeReply, false, 'a notice reply did not answer the command the turn serves')
  assert.equal(seen.refusalReachedModel, true, 'the refusal reached the model with DevSpec\'s reason')
  assert.equal(seen.answerEndedTurn, true, 'the command\'s own final answer ended the turn')
  const version = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')).version
  console.log(JSON.stringify({ result: 'PASS', host: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(),
    pluginRoot: root, pluginVersion: version, ...seen, sent: posts.map((args) => ({ system_notice_ids: args.system_notice_ids ?? null, connection_id: args.connection_id ?? null, complete_turn: args.complete_turn ?? null })),
    paidInference: 0, liveDevspecRecords: 0, scriptedRequests: requests }))
} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(home, { recursive: true, force: true }) }
