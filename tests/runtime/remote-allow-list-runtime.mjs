/** Actual installed Claude host + this plugin, scripted loopback provider/MCP (item f24ee061).
 *
 * A Claude Code driven from DevSpec runs with nobody at its terminal, so a DevSpec
 * tool its flow calls must be pre-approved by the devspec-remote-command skill's
 * `allowed-tools:`, or the agent stops at a permission prompt nobody can answer.
 * add_implementation_note was missing, so an agent leaving a note on an item
 * stalled there. This proves, in the real host, that:
 *  - once the skill is loaded, every DevSpec tool its allow-list grants runs with
 *    no grant of its own (the run gives the host none, in manual permission mode)
 *  - a DevSpec tool the list does not grant is still refused, so the pass above is
 *    the allow-list and not a permissive host
 *
 * The tools it calls are DISCOVERED from the skill's own list, so a tool added to
 * the list is exercised without editing this file. No paid inference, real
 * credentials, live DevSpec records, or shared state: a disposable HOME.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { devspecToolVerb } from '../../hooks/scripts/devspec-tool-name.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'claude-remote-allow-list-runtime-'))
const work = join(home, 'work')
const SKILL = 'devspec:devspec-remote-command'
// Never pre-approved by any remote list: only a person present may verify work.
const UNGRANTED = 'verify_action_item'

const skillText = readFileSync(join(root, 'skills/devspec-remote-command/SKILL.md'), 'utf8')
const granted = [...new Set(/^allowed-tools:(.*)$/m.exec(skillText)[1].split(',').map((t) => devspecToolVerb(t.trim())).filter(Boolean))]
assert.ok(granted.includes('add_implementation_note'), 'the skill grants add_implementation_note')
assert.ok(!granted.includes(UNGRANTED), `the control tool ${UNGRANTED} must stay ungranted`)

const called = [], results = {}
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

// The calls the scripted model makes, in order: load the skill, call every tool it
// grants, then the one it does not.
const plan = [{ id: 'al_skill', name: 'Skill', input: null }]
for (const verb of granted) plan.push({ id: `al_${verb}`, name: `mcp__devspec__${verb}`, input: {} })
plan.push({ id: `al_${UNGRANTED}`, name: `mcp__devspec__${UNGRANTED}`, input: {} })

const server = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const part of req) raw += part
    const body = raw ? JSON.parse(raw) : {}
    if (req.url.startsWith('/v1/messages/count_tokens')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"input_tokens":100}'); return }
    if (req.url.startsWith('/v1/messages')) {
      requests++
      const skillTool = body.tools?.find((t) => t.name === 'Skill')
      if (!skillTool) { respondModel(res, body, { type: 'text', text: 'fixture' }, 'end_turn'); return }
      for (const message of body.messages ?? []) for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === 'tool_result') results[block.tool_use_id] = block
      }
      const next = plan.find((step) => !results[step.id])
      if (!next) { respondModel(res, body, { type: 'text', text: 'REMOTE-ALLOW-LIST-RUNTIME-PASS' }, 'end_turn'); return }
      // The Skill tool's own field name, read from the schema the host serves.
      const input = next.name === 'Skill' ? { [Object.keys(skillTool.input_schema.properties)[0]]: SKILL } : next.input
      respondModel(res, body, tool(next.id, next.name, input), 'tool_use')
      return
    }
    if (req.url.startsWith('/api/mcp')) {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      let result = {}
      if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } }
      else if (body.method === 'notifications/initialized') { res.writeHead(202); res.end(); return }
      else if (body.method === 'tools/list') {
        result = { tools: [...granted, UNGRANTED].map((name) => ({ name, description: `Fixture ${name}.`, inputSchema: { type: 'object', properties: {} } })) }
      } else if (body.method === 'tools/call') {
        called.push(body.params.name)
        result = textResult({ outcome: 'committed', fixture: body.params.name })
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
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Host timeout: ${err.slice(-2000)} ${out.slice(-2000)}`)) }, 180_000)
    child.stdout.on('data', (data) => { out += data }); child.stderr.on('data', (data) => { err += data })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`Host exit ${code}: ${err.slice(-2000)} ${out.slice(-2000)}`)) })
  })
}
try {
  mkdirSync(work, { recursive: true })
  const config = join(home, 'mcp.json')
  writeFileSync(config, JSON.stringify({ mcpServers: { devspec: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer fixture-not-real' } } } }))
  // Normal manual permissions and NO grant for any DevSpec tool: whatever runs
  // without a prompt runs because the loaded skill allowed it.
  const result = await run(['-p', 'Handle the disposable DevSpec fixture message.', '--plugin-dir', root,
    '--strict-mcp-config', '--mcp-config', config, '--setting-sources', '', '--model', 'sonnet',
    '--permission-mode', 'manual', '--allowedTools', `Skill(${SKILL})`, '--output-format', 'json'])
  assert(result.includes('REMOTE-ALLOW-LIST-RUNTIME-PASS'), result.slice(-2000))
  assert.ok(results.al_skill && !results.al_skill.is_error, `the skill loaded: ${results.al_skill && resultText(results.al_skill).slice(0, 500)}`)
  const stalled = granted.filter((verb) => !called.includes(verb))
  assert.deepEqual(stalled, [], `granted by the skill but not run without a prompt: ${stalled.map((v) => `${v}: ${resultText(results[`al_${v}`] ?? {}).slice(0, 200)}`).join('; ')}`)
  assert.ok(!called.includes(UNGRANTED), `${UNGRANTED} is not granted, so it must not have run`)
  assert.equal(results[`al_${UNGRANTED}`]?.is_error, true, `${UNGRANTED} came back refused`)
  const version = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')).version
  console.log(JSON.stringify({ result: 'PASS', host: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(),
    pluginRoot: root, pluginVersion: version, grantedRanWithoutPrompt: granted.length, addImplementationNoteRan: called.includes('add_implementation_note'),
    ungrantedRefused: UNGRANTED, ungrantedRefusal: resultText(results[`al_${UNGRANTED}`]).slice(0, 200), paidInference: 0, liveDevspecRecords: 0, scriptedRequests: requests }))
} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(home, { recursive: true, force: true }) }
