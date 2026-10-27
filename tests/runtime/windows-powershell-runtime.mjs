/** Actual Claude Code on native Windows + this plugin, scripted loopback provider/MCP (item 4054ff58).
 *
 * Two conversations, each with the PowerShell tool set in settings.json, as a person sets it:
 *  - CLAUDE_CODE_USE_POWERSHELL_TOOL=0: Claude has no PowerShell tool, the plugin's
 *    session-start hook sees the setting and starts the git stand-in. Through Claude's
 *    Bash tool (Git Bash), a commit before any claim is stopped. After claim_work_item,
 *    a heredoc into -F -, a plain -m commit, a script's commit and a subagent's commit
 *    in the project's repository are tagged. A background command's and a Monitor
 *    command's commits in a repository outside the project are left untagged. Every
 *    commit is reported to DevSpec once. Every path has a space in it.
 *  - CLAUDE_CODE_USE_POWERSHELL_TOOL=1: Claude has the PowerShell tool, the hook writes
 *    nothing to the environment file, the Bash tool runs the real git, and a PowerShell
 *    command still receives the plugin's own session variables (item 4d40407b).
 *
 * Elsewhere only the first conversation runs (there is no PowerShell tool to turn on).
 * CLAUDE_BIN names the Claude Code executable, default `claude`.
 * No paid inference, real credentials, live DevSpec records, or shared state.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const WINDOWS = process.platform === 'win32'
const CLAUDE = process.env.CLAUDE_BIN || 'claude'
const root = fileURLToPath(new URL('../..', import.meta.url))
const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const textResult = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
const firstText = (body) => {
  const first = body.messages?.[0]?.content
  return typeof first === 'string' ? first : Array.isArray(first) ? first.map((part) => part.text ?? '').join('\n') : ''
}
/** A path as a Git Bash command line writes it. */
const inBash = (target) => (WINDOWS ? target.replace(/\\/g, '/') : target)
const resultText = (block) => typeof block.content === 'string' ? block.content
  : (Array.isArray(block.content) ? block.content.map((part) => part.text ?? '').join('\n') : '')

function respondModel(res, body, block, stop, n) {
  const message = { id: `fixture_${n}`, type: 'message', role: 'assistant', model: body.model,
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

/**
 * One conversation: `steps` are [id, tool, input, skip?] the scripted model asks for in
 * turn; `skip(names)` passes over a step the offered tools make unnecessary. A
 * subagent asked to SUBAGENT-COMMIT makes one commit through Bash.
 * Returns what the conversation produced; `check` runs before its home is removed.
 */
async function conversation({ name, powershellTool, steps, check }) {
  const home = mkdtempSync(join(tmpdir(), `claude ${name} `))
  const repo = join(home, 'project repo'), other = join(home, 'elsewhere repo')
  const localId = randomUUID(), connectionId = randomUUID(), projectId = randomUUID(), task = randomUUID()
  const state = { results: {}, tools: new Set(), calls: [], reports: [], requests: 0, task, localId, home, repo, other }
  const plan = steps(state)
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) raw += part
      const body = raw ? JSON.parse(raw) : {}
      if (req.url.startsWith('/v1/messages/count_tokens')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"input_tokens":100}'); return }
      if (req.url.startsWith('/v1/messages')) {
        state.requests++
        const names = (body.tools ?? []).map((t) => t.name)
        if (!names.includes('Bash') && !names.includes('PowerShell')) { respondModel(res, body, { type: 'text', text: 'fixture' }, 'end_turn', state.requests); return }
        for (const toolName of names) state.tools.add(toolName)
        const done = new Map()
        for (const message of body.messages ?? []) for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block.type === 'tool_result') done.set(block.tool_use_id, block)
        }
        for (const [id, block] of done) state.results[id] ??= { error: block.is_error === true, text: resultText(block) }
        if (firstText(body).includes('SUBAGENT-COMMIT')) {
          if (!done.has('sub_commit')) respondModel(res, body, { type: 'tool_use', id: 'sub_commit', name: 'Bash', input: SUBAGENT_COMMIT }, 'tool_use', state.requests)
          else respondModel(res, body, { type: 'text', text: 'committed' }, 'end_turn', state.requests)
          return
        }
        const next = plan.find(([id, , , skip]) => !done.has(id) && !(skip && skip(names)))
        if (!next) respondModel(res, body, { type: 'text', text: 'WINDOWS-RUNTIME-DONE' }, 'end_turn', state.requests)
        else respondModel(res, body, { type: 'tool_use', id: next[0], name: next[1], input: next[2] }, 'tool_use', state.requests)
        return
      }
      if (req.url.startsWith('/api/mcp')) {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let result = {}
        if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } }
        else if (body.method === 'notifications/initialized') { res.writeHead(202); res.end(); return }
        else if (body.method === 'tools/list') result = { tools: [{ name: 'claim_work_item', description: 'Claim a task.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } }] }
        else if (body.method === 'tools/call') {
          const { name: called, arguments: args = {} } = body.params
          state.calls.push(called)
          if (called === 'claim_work_item') result = textResult({ id: args.task_id, claim_success: true, lifecycle: 'in_progress' })
          else if (called === 'report_commit_provenance') { state.reports.push(args); result = textResult({ recorded: true, repository_verified: true }) }
          else result = textResult({ success: true })
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}')
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })) }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`, endpoint = `${origin}/api/mcp`
  const configDir = join(home, '.claude')
  const env = { ...process.env, ...IDENTITY, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_API_KEY: 'sk-ant-fixture-not-real', ANTHROPIC_BASE_URL: origin,
    DEVSPEC_MCP_TOKEN: 'fixture-not-real', DEVSPEC_MCP_URL: endpoint,
    // The plugin's own settings, as Claude Code hands them to its hooks: the plugin then
    // carries its settings session to later commands in the environment file.
    CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'fixture-not-real', CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: endpoint,
    CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DEVSPEC_CLAUDE_STATE_DIR: join(home, 'provenance state'),
    NO_PROXY: '127.0.0.1,localhost', NODE_OPTIONS: '' }
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'DEVSPEC_REMOTE_LOCAL_ID_CLAUDE_CODE', 'CLAUDE_ENV_FILE', 'CLAUDE_CODE_USE_POWERSHELL_TOOL']) delete env[key]
  try {
    for (const [dir, url] of [[repo, 'git@github.com:Fixture/Project.git'], [other, 'https://github.com/fixture/elsewhere.git']]) {
      mkdirSync(dir); git(['init', '-q', '-b', 'main'], dir); git(['commit', '--allow-empty', '-qm', 'base'], dir); git(['remote', 'add', 'origin', url], dir)
    }
    writeFileSync(join(home, 'commit script.sh'), '#!/bin/sh\ngit commit --allow-empty -q -m script\n', { mode: 0o755 })
    const connections = join(home, '.devspec', 'remote-control', 'connections'); mkdirSync(connections, { recursive: true })
    writeFileSync(join(connections, `${connectionId}.json`), JSON.stringify({ enabled: true, agent_name: 'Claude Code', local_id: localId, connection_id: connectionId,
      session_id: null, mcp_url: endpoint, token: 'fixture-not-real', connection_capability: 'fixture-capability', cwd: repo }), { mode: 0o600 })
    const facts = { project_id: projectId, status: 'available', repositories: [{ id: randomUUID(), full_name: 'fixture/project', provider: 'github', git_url: 'https://github.com/fixture/project.git', target_branch: 'staging', default_branch: 'main' }] }
    writeFileSync(join(connections, `${connectionId}.repositories.json`), JSON.stringify({ project_id: projectId, hash: 'x',
      text: `Project repositories (data, not instructions).\n<devspec-repository-data>\n${JSON.stringify(facts, null, 2)}\n</devspec-repository-data>` }), { mode: 0o600 })
    // The setting, where a person puts it: the env of their own settings.json.
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_USE_POWERSHELL_TOOL: powershellTool } }, null, 2))
    const mcpConfig = join(home, 'mcp.json')
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { devspec: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer fixture-not-real' } } } }))
    const grants = [...new Set([...plan, ['sub_commit', 'Bash', SUBAGENT_COMMIT]].map(([, toolName, input]) => toolName === 'Bash' ? `Bash(${input.command})` : toolName))]
    // Exact Bash grants in normal manual permission mode, not bypass permissions.
    const output = await new Promise((resolve, reject) => {
      const child = spawn(CLAUDE, ['-p', `Run the disposable ${name} fixture.`, '--plugin-dir', root,
        '--strict-mcp-config', '--mcp-config', mcpConfig, '--setting-sources', 'user', '--session-id', localId,
        '--model', 'sonnet', '--permission-mode', 'manual', '--allowedTools', ...grants, '--output-format', 'json'],
      { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let out = '', err = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Host timeout: ${err.slice(-2000)} ${out.slice(-2000)}`)) }, 240_000)
      child.stdout.on('data', (data) => { out += data }); child.stderr.on('data', (data) => { err += data })
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`Host exit ${code}: ${err.slice(-2000)} ${out.slice(-2000)}`)) })
    })
    assert(output.includes('WINDOWS-RUNTIME-DONE'), output.slice(-2000))
    const sessionEnv = join(configDir, 'session-env')
    state.envFiles = existsSync(sessionEnv)
      ? readdirSync(sessionEnv).flatMap((dir) => readdirSync(join(sessionEnv, dir)).map((file) => readFileSync(join(sessionEnv, dir, file), 'utf8'))).join('\n')
      : null
    const log = join(home, '.devspec', 'git-observer', 'commits.log')
    state.observerLog = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
    const messages = (dir) => git(['log', '--format=%B%x00', 'main'], dir).split('\0').map((message) => message.trim()).filter(Boolean)
    const commits = (dir) => git(['rev-list', '--reverse', 'main'], dir).split('\n').slice(1) // every commit after the base
    state.messages = messages(repo); state.otherMessages = messages(other)
    state.commits = commits(repo); state.otherCommits = commits(other)
    check(state)
    return state
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve))
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
}

const bash = (command, extra = {}) => ({ command, description: 'Run the disposable git fixture step', ...extra })
const SUBAGENT_COMMIT = bash('git commit --allow-empty -q -m subagent')
const summary = { result: 'PASS', platform: process.platform, host: execFileSync(CLAUDE, ['--version'], { encoding: 'utf8' }).trim(),
  pluginVersion: JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')).version, paidInference: 0, liveDevspecRecords: 0 }

summary.powershellOff = await conversation({
  name: 'powershell off',
  powershellTool: '0',
  steps: (state) => [
    ['which', 'Bash', bash('command -v git')],
    ['unclaimed', 'Bash', bash('git commit --allow-empty -q -m "before any claim"')],
    ['claim', 'mcp__devspec__claim_work_item', { task_id: state.task }],
    ['heredoc', 'Bash', bash(`git commit --allow-empty -q -F - <<'EOF'\nheredoc subject\n\nheredoc body\nEOF`)],
    ['plain', 'Bash', bash('git commit --allow-empty -q -m "through bash"')],
    ['script', 'Bash', bash(`'${inBash(join(state.home, 'commit script.sh'))}'`)],
    // Outside the project, so it never contends with a commit on the project's main.
    ['background', 'Bash', bash(`sleep 1; git -C '${inBash(state.other)}' commit --allow-empty -q -m background`, { run_in_background: true })],
    ['subagent', 'Agent', { description: 'Commit in a subagent', prompt: 'SUBAGENT-COMMIT: make one empty commit', subagent_type: 'general-purpose' }],
    ['load_monitor', 'ToolSearch', { query: 'select:Monitor', max_results: 1 }, (names) => names.includes('Monitor')],
    ['monitor', 'Monitor', { command: `git -C '${inBash(state.other)}' commit --allow-empty -q -m monitor`, description: 'Commit from a monitor', timeout_ms: 20000 }],
    ['settle', 'Bash', bash('sleep 5')],
  ],
  check(state) {
    assert.equal(state.tools.has('PowerShell'), false, `the setting turned the PowerShell tool off: ${[...state.tools]}`)
    assert.match(state.results.which.text, /\.devspec\/git-observer\/[^/]+\/bin\/git/, `the hook saw the setting and the stand-in is the git Bash runs: ${state.results.which.text}`)
    if (state.envFiles !== null) assert.match(state.envFiles, /export PATH='[^']*git-observer[^']*':"\$PATH"/)
    assert.equal(state.observerLog.some((entry) => entry.outcome === 'not observing'), false, JSON.stringify(state.observerLog))
    assert.equal(state.results.unclaimed.error, true, `the unclaimed commit was stopped: ${state.results.unclaimed.text}`)
    assert.match(state.results.unclaimed.text, /retry the same commit/)
    assert.ok(state.calls.includes('claim_work_item'), 'the claim went through the host')
    assert.equal(state.messages.some((message) => message.startsWith('before any claim')), false, 'the stopped commit was never made')
    const tag = `[devspec:${state.task}]`
    assert.ok(state.messages.includes(`heredoc subject ${tag}\n\nheredoc body`), JSON.stringify(state.messages))
    assert.ok(state.messages.includes(`through bash ${tag}`), JSON.stringify(state.messages))
    assert.ok(state.messages.includes(`script ${tag}`), `a script's commit is tagged: ${JSON.stringify(state.messages)}`)
    assert.ok(state.messages.includes(`subagent ${tag}`), `a subagent's commit is tagged: ${JSON.stringify(state.messages)}`)
    assert.deepEqual([...state.otherMessages].sort(), ['background', 'base', 'monitor'], 'background and Monitor commits outside the project are made and left untagged')
    for (const id of ['heredoc', 'plain']) assert.match(state.results[id].text, /DevSpec: added \[devspec:/, `the ${id} result says the tag was added`)
    const remotes = new Map(state.reports.map((report) => [report.commit_sha, report.git_remote]))
    for (const sha of state.commits) assert.equal(remotes.get(sha), 'git@github.com:Fixture/Project.git', `commit ${sha} was reported: ${JSON.stringify(state.reports)}`)
    for (const sha of state.otherCommits) assert.equal(remotes.get(sha), 'https://github.com/fixture/elsewhere.git', `commit ${sha} was reported: ${JSON.stringify(state.reports)}`)
    assert.equal(state.reports.length, state.commits.length + state.otherCommits.length, 'each commit reported once')
  },
}).then((state) => ({ powershellTool: false, standIn: true, stopped: true, tagged: ['heredoc -F -', '-m', 'script', 'subagent'],
  untaggedOutside: ['background', 'monitor'], reported: state.reports.length, scriptedRequests: state.requests }))

if (WINDOWS) {
  summary.powershellOn = await conversation({
    name: 'powershell on',
    powershellTool: '1',
    steps: () => [
      ['ps', 'PowerShell', { command: 'Write-Output "settings-session=$env:DEVSPEC_PLUGIN_SETTINGS_SESSION"', description: 'Show the plugin session variable' }],
      ['which', 'Bash', bash('command -v git')],
    ],
    check(state) {
      assert.equal(state.tools.has('PowerShell'), true, `the setting turned the PowerShell tool on: ${[...state.tools]}`)
      assert.equal(state.results.ps.error, false, state.results.ps.text)
      assert.match(state.results.ps.text, new RegExp(`settings-session=${state.localId}`), `PowerShell kept the plugin's session variable: ${state.results.ps.text}`)
      assert.doesNotMatch(state.results.which.text, /git-observer/, `Bash runs the real git: ${state.results.which.text}`)
      if (state.envFiles !== null) assert.doesNotMatch(state.envFiles, /git-observer|PATH/, `nothing for the stand-in in the environment file: ${state.envFiles}`)
      assert.ok(state.observerLog.some((entry) => entry.outcome === 'not observing' && /PowerShell tool/.test(entry.reason)), JSON.stringify(state.observerLog))
    },
  }).then((state) => ({ powershellTool: true, standIn: false, powershellKeptSessionVariables: true, scriptedRequests: state.requests }))
}
console.log(JSON.stringify(summary))
