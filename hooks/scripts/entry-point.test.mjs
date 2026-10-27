#!/usr/bin/env node
/**
 * A hook script runs when Claude Code runs it, wherever the plugin is installed
 * (item c7e9e18a, entry-point.mjs). Run: node --test hooks/scripts/entry-point.test.mjs
 *
 * commit-observation.mjs decided whether it was the entry point by comparing its
 * module URL with a file URL built by hand. Under a folder with a space in its name
 * the two never matched, so it exited doing nothing, and no Claude Code commit was
 * reported from 15 October. Its unit tests call its functions directly and could
 * not see that. These run the scripts as Claude Code does.
 */
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'

const SELF = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SELF), '..', '..')
const run = (file, args, options) => new Promise((resolve) => {
  const child = execFile(process.execPath, [file, ...args], { encoding: 'utf8', ...options }, (error, stdout, stderr) =>
    resolve({ status: error ? error.code ?? 1 : 0, stdout, stderr }))
  if (options?.input !== undefined) child.stdin.end(options.input)
})

let sandbox
before(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-entry-point-')) })
after(() => fs.rmSync(sandbox, { recursive: true, force: true }))

describe('no script decides it is the entry point by a comparison that can miss', () => {
  // Each of these compares two spellings of one path that differ under a space, a
  // percent-encoded character or a symlink, and then fails silently.
  const FRAGILE = [
    [/`file:\/\/\$\{/, 'a file URL built by hand'],
    [/['"]file:\/\/['"]\s*\+/, 'a file URL built by hand'],
    [/import\.meta\.url\s*===|===\s*import\.meta\.url/, 'the module URL compared as a string'],
    [/(?:path\.resolve|pathToFileURL)\(\s*process\.argv\[1\]/, 'process.argv[1] compared without resolving symlinks'],
    [/process\.argv\[1\]\??\.endsWith\(/, 'a script recognised by the end of its name'],
  ]
  it('uses isEntryPoint (entry-point.mjs) or compares real paths', () => {
    const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', 'hooks'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0').filter((file) => /\.(?:mjs|cjs|js|ts)$/.test(file) && !/\.test\.(?:mjs|ts)$/.test(file))
    assert.ok(files.length > 40, `the scan found ${files.length} scripts; it is looking in the wrong place`)
    const found = []
    for (const file of files) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
      for (const [pattern, what] of FRAGILE) if (pattern.test(text)) found.push(`${file}: ${what}`)
    }
    assert.deepEqual(found, [])
  })
})

describe('isEntryPoint', () => {
  // A script that reports whether it is the entry point, and the same question
  // asked by a module it imports.
  let dir, link
  before(() => {
    dir = path.join(sandbox, 'folder with space & 100%')
    fs.mkdirSync(dir)
    const helper = pathToFileURL(path.join(ROOT, 'hooks/scripts/entry-point.mjs')).href
    fs.writeFileSync(path.join(dir, 'imported.mjs'), `import { isEntryPoint } from ${JSON.stringify(helper)}\nexport const imported = isEntryPoint(import.meta.url)\n`)
    fs.writeFileSync(path.join(dir, 'script.mjs'), `import { isEntryPoint } from ${JSON.stringify(helper)}\nimport { imported } from './imported.mjs'\nprocess.stdout.write(JSON.stringify({ main: isEntryPoint(import.meta.url), imported }))\n`)
    link = path.join(sandbox, 'linked plugin')
    fs.symlinkSync(dir, link)
  })

  for (const [name, at] of [['under a folder with a space and percent-encoded characters', () => dir], ['through a symlink', () => link]]) {
    it(`is true for the script Node ran, and only for it, ${name}`, async () => {
      const result = await run(path.join(at(), 'script.mjs'), [], { cwd: sandbox })
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), { main: true, imported: false })
    })
  }

  it('is false with no script, or one that does not exist', async () => {
    const { isEntryPoint } = await import('./entry-point.mjs')
    assert.equal(isEntryPoint(import.meta.url, ''), false)
    assert.equal(isEntryPoint(import.meta.url, path.join(sandbox, 'missing.mjs')), false)
    assert.equal(isEntryPoint('not a url', SELF), false)
  })
})

describe('commit-observation.mjs installed under a folder with a space', () => {
  const PROJECT = '22222222-2222-4222-8222-222222222222'
  const CONNECTION = '11111111-1111-4111-8111-111111111111'
  const SESSION = 'entry-point-conversation'
  let plugin, home, repo, server, reports

  before(async () => {
    // The plugin as Claude Code runs it from a checkout like Ali's.
    plugin = path.join(sandbox, 'DevSpec Autopilot Plugin', 'claude-code-devspec-autopilot')
    fs.cpSync(path.join(ROOT, 'hooks'), path.join(plugin, 'hooks'), { recursive: true })
    fs.cpSync(path.join(ROOT, '.claude-plugin'), path.join(plugin, '.claude-plugin'), { recursive: true })
    reports = []
    server = createServer(async (req, res) => {
      let raw = ''
      for await (const part of req) raw += part
      const body = raw ? JSON.parse(raw) : {}
      let result = {}
      if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } }
      else if (body.method === 'notifications/initialized') { res.writeHead(202); res.end(); return }
      else if (body.method === 'tools/call') {
        if (body.params.name === 'report_commit_provenance') reports.push(body.params.arguments)
        result = { content: [{ type: 'text', text: JSON.stringify({ recorded: true }) }] }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    home = path.join(sandbox, 'home')
    const connections = path.join(home, '.devspec', 'remote-control', 'connections')
    fs.mkdirSync(connections, { recursive: true })
    fs.writeFileSync(path.join(connections, `${CONNECTION}.json`), JSON.stringify({
      enabled: true, local_id: SESSION, connection_id: CONNECTION, session_id: null,
      mcp_url: `http://127.0.0.1:${server.address().port}/api/mcp`, token: 'fixture-not-real', connection_capability: 'fixture-capability',
    }), { mode: 0o600 })
    repo = path.join(sandbox, 'repo')
    fs.mkdirSync(path.join(repo, '.devspec'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.devspec', 'project.json'), JSON.stringify({ project_id: PROJECT }))
    for (const args of [['init', '-q'], ['config', 'user.email', 'fixture@example.invalid'], ['config', 'user.name', 'Fixture'], ['commit', '--allow-empty', '-qm', 'base']]) {
      execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    }
  })
  after(() => { server?.closeAllConnections(); server?.close() })

  it('reports the commit the agent made', async () => {
    const hook = path.join(plugin, 'hooks', 'scripts', 'commit-observation.mjs')
    const env = { PATH: process.env.PATH, HOME: home, DEVSPEC_CLAUDE_STATE_DIR: path.join(sandbox, 'state') }
    const command = "git commit --allow-empty -q -m 'made by the agent'"
    const input = { session_id: SESSION, tool_use_id: 'tool-1', cwd: repo, tool_input: { command } }
    const pre = await run(hook, ['pre'], { cwd: repo, env, input: JSON.stringify(input) })
    assert.equal(pre.status, 0, pre.stderr)
    execFileSync('sh', ['-c', command], { cwd: repo, env, stdio: 'ignore' })
    const post = await run(hook, ['post'], { cwd: repo, env, input: JSON.stringify({ ...input, tool_response: { stdout: '', stderr: '', exit_code: 0 } }) })
    assert.equal(post.status, 0, post.stderr)
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    assert.deepEqual(reports.map((report) => [report.commit_sha, report.connection_id, report.pinned_project_id]), [[head, CONNECTION, PROJECT]])
  })
})
