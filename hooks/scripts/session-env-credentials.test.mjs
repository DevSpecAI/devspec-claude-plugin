#!/usr/bin/env node
/**
 * Unit tests for carrying plugin userConfig into the session environment
 * (item bb97c9f6): Claude Code gives `CLAUDE_PLUGIN_OPTION_*` to hooks but not to
 * Bash tool calls, which is where every `commands/*.md` script actually runs.
 * Run: node --test hooks/scripts/session-env-credentials.test.mjs
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSessionEnvScript, writeSessionEnvCredentials } from './session-env-credentials.mjs'
import { enumerateCredentialPairs } from './resolve-mcp-auth.mjs'

const PROD = 'https://devspec.ai/api/mcp'
const STAGING = 'https://staging.devspec.ai/api/mcp'

describe('buildSessionEnvScript', () => {
  it('says nothing when no token is configured', () => {
    assert.equal(buildSessionEnvScript({}), null)
    assert.equal(buildSessionEnvScript({ CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: STAGING }), null)
  })

  it('treats a blank token as no token', () => {
    assert.equal(buildSessionEnvScript({ CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: '   ' }), null)
  })

  it('exports the configured pair', () => {
    const script = buildSessionEnvScript({
      CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_abc',
      CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: STAGING,
    })
    assert.match(script, /^export CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN='dvs_abc'$/m)
    assert.match(script, new RegExp(`^export CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL='${STAGING}'$`, 'm'))
  })

  it('never writes a token without a URL — the 8bb707fd pairing invariant', () => {
    // A token alone would silently pair against the production default downstream,
    // which is the cross-wiring this plugin has already removed twice.
    const script = buildSessionEnvScript({ CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_abc' })
    assert.match(script, /DEVSPEC_TOKEN='dvs_abc'/)
    assert.match(script, new RegExp(`DEVSPEC_MCP_URL='${PROD}'`))
  })

  it('accepts the lowercase spelling, as the resolver does', () => {
    const script = buildSessionEnvScript({
      CLAUDE_PLUGIN_OPTION_devspec_token: 'dvs_lower',
      CLAUDE_PLUGIN_OPTION_devspec_mcp_url: STAGING,
    })
    assert.match(script, /DEVSPEC_TOKEN='dvs_lower'/)
    assert.match(script, new RegExp(`DEVSPEC_MCP_URL='${STAGING}'`))
  })

  it('quotes a value that would otherwise break out of the shell', () => {
    // userConfig is arbitrary user input and this text reaches a shell.
    const script = buildSessionEnvScript({
      CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: `x'; touch /tmp/pwned; '`,
    })
    assert.ok(!script.includes('touch /tmp/pwned;\n'), 'injected command must stay inside quotes')
    assert.match(script, /^export CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN='x'\\''; touch \/tmp\/pwned; '\\'''$/m)
  })
})

describe('writeSessionEnvCredentials', () => {
  let dir

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-session-env-'))
  })

  after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('writes the script to CLAUDE_ENV_FILE', () => {
    const target = path.join(dir, 'sessionstart-hook-0.sh')
    const result = writeSessionEnvCredentials({
      env: {
        CLAUDE_ENV_FILE: target,
        CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_written',
        CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: STAGING,
      },
    })
    assert.deepEqual(result, { written: true, reason: 'ok' })
    const written = fs.readFileSync(target, 'utf8')
    assert.match(written, /DEVSPEC_TOKEN='dvs_written'/)
    assert.match(written, new RegExp(`DEVSPEC_MCP_URL='${STAGING}'`))
  })

  it('truncates rather than appending, so a resumed session does not stack exports', () => {
    const target = path.join(dir, 'sessionstart-hook-1.sh')
    const env = {
      CLAUDE_ENV_FILE: target,
      CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_once',
      CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: STAGING,
    }
    writeSessionEnvCredentials({ env })
    writeSessionEnvCredentials({ env })
    const lines = fs.readFileSync(target, 'utf8').split('\n').filter((l) => l.startsWith('export '))
    assert.equal(lines.length, 2)
  })

  it('does nothing, and does not throw, when Claude Code sets no CLAUDE_ENV_FILE', () => {
    // An older host, or a hook event that does not get one.
    const result = writeSessionEnvCredentials({
      env: { CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_abc' },
    })
    assert.deepEqual(result, { written: false, reason: 'no_env_file' })
  })

  it('does nothing when the plugin has no token configured', () => {
    const result = writeSessionEnvCredentials({
      env: { CLAUDE_ENV_FILE: path.join(dir, 'unused.sh') },
    })
    assert.deepEqual(result, { written: false, reason: 'no_token' })
    assert.equal(fs.existsSync(path.join(dir, 'unused.sh')), false)
  })

  it('degrades quietly when the path cannot be written', () => {
    const result = writeSessionEnvCredentials({
      env: {
        CLAUDE_ENV_FILE: path.join(dir, 'no-such-dir', 'hook.sh'),
        CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_abc',
      },
    })
    assert.deepEqual(result, { written: false, reason: 'write_failed' })
  })
})

describe('precedence is carried, not changed (the reason for these variable names)', () => {
  let projectDir

  before(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-session-env-proj-'))
    fs.writeFileSync(
      path.join(projectDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          devspec: {
            url: 'https://local.example/api/mcp',
            headers: { Authorization: 'Bearer dvs_project' },
          },
        },
      }),
    )
  })

  after(() => {
    try {
      fs.rmSync(projectDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it("a developer's project .mcp.json still outranks the plugin's own config", () => {
    // Exporting DEVSPEC_MCP_TOKEN would have made the plugin key source 1 and
    // inverted this. Re-exporting the CLAUDE_PLUGIN_OPTION_* names keeps the
    // plugin at source 6, exactly where the documented order puts it.
    const env = {}
    for (const line of buildSessionEnvScript({
      CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_plugin',
      CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: STAGING,
    }).split('\n')) {
      const m = line.match(/^export ([A-Za-z0-9_]+)='(.*)'$/)
      if (m) env[m[1]] = m[2]
    }

    const { pairs } = enumerateCredentialPairs(projectDir, { env })
    assert.equal(pairs[0].token, 'dvs_project')
    assert.equal(pairs[0].mcp_url, 'https://local.example/api/mcp')

    const plugin = pairs.find((p) => p.source === 'plugin_user_config')
    assert.equal(plugin.token, 'dvs_plugin')
    assert.equal(plugin.mcp_url, STAGING)
  })

  it('the plugin pair resolves on its own when nothing else is configured', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-session-env-empty-'))
    try {
      const { pairs } = enumerateCredentialPairs(empty, {
        env: {
          CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_plugin',
          CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: STAGING,
        },
      })
      assert.equal(pairs.length, 1)
      assert.equal(pairs[0].token, 'dvs_plugin')
      assert.equal(pairs[0].mcp_url, STAGING)
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })
})
