#!/usr/bin/env node
/**
 * Unit tests for MCP token resolution order — focus on the host-token symmetry
 * fix (item 74b29c76): the poller must resolve the SAME bearer the host used for
 * register_connection, or every dispatch is rejected as "connection belongs to a
 * different token".
 * Run: node --test hooks/scripts/resolve-mcp-auth.test.mjs
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildTokensWarning,
  enumerateCredentialPairs,
  fingerprintToken,
  hostTokenFromEnv,
  proveCredentialPair,
  resolveDevspecMcpAuth,
} from './resolve-mcp-auth.mjs'

const PROD = 'https://api.devspec.ai/api/mcp'

describe('resolveDevspecMcpAuth token precedence (host symmetry, item 74b29c76)', () => {
  let tmp
  const saved = {}

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-mcp-auth-'))
    fs.writeFileSync(
      path.join(tmp, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          devspec: {
            url: 'https://api.devspecstaging.com/api/mcp',
            headers: { Authorization: 'Bearer from-mcp-json' },
          },
        },
      }),
    )
    // Neutralise ambient env overrides so precedence is deterministic on any machine.
    // The CLAUDE_PLUGIN_OPTION_* pairs matter too: the plugin exports its own userConfig
    // into the session (item bb97c9f6), so a developer pointed at staging otherwise sees
    // the host-token pair resolve to staging instead of the manifest default.
    for (const k of [
      'DEVSPEC_MCP_TOKEN',
      'DEVSPEC_TOKEN',
      'DEVSPEC_MCP_URL',
      'CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN',
      'CLAUDE_PLUGIN_OPTION_devspec_token',
      'CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL',
      'CLAUDE_PLUGIN_OPTION_devspec_mcp_url',
    ]) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('host token wins over the project .mcp.json walk', () => {
    const r = resolveDevspecMcpAuth(tmp, { hostToken: 'from-host' })
    assert.equal(r.ok, true)
    assert.equal(r.token, 'from-host')
    assert.equal(r.source, 'host')
    assert.equal(r.mcp_url, PROD, 'host token must not inherit the .mcp.json URL')
  })

  it('falls back to .mcp.json when no host token (backward compatible)', () => {
    const r = resolveDevspecMcpAuth(tmp, {})
    assert.equal(r.ok, true)
    assert.equal(r.token, 'from-mcp-json')
    assert.match(String(r.source), /\.mcp\.json$/)
  })

  it('a blank/whitespace host token is ignored (backward compatible)', () => {
    const r = resolveDevspecMcpAuth(tmp, { hostToken: '   ' })
    assert.equal(r.token, 'from-mcp-json')
  })

  /**
   * A caller that already holds an environment resolves against THAT one. The commit
   * provenance hook takes `env` for everything else it does, and credentials silently
   * reading the ambient process instead would make the same call answer differently
   * under test than in the field (item 6fa0241e).
   */
  it('resolves against an injected env instead of the ambient process', () => {
    const injected = { DEVSPEC_MCP_TOKEN: 'from-injected-env', DEVSPEC_MCP_URL: 'https://injected.invalid/api/mcp' }
    const r = resolveDevspecMcpAuth(tmp, { env: injected })
    assert.equal(r.ok, true)
    assert.equal(r.token, 'from-injected-env')
    assert.equal(r.mcp_url, 'https://injected.invalid/api/mcp')
    assert.equal(r.source, 'env')
  })

  it('an injected env without credentials does not borrow the ambient process', () => {
    process.env.DEVSPEC_MCP_TOKEN = 'ambient-should-not-leak'
    try {
      const r = resolveDevspecMcpAuth(tmp, { env: {} })
      assert.equal(r.token, 'from-mcp-json', 'the folder config, not the ambient env')
    } finally {
      delete process.env.DEVSPEC_MCP_TOKEN
    }
  })

  it('explicit DEVSPEC_MCP_TOKEN still overrides even a host token', () => {
    process.env.DEVSPEC_MCP_TOKEN = 'from-env'
    try {
      const r = resolveDevspecMcpAuth(tmp, { hostToken: 'from-host' })
      assert.equal(r.token, 'from-env')
      assert.equal(r.source, 'env')
    } finally {
      delete process.env.DEVSPEC_MCP_TOKEN
    }
  })
})

describe('hostTokenFromEnv', () => {
  it('reads the plugin userConfig token Claude Code exports', () => {
    assert.equal(hostTokenFromEnv({ CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'plug' }), 'plug')
    assert.equal(hostTokenFromEnv({ CLAUDE_PLUGIN_OPTION_devspec_token: 'plug2' }), 'plug2')
  })

  it('returns null where the plugin env is unset (dev-from-source / non-Claude plugins)', () => {
    assert.equal(hostTokenFromEnv({}), null)
  })

  it('trims and ignores blank', () => {
    assert.equal(hostTokenFromEnv({ CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: '  x ' }), 'x')
    assert.equal(hostTokenFromEnv({ CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: '   ' }), null)
  })
})

describe('credential pairs (item 8bb707fd — never cross-wire token and URL)', () => {
  let tmp
  const saved = {}

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-mcp-pairs-'))
    fs.writeFileSync(
      path.join(tmp, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          devspec: {
            url: 'https://api.devspecstaging.com/api/mcp',
            headers: { Authorization: 'Bearer dvs_project_staging' },
          },
        },
      }),
    )
    for (const k of ['DEVSPEC_MCP_TOKEN', 'DEVSPEC_TOKEN', 'DEVSPEC_MCP_URL']) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('enumerates plugin userConfig and .mcp.json as separate pairs', () => {
    const { pairs } = enumerateCredentialPairs(tmp, {
      env: { CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_plugin_prod' },
    })
    const plugin = pairs.find((p) => p.source === 'plugin_user_config')
    const project = pairs.find((p) => p.sourceLabel === 'project .mcp.json')
    assert.equal(plugin.token, 'dvs_plugin_prod')
    assert.equal(plugin.mcp_url, PROD)
    assert.equal(project.token, 'dvs_project_staging')
    assert.equal(project.mcp_url, 'https://api.devspecstaging.com/api/mcp')
  })

  it('plugin token does not inherit the .mcp.json URL', () => {
    const r = resolveDevspecMcpAuth(tmp, {
      env: { CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_plugin_prod' },
    })
    // Without hostToken, .mcp.json still wins (staging) — that pair is coherent.
    assert.equal(r.token, 'dvs_project_staging')
    assert.equal(r.mcp_url, 'https://api.devspecstaging.com/api/mcp')

    const host = resolveDevspecMcpAuth(tmp, {
      env: { CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_plugin_prod' },
      hostToken: 'dvs_plugin_prod',
    })
    assert.equal(host.token, 'dvs_plugin_prod')
    assert.equal(host.mcp_url, PROD)
  })

  it('env token uses env URL only — never the .mcp.json URL', () => {
    const r = resolveDevspecMcpAuth(tmp, {
      env: {
        DEVSPEC_MCP_TOKEN: 'dvs_env_only',
        DEVSPEC_MCP_URL: 'https://injected.invalid/api/mcp',
      },
    })
    assert.equal(r.token, 'dvs_env_only')
    assert.equal(r.mcp_url, 'https://injected.invalid/api/mcp')
  })

  it('warning names both sources with fingerprints and never the raw tokens', () => {
    const { pairs } = enumerateCredentialPairs(tmp, {
      env: { CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_plugin_prod' },
      hostToken: 'dvs_plugin_prod',
    })
    const warning = buildTokensWarning(pairs)
    assert.match(warning, /plugin userConfig/)
    assert.match(warning, /project \.mcp\.json/)
    assert.match(warning, /You → Connections/)
    assert.ok(warning.includes(fingerprintToken('dvs_plugin_prod')))
    assert.ok(warning.includes(fingerprintToken('dvs_project_staging')))
    assert.doesNotMatch(warning, /dvs_plugin_prod|dvs_project_staging/)
  })

  it('skips the probe when only one distinct token is reachable', async () => {
    let called = 0
    const proven = await proveCredentialPair(
      [{ source: 'env', sourceLabel: 'DEVSPEC_MCP_TOKEN', token: 'only', mcp_url: PROD }],
      {
        connectionId: 'conn-1',
        probe: async () => {
          called += 1
        },
      },
    )
    assert.equal(proven.pair.token, 'only')
    assert.equal(proven.probed, false)
    assert.equal(proven.warning, null)
    assert.equal(called, 0)
  })

  it('falls through a "belongs to a different token" probe to the next pair', async () => {
    const { pairs } = enumerateCredentialPairs(tmp, {
      env: { CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_plugin_prod' },
      hostToken: 'dvs_plugin_prod',
    })
    const seen = []
    const proven = await proveCredentialPair(pairs, {
      connectionId: 'conn-1',
      probe: async (pair) => {
        seen.push(pair.token)
        if (pair.token === 'dvs_plugin_prod') {
          throw new Error('This connection belongs to a different token')
        }
      },
    })
    assert.deepEqual(seen, ['dvs_plugin_prod', 'dvs_project_staging'])
    assert.equal(proven.pair.token, 'dvs_project_staging')
    assert.equal(proven.pair.mcp_url, 'https://api.devspecstaging.com/api/mcp')
    assert.equal(proven.probed, true)
    assert.match(proven.warning, /You → Connections/)
    assert.doesNotMatch(proven.warning, /dvs_plugin_prod|dvs_project_staging/)
  })

  it('refuses an unproven pick when two tokens exist and no probe is supplied', async () => {
    const { pairs } = enumerateCredentialPairs(tmp, {
      env: { CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_plugin_prod' },
      hostToken: 'dvs_plugin_prod',
    })
    const proven = await proveCredentialPair(pairs, { connectionId: 'conn-1' })
    assert.equal(proven.pair, null)
    assert.equal(proven.error, 'unproven')
    assert.match(proven.warning, /more than one DevSpec key/)
  })
})

describe('plugin userConfig URL (item 17f38cfa — one server, pointed once)', () => {
  const STAGING = 'https://api.devspecstaging.com/api/mcp'
  let empty

  before(() => {
    // A folder with NO .mcp.json — the customer shape, and the shape we move to
    // once the project override is deleted.
    empty = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-mcp-url-'))
  })

  after(() => {
    try {
      fs.rmSync(empty, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('defaults to production when the plugin URL is unset', () => {
    const r = resolveDevspecMcpAuth(empty, {
      env: { CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_plugin' },
    })
    assert.equal(r.token, 'dvs_plugin')
    assert.equal(r.mcp_url, PROD)
  })

  it('follows the plugin URL the host was configured with', () => {
    const r = resolveDevspecMcpAuth(empty, {
      env: {
        CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_plugin',
        CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: STAGING,
      },
    })
    assert.equal(r.token, 'dvs_plugin')
    assert.equal(r.mcp_url, STAGING)
  })

  it('accepts the lowercase env spelling, like the token does', () => {
    const r = resolveDevspecMcpAuth(empty, {
      env: {
        CLAUDE_PLUGIN_OPTION_devspec_token: 'dvs_plugin',
        CLAUDE_PLUGIN_OPTION_devspec_mcp_url: STAGING,
      },
    })
    assert.equal(r.mcp_url, STAGING)
  })

  it('keeps the host-token pair on the plugin URL, not production', () => {
    // The regression this guards: register_connection runs on the plugin server at
    // STAGING, so a poller that assumed production would heartbeat the wrong host.
    const r = resolveDevspecMcpAuth(empty, {
      env: {
        CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_plugin',
        CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: STAGING,
      },
      hostToken: 'dvs_plugin',
    })
    assert.equal(r.token, 'dvs_plugin')
    assert.equal(r.mcp_url, STAGING)
  })

  it('still refuses to lend the plugin URL to a .mcp.json token', () => {
    const withProject = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-mcp-url-proj-'))
    fs.writeFileSync(
      path.join(withProject, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          devspec: {
            url: 'https://other.example/api/mcp',
            headers: { Authorization: 'Bearer dvs_project' },
          },
        },
      }),
    )
    try {
      const { pairs } = enumerateCredentialPairs(withProject, {
        env: {
          CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_plugin',
          CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: STAGING,
        },
      })
      const plugin = pairs.find((p) => p.source === 'plugin_user_config')
      const project = pairs.find((p) => p.sourceLabel === 'project .mcp.json')
      assert.equal(plugin.mcp_url, STAGING)
      assert.equal(project.mcp_url, 'https://other.example/api/mcp')
    } finally {
      fs.rmSync(withProject, { recursive: true, force: true })
    }
  })
})
