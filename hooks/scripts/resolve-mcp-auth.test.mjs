#!/usr/bin/env node
/**
 * Where the plugin's own scripts get their DevSpec server and credential (item 47f0dbdf):
 * DEVSPEC_MCP_TOKEN for a machine with no browser, otherwise the plugin's browser sign-in
 * for its configured server. Nothing else is a source any more: not a project .mcp.json,
 * not ~/.claude.json, not a pasted plugin setting.
 * Run: node --test hooks/scripts/resolve-mcp-auth.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { loginState, saveLogin } from './auth-store.mjs'
import {
  configuredMcpUrl,
  connectionCredential,
  credentialMcpUrl,
  credentialNotice,
  credentialRecord,
  hasCredential,
  recordedIdentity,
  resolveDevspecMcpAuth,
} from './resolve-mcp-auth.mjs'
import { SignInEndedError } from './oauth.mjs'

const PROD = 'https://api.devspec.ai/api/mcp'
const STAGING = 'https://api.devspecstaging.com/api/mcp'
const LOCAL = 'http://localhost:3000/api/mcp'
const HOUR = 60 * 60 * 1000
const STAGING_SETTING = { CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: STAGING }

const realHome = process.env.HOME
let sandbox
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-resolve-'))
  process.env.HOME = sandbox
})
afterEach(() => {
  process.env.HOME = realHome
  fs.rmSync(sandbox, { recursive: true, force: true })
})

function signIn(endpoint, tag, issuedAt = Date.now()) {
  return saveLogin({
    endpoint,
    tokens: { accessToken: `oat_${tag}`, refreshToken: `rt_${tag}`, issuedAt, expiresAt: issuedAt + 24 * HOUR },
    issuer: 'https://issuer.test',
    tokenEndpoint: 'https://issuer.test/oauth/token',
    clientId: 'claude-client',
    resource: endpoint,
  })
}

describe('which server', () => {
  it("is the plugin's server setting, production by default", () => {
    assert.equal(configuredMcpUrl({}), PROD)
    assert.equal(configuredMcpUrl(STAGING_SETTING), STAGING)
    assert.equal(credentialMcpUrl(STAGING_SETTING), STAGING)
  })

  it('DEVSPEC_MCP_URL counts only as the environment token\'s pair', () => {
    assert.equal(credentialMcpUrl({ ...STAGING_SETTING, DEVSPEC_MCP_URL: LOCAL }), STAGING)
    assert.equal(credentialMcpUrl({ ...STAGING_SETTING, DEVSPEC_MCP_URL: LOCAL, DEVSPEC_MCP_TOKEN: 'dvs_env' }), LOCAL)
    assert.equal(credentialMcpUrl({ ...STAGING_SETTING, DEVSPEC_MCP_TOKEN: 'dvs_env' }), STAGING, 'the token goes to the configured server')
  })
})

describe('which credential', () => {
  it('is the browser sign-in for the configured server', async () => {
    await signIn(PROD, 'prod')
    await signIn(STAGING, 'staging')
    const auth = await resolveDevspecMcpAuth('/anywhere', { env: STAGING_SETTING })
    assert.equal(auth.ok, true)
    assert.equal(auth.token, 'oat_staging')
    assert.equal(auth.mcp_url, STAGING)
    assert.equal(auth.source, 'login')
    assert.match(auth.principal, /^[a-f0-9]{64}$/)
    assert.equal((await resolveDevspecMcpAuth('/anywhere', { env: {} })).token, 'oat_prod')
  })

  it('is DEVSPEC_MCP_TOKEN whenever it is set, over a sign-in', async () => {
    await signIn(STAGING, 'staging')
    const auth = await resolveDevspecMcpAuth('/anywhere', { env: { ...STAGING_SETTING, DEVSPEC_MCP_TOKEN: 'dvs_env' } })
    assert.equal(auth.token, 'dvs_env')
    assert.equal(auth.source, 'env')
    assert.equal(auth.mcp_url, STAGING)
  })

  it('never reads a token from a project .mcp.json, ~/.claude.json or the retired plugin setting', async () => {
    const project = path.join(sandbox, 'project')
    fs.mkdirSync(project)
    const server = { devspec: { type: 'http', url: STAGING, headers: { Authorization: 'Bearer dvs_project' } } }
    fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: server }))
    fs.writeFileSync(path.join(sandbox, '.claude.json'), JSON.stringify({ mcpServers: server, projects: { [project]: { mcpServers: server } } }))
    const auth = await resolveDevspecMcpAuth(project, {
      env: { CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_pasted', DEVSPEC_TOKEN: 'dvs_alias' },
    })
    assert.equal(auth.ok, false)
    assert.equal(auth.token, undefined)
    assert.equal(hasCredential({ CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN: 'dvs_pasted' }), false)
  })

  it('says plainly what to do when there is none, or the sign-in has ended', async () => {
    const none = await resolveDevspecMcpAuth('/anywhere', { env: STAGING_SETTING })
    assert.equal(none.ok, false)
    assert.equal(none.mcp_url, STAGING)
    assert.equal(none.error, 'Claude Code is not signed in to DevSpec (staging). Run /devspec:devspec.login to sign in through your browser.')

    await signIn(STAGING, 'old', Date.now() - 20 * HOUR)
    const ended = await resolveDevspecMcpAuth('/anywhere', { env: STAGING_SETTING, refresh: async () => { throw new SignInEndedError('x') } })
    assert.equal(ended.ok, false)
    assert.match(ended.error, /^Your DevSpec sign-in \(staging\) has ended, for example because Claude Code was disconnected on https:\/\/app\.devspecstaging\.com\/settings\/agents\. Run \/devspec:devspec\.login to sign in again\.$/)
    assert.equal(hasCredential(STAGING_SETTING), false)
  })
})

describe('a live connection keeps its own identity', () => {
  it('records which sign-in it was made with, never the sign-in\'s token', async () => {
    await signIn(STAGING, 'first')
    const auth = await resolveDevspecMcpAuth('/anywhere', { env: STAGING_SETTING })
    const record = credentialRecord(auth)
    assert.deepEqual(Object.keys(record).sort(), ['auth_source', 'mcp_url', 'principal', 'token'])
    assert.equal(record.auth_source, 'login')
    assert.equal(record.token, undefined)
    assert.equal(record.principal, auth.principal)
    assert.equal(recordedIdentity(record), auth.principal)

    const envRecord = credentialRecord({ ok: true, token: 'dvs_env', mcp_url: STAGING, source: 'env', principal: 'p' })
    assert.equal(envRecord.token, 'dvs_env', 'an environment token is kept exactly as before')
    assert.equal(recordedIdentity(envRecord), 'dvs_env')
  })

  it('gets the current token of that same sign-in each time, renewed past half its life', async () => {
    await signIn(STAGING, 'first', Date.now() - 13 * HOUR)
    const record = { ...credentialRecord(await resolveDevspecMcpAuth('/x', { env: STAGING_SETTING })) }
    const now = await connectionCredential(record, { refresh: async () => ({ accessToken: 'oat_renewed', refreshToken: 'rt_renewed', issuedAt: Date.now(), expiresAt: Date.now() + 24 * HOUR }) })
    assert.equal(now.ok, true)
    assert.equal(now.token, 'oat_renewed')
    assert.equal(now.mcp_url, STAGING)
    assert.equal(loginState(STAGING).login.accessToken, 'oat_renewed')
  })

  it('never switches to a different sign-in, and says why', async () => {
    await signIn(STAGING, 'first')
    const record = credentialRecord(await resolveDevspecMcpAuth('/x', { env: STAGING_SETTING }))
    await signIn(STAGING, 'someone-else')
    const now = await connectionCredential(record)
    assert.equal(now.ok, false)
    assert.equal(now.reason, 'identity_changed')
    assert.match(now.error, /different DevSpec sign-in/)
  })

  it('reports a sign-in that has gone, for the poller to stand down on', async () => {
    await signIn(STAGING, 'first')
    const record = credentialRecord(await resolveDevspecMcpAuth('/x', { env: STAGING_SETTING }))
    fs.rmSync(path.join(sandbox, '.devspec'), { recursive: true, force: true })
    const now = await connectionCredential(record)
    assert.equal(now.ok, false)
    assert.equal(now.reason, 'signed_out')
    assert.match(now.error, /not signed in to DevSpec \(staging\)/)
  })

  it('keeps an environment-token connection on the token it recorded', async () => {
    const now = await connectionCredential({ token: 'dvs_recorded', auth_source: 'env', mcp_url: LOCAL }, { env: {} })
    assert.deepEqual([now.ok, now.token, now.mcp_url], [true, 'dvs_recorded', LOCAL])
  })
})

describe('what session start says', () => {
  it('nothing while signed in', async () => {
    await signIn(PROD, 'prod')
    assert.equal(credentialNotice({}), null)
  })

  it('to sign in when there is no sign-in for the chosen server, even with one for another', async () => {
    await signIn(PROD, 'prod')
    assert.equal(
      credentialNotice(STAGING_SETTING),
      'Claude Code is not signed in to DevSpec (staging). Run /devspec:devspec.login to sign in through your browser.',
    )
  })

  it('that DEVSPEC_MCP_TOKEN takes precedence over a saved sign-in, and how to remove it', async () => {
    await signIn(PROD, 'prod')
    const notice = credentialNotice({ DEVSPEC_MCP_TOKEN: 'dvs_env' })
    assert.match(notice, /^DEVSPEC_MCP_TOKEN is set, so DevSpec's background features/)
    assert.match(notice, /unset DEVSPEC_MCP_TOKEN|Environment Variables/)
    assert.match(notice, /\/devspec:devspec\.logout/)
    assert.equal(credentialNotice({ DEVSPEC_MCP_TOKEN: 'dvs_env', ...STAGING_SETTING }), null, 'no sign-in for that server to override')
    assert.equal(credentialNotice({ DEVSPEC_MCP_TOKEN: 'dvs_env', DEVSPEC_MCP_URL: STAGING }), null, 'a token for another server overrides nothing')
  })
})
