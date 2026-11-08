/**
 * The headersHelper that gives Claude Code's own DevSpec connection the plugin's browser
 * sign-in (item 47f0dbdf). Run here the way Claude Code 2.1.319 runs it: the command from
 * plugin.json through a shell, from the plugin root, with CLAUDE_CODE_MCP_SERVER_URL and
 * CLAUDE_PLUGIN_ROOT set and every credential-looking variable removed.
 * Run: node --test hooks/scripts/mcp-headers.test.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { startFakeDevspec } from './fixtures/fake-devspec-sign-in.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf8'))
const SERVER = MANIFEST.mcpServers.devspec
const HOUR = 60 * 60 * 1000
const STAGING = 'https://api.devspecstaging.com/api/mcp'
const QUERY = '?model_tools=heartbeat_connection,detach_connection'

let fake
let home
before(async () => {
  fake = await startFakeDevspec()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-headers-'))
})
after(async () => {
  await fake.close()
  fs.rmSync(home, { recursive: true, force: true })
})

function writeLogins(logins) {
  const dir = path.join(home, '.devspec', 'claude-code')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ version: 1, logins }), { mode: 0o600 })
}

function readLogins() {
  return JSON.parse(fs.readFileSync(path.join(home, '.devspec', 'claude-code', 'auth.json'), 'utf8')).logins
}

function login(resource, { access, refresh, issuedAt = Date.now(), endedAt } = {}) {
  return {
    accessToken: access,
    refreshToken: refresh,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + 24 * HOUR).toISOString(),
    issuer: fake.issuer,
    tokenEndpoint: `${fake.base}/oauth/token`,
    clientId: 'claude-client',
    resource,
    loginId: `login-${access}`,
    savedAt: new Date().toISOString(),
    ...(endedAt ? { endedAt } : {}),
  }
}

/** Run the manifest's helper command as Claude Code does, and parse what it prints. */
function runHelper(serverUrl, extraEnv = {}) {
  const command = SERVER.headersHelper.replaceAll('${CLAUDE_PLUGIN_ROOT}', ROOT)
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('sh', ['-c', command], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_PLUGIN_ROOT: ROOT,
        CLAUDE_CODE_MCP_SERVER_NAME: 'plugin:devspec:devspec',
        CLAUDE_CODE_MCP_SERVER_URL: serverUrl,
        ...extraEnv,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => {
      let headers = null
      try { headers = JSON.parse(stdout) } catch { /* reported by the assertion */ }
      resolve({ code, stdout, stderr, headers, ms: Date.now() - started })
    })
  })
}

const pluginHeader = `claude_code/${MANIFEST.version}`

describe("the manifest wires Claude Code's connection to the helper", () => {
  it('runs the plugin\'s own helper, and keeps the environment token as the fallback header', () => {
    assert.equal(SERVER.type, 'http')
    assert.equal(SERVER.headersHelper, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/mcp-headers.mjs"')
    // Claude Code hides DEVSPEC_MCP_TOKEN from a plugin's helper but expands it in static
    // headers; the helper's Authorization replaces this one whenever there is a sign-in.
    assert.equal(SERVER.headers.Authorization, 'Bearer ${DEVSPEC_MCP_TOKEN:-}')
    assert.equal(SERVER.headers['x-devspec-plugin'], pluginHeader)
    assert.doesNotMatch(JSON.stringify(MANIFEST), /devspec_token|user_config\.devspec_token/)
    assert.equal(MANIFEST.userConfig.devspec_token, undefined, 'installing asks for no token')
  })
})

describe('the helper', () => {
  it('sends the saved sign-in for the server Claude Code is connecting to, query and all', async () => {
    const prod = fake.mint('prod-not-used')
    const staging = fake.mint('fresh')
    writeLogins({
      [fake.mcpUrl]: login(fake.mcpUrl, { access: staging.accessToken, refresh: staging.refreshToken }),
      [STAGING]: login(STAGING, { access: prod.accessToken, refresh: prod.refreshToken }),
    })
    const run = await runHelper(`${fake.mcpUrl}${QUERY}`)
    assert.equal(run.code, 0, run.stderr)
    assert.deepEqual(run.headers, { 'x-devspec-plugin': pluginHeader, Authorization: `Bearer ${staging.accessToken}` })
    assert.equal(fake.refreshUses.length, 0, 'a fresh token is not renewed')
  })

  it('renews a token past half its life first, and saves the rotated key', async () => {
    const old = fake.mint('half-life')
    writeLogins({ [fake.mcpUrl]: login(fake.mcpUrl, { access: old.accessToken, refresh: old.refreshToken, issuedAt: Date.now() - 13 * HOUR }) })
    const run = await runHelper(`${fake.mcpUrl}${QUERY}`)
    assert.equal(run.code, 0, run.stderr)
    const saved = readLogins()[fake.mcpUrl]
    assert.notEqual(saved.accessToken, old.accessToken)
    assert.notEqual(saved.refreshToken, old.refreshToken)
    assert.equal(run.headers.Authorization, `Bearer ${saved.accessToken}`)
    assert.deepEqual(fake.refreshUses.slice(-1), [old.refreshToken])
  })

  it('with no sign-in for the server sends no Authorization, so the static header applies', async () => {
    writeLogins({ [STAGING]: login(STAGING, { access: 'oat_other_server', refresh: 'rt_other' }) })
    const run = await runHelper(`${fake.mcpUrl}${QUERY}`)
    assert.equal(run.code, 0, run.stderr)
    assert.deepEqual(run.headers, { 'x-devspec-plugin': pluginHeader })
    fs.rmSync(path.join(home, '.devspec'), { recursive: true, force: true })
    const empty = await runHelper(`${fake.mcpUrl}${QUERY}`)
    assert.deepEqual(empty.headers, { 'x-devspec-plugin': pluginHeader })
  })

  it('never offers a sign-in that has ended', async () => {
    writeLogins({ [fake.mcpUrl]: login(fake.mcpUrl, { access: 'oat_ended', refresh: 'rt_ended', endedAt: new Date().toISOString() }) })
    const run = await runHelper(`${fake.mcpUrl}${QUERY}`)
    assert.deepEqual(run.headers, { 'x-devspec-plugin': pluginHeader })
  })

  it('ends a sign-in whose renewal DevSpec refuses, and stops sending it', async () => {
    writeLogins({ [fake.mcpUrl]: login(fake.mcpUrl, { access: 'oat_spent', refresh: 'rt_already_spent', issuedAt: Date.now() - 20 * HOUR }) })
    const run = await runHelper(`${fake.mcpUrl}${QUERY}`)
    assert.equal(run.code, 0, run.stderr)
    assert.deepEqual(run.headers, { 'x-devspec-plugin': pluginHeader })
    assert.ok(readLogins()[fake.mcpUrl].endedAt)
  })

  it('does not wait on a renewal another process holds: it hands back the stored token in time', async () => {
    const held = fake.mint('held')
    writeLogins({ [fake.mcpUrl]: login(fake.mcpUrl, { access: held.accessToken, refresh: held.refreshToken, issuedAt: Date.now() - 20 * HOUR }) })
    const lock = path.join(home, '.devspec', 'claude-code', 'auth.json.lock')
    fs.writeFileSync(lock, String(process.pid))
    try {
      const run = await runHelper(`${fake.mcpUrl}${QUERY}`)
      assert.equal(run.code, 0, run.stderr)
      assert.equal(run.headers.Authorization, `Bearer ${held.accessToken}`)
      assert.ok(run.ms < 9_000, `took ${run.ms}ms; Claude Code gives up at 10s`)
    } finally {
      fs.rmSync(lock, { force: true })
    }
  })

  it('prints only the headers object, even with an unreadable server address', async () => {
    const run = await runHelper('not a url')
    assert.equal(run.code, 0)
    assert.deepEqual(run.headers, { 'x-devspec-plugin': pluginHeader })
  })
})
