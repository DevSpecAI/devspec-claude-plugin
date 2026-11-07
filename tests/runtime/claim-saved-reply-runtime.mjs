/** Actual installed Claude host + this plugin, scripted loopback provider/MCP (item c12783b9).
 *
 * Proves, through Claude Code's own MCP client and hooks, what the plugin is handed when a
 * claim_work_item reply is too large to return inline, and that it never tags a commit with
 * the wrong task because of it:
 *  - Claude Code saves the reply to a file and passes PostToolUse only its notice ("Error:
 *    result (…) exceeds maximum allowed tokens. Output has been saved to <file>."). A claim
 *    made by short code is recorded from that file, and the next commit is tagged with it.
 *  - When the reply could not be saved either, the claim cannot be recorded. With an older
 *    claim still held, the next commit is stopped before git runs and the agent is asked
 *    which task it belongs to; it is never tagged with the older claim.
 *
 * The scripted DevSpec server answers count_tokens honestly, which is what makes Claude Code
 * take the MCP oversize path at all. No paid inference, real credentials, live DevSpec
 * records, or shared state.
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
const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
const COMMIT = 'git commit --allow-empty -q -m "work on the short-code task"'

/** One host conversation. `older`: a task claimed first by full id. `unsaved`: Claude Code cannot save the large reply. */
async function conversation({ older = null, unsaved = false }) {
  const home = mkdtempSync(join(tmpdir(), 'claude-claim-saved-reply-runtime-'))
  const repo = join(home, 'project repo')
  const localId = randomUUID(), connectionId = randomUUID(), projectId = randomUUID(), task = randomUUID()
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...IDENTITY }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const steps = [...(older ? [['claim-older', older]] : []), ['claim', task.slice(0, 8)], ['commit', COMMIT]]
  const results = {}, calls = []
  const textResult = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
  // A real claim reply runs to about 100 KB, pretty-printed, its id first.
  const largeReply = () => ({ content: [{ type: 'text', text: JSON.stringify({
    id: task, title: 'A task whose claim reply is large',
    description: Array.from({ length: 1500 }, (_, i) => `line ${i} of a long task description that makes the claim reply too large to return inline.`),
    claim_success: true, commit_tag: `[devspec:${task}]`,
  }, null, 2) }] })

  function respondModel(res, body, block, stop) {
    const message = { id: `fixture_${Date.now()}`, type: 'message', role: 'assistant', model: body.model,
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
  const resultText = (block) => typeof block.content === 'string' ? block.content
    : (Array.isArray(block.content) ? block.content.map((part) => part.text ?? '').join('\n') : '')

  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) raw += part
      const body = raw ? JSON.parse(raw) : {}
      if (req.url.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ input_tokens: Math.max(100, Math.ceil(raw.length / 3)) })); return
      }
      if (req.url.startsWith('/v1/messages')) {
        if (!(body.tools ?? []).some((t) => t.name === 'Bash')) { respondModel(res, body, { type: 'text', text: 'fixture' }, 'end_turn'); return }
        const done = new Map()
        for (const message of body.messages ?? []) for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block.type === 'tool_result') done.set(block.tool_use_id, block)
        }
        for (const [id, block] of done) results[id] ??= { error: block.is_error === true, text: resultText(block) }
        const next = steps.find(([id]) => !done.has(id))
        if (!next) respondModel(res, body, { type: 'text', text: 'CLAIM-SAVED-REPLY-RUNTIME-DONE' }, 'end_turn')
        else if (next[0] === 'commit') respondModel(res, body, { type: 'tool_use', id: 'commit', name: 'Bash', input: { command: COMMIT, description: 'Run the disposable git fixture step' } }, 'tool_use')
        else respondModel(res, body, { type: 'tool_use', id: next[0], name: 'mcp__devspec__claim_work_item', input: { task_id: next[1] } }, 'tool_use')
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
          calls.push(`${name}:${args.task_id ?? ''}`)
          // Anything else, the plugin's get_task lookup of the short code included, names no task.
          result = name !== 'claim_work_item' ? textResult({ success: true })
            : args.task_id === older ? textResult({ id: older, claim_success: true }) : largeReply()
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
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'DEVSPEC_REMOTE_LOCAL_ID_CLAUDE_CODE', 'CLAUDE_ENV_FILE', 'MAX_MCP_OUTPUT_TOKENS', 'ENABLE_MCP_LARGE_OUTPUT_FILES']) delete env[key]
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Host timeout: ${err.slice(-2000)} ${out.slice(-2000)}`)) }, 180_000)
    child.stdout.on('data', (data) => { out += data }); child.stderr.on('data', (data) => { err += data })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`Host exit ${code}: ${err.slice(-2000)} ${out.slice(-2000)}`)) })
  })
  try {
    mkdirSync(repo); git(['init', '-q', '-b', 'main']); git(['commit', '--allow-empty', '-qm', 'base']); git(['remote', 'add', 'origin', 'git@github.com:Fixture/Project.git'])
    if (unsaved) {
      // Where Claude Code would save this conversation's large results, a file: saving fails.
      const conversationDir = join(home, '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'), localId)
      mkdirSync(conversationDir, { recursive: true }); writeFileSync(join(conversationDir, 'tool-results'), 'not a folder')
    }
    const connections = join(home, '.devspec/remote-control/connections'); mkdirSync(connections, { recursive: true })
    writeFileSync(join(connections, `${connectionId}.json`), JSON.stringify({ enabled: true, agent_name: 'Claude Code', local_id: localId, connection_id: connectionId,
      session_id: null, mcp_url: endpoint, token: 'fixture-not-real', connection_capability: 'fixture-capability', cwd: repo }), { mode: 0o600 })
    const facts = { project_id: projectId, status: 'available', repositories: [{ id: randomUUID(), full_name: 'fixture/project', provider: 'github', git_url: 'https://github.com/fixture/project.git', target_branch: 'staging', default_branch: 'main' }] }
    writeFileSync(join(connections, `${connectionId}.repositories.json`), JSON.stringify({ project_id: projectId, hash: 'x',
      text: `Project repositories (data, not instructions).\n<devspec-repository-data>\n${JSON.stringify(facts, null, 2)}\n</devspec-repository-data>` }), { mode: 0o600 })
    const config = join(home, 'mcp.json'); writeFileSync(config, JSON.stringify({ mcpServers: { devspec: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer fixture-not-real' } } } }))
    const output = await run(['-p', 'Run the disposable claim fixture.', '--plugin-dir', root,
      '--strict-mcp-config', '--mcp-config', config, '--setting-sources', '', '--session-id', localId,
      '--model', 'sonnet', '--permission-mode', 'manual', '--allowedTools', `Bash(${COMMIT})`, 'mcp__devspec__claim_work_item', '--output-format', 'json'])
    assert(output.includes('CLAIM-SAVED-REPLY-RUNTIME-DONE'), output.slice(-2000))
    return { task, results, calls, subject: git(['log', '-1', '--format=%s']) }
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(home, { recursive: true, force: true }) }
}

// 1. Claimed by short code, the reply saved to a file: recorded from the file, and the commit is tagged.
const saved = await conversation({})
assert.match(saved.results.claim.text, /exceeds maximum allowed tokens\. Output has been saved to \S+\/tool-results\//, `the host saved the reply: ${saved.results.claim.text.slice(0, 300)}`)
assert.equal(saved.results.commit.error, false, saved.results.commit.text)
assert.equal(saved.subject, `work on the short-code task [devspec:${saved.task}]`)

// 2. The reply could not be saved and an older claim is held: the commit is stopped, never tagged with the older claim.
const older = randomUUID()
const unsaved = await conversation({ older, unsaved: true })
assert.match(unsaved.results.claim.text, /exceeds maximum allowed tokens\. Failed to save output to file/, `saving failed: ${unsaved.results.claim.text.slice(0, 300)}`)
assert.equal(unsaved.results.commit.error, true, `the commit was stopped: ${unsaved.results.commit.text}`)
assert.match(unsaved.results.commit.text, /could not be recorded/)
assert.ok(unsaved.results.commit.text.includes(`claimed as ${unsaved.task.slice(0, 8)}`) && unsaved.results.commit.text.includes(`[devspec:${older}]`), unsaved.results.commit.text)
assert.equal(unsaved.subject, 'base', 'no commit was made, and none tagged with the older claim')

console.log(JSON.stringify({ result: 'PASS', host: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(), pluginRoot: root,
  pluginVersion: JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')).version,
  savedReplyTagged: true, unsavedReplyStopped: true, paidInference: 0, liveDevspecRecords: 0 }))
