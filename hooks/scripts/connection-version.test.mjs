import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LOADED_PLUGIN_VERSION, connectionVersionHook, versionedConnectionArguments } from './connection-version.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import { prepareDevspecToolInput } from './devspec-tool-input.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const version = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')).version

test('both manifests agree with the loaded reporter', () => {
  assert.equal(LOADED_PLUGIN_VERSION, version)
  assert.equal(JSON.parse(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8')).plugins[0].version, version)
})

test('internal register and attach wire requests use this artifact and never a guessed host', async () => {
  const fetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (_url, init) => {
    seen.push(JSON.parse(init.body).params)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    for (const name of ['register_connection', 'attach_connection']) await mcpToolsCall({ mcpUrl: 'https://fixture.example.test/api/mcp', token: 'fixture', name, arguments: { local_id: 'local', connection_id: 'c', session_id: 's', plugin_version: 'guess', host_version: 'guess' } })
    for (const request of seen) {
      assert.equal(request.arguments.plugin_version, version)
      assert.equal(request.arguments.host_version, undefined)
      assert.equal(request.arguments.connection_id, 'c')
    }
  } finally { globalThis.fetch = fetch }
})

test('unbound native MCP hook updates metadata without making any permission decision', () => {
  const hooks = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8')).hooks.PreToolUse
  const hook = hooks.find(entry => entry.hooks.some(value => value.command.includes('devspec-tool-input.mjs')))
  assert.ok(hook)
  for (const prefix of ['mcp__devspec__', 'mcp__plugin_devspec_devspec__']) {
    for (const name of ['register_connection', 'attach_connection']) {
      const tool_name = `${prefix}${name}`
      assert.match(tool_name, new RegExp(hook.matcher))
      const result = prepareDevspecToolInput({ tool_name, tool_input: { connection_id: 'c', session_id: 's', host_version: 'guess' } })
      assert.equal(result.hookSpecificOutput.updatedInput.plugin_version, version)
      assert.equal(result.hookSpecificOutput.updatedInput.connection_id, 'c')
      assert.equal(result.hookSpecificOutput.updatedInput.host_version, undefined)
      assert.equal(result.hookSpecificOutput.permissionDecision, undefined)
      assert.equal(result.decision, undefined)
      assert.equal(result.continue, undefined)
    }
  }
  assert.deepEqual(connectionVersionHook({ tool_name: 'mcp__foreign__register_connection', tool_input: {} }), {})
  const args = { command: 'unchanged' }
  assert.equal(versionedConnectionArguments('other_tool', args), args)
})

test('hook CLI and version-keyed cache artifact resolve the executing copy, not cwd', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'claude-version-artifact-'))
  try {
    const artifact = join(fixture, 'cache/devspec/1.2.3')
    mkdirSync(join(artifact, 'hooks/scripts'), { recursive: true })
    mkdirSync(join(artifact, '.claude-plugin'), { recursive: true })
    const manifest = join(artifact, '.claude-plugin/plugin.json')
    writeFileSync(manifest, JSON.stringify({ name: 'devspec', version: '1.2.3' }))
    const script = join(artifact, 'hooks/scripts/connection-version.mjs')
    writeFileSync(script, readFileSync(join(here, 'connection-version.mjs')))
    const output = JSON.parse(execFileSync(process.execPath, [script], { cwd: fixture, input: JSON.stringify({ tool_name: 'mcp__devspec__register_connection', tool_input: { local_id: 'local' } }), encoding: 'utf8' }))
    assert.equal(output.hookSpecificOutput.updatedInput.plugin_version, '1.2.3')
    const loaded = await import(pathToFileURL(script).href)
    writeFileSync(manifest, JSON.stringify({ name: 'devspec', version: '9.9.9' }))
    assert.equal(loaded.versionedConnectionArguments('attach_connection', {}).plugin_version, '1.2.3')
    assert.equal(execFileSync(process.execPath, [script], { input: 'not JSON', encoding: 'utf8' }), '')
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})
