/**
 * The plugin's login file (item 47f0dbdf): one entry per DevSpec server, owner-only,
 * renewed once past half its life under a lock that holds across processes, and ended
 * only when DevSpec refuses the renewal.
 * Run: node --test hooks/scripts/auth-store.test.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import {
  activeLogin,
  authDir,
  authFilePath,
  loginPrincipal,
  loginState,
  needsRenewal,
  principalOf,
  removeLogin,
  resolveCredential,
  saveLogin,
  setSignedInAs,
} from './auth-store.mjs'
import { SignInEndedError } from './oauth.mjs'
import { startFakeDevspec } from './fixtures/fake-devspec-sign-in.mjs'

const PROD = 'https://api.devspec.ai/api/mcp'
const STAGING = 'https://api.devspecstaging.com/api/mcp'
const HOUR = 60 * 60 * 1000
const AUTH_STORE = new URL('./auth-store.mjs', import.meta.url).href

const realHome = process.env.HOME
let sandbox
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-claude-auth-'))
  process.env.HOME = sandbox
})
afterEach(() => {
  process.env.HOME = realHome
  fs.rmSync(sandbox, { recursive: true, force: true })
})

function tokens(tag, issuedAt = Date.now(), lifeMs = 24 * HOUR) {
  return { accessToken: `oat_${tag}`, refreshToken: `rt_${tag}`, issuedAt, expiresAt: issuedAt + lifeMs }
}

function save(endpoint, tag, { issuedAt, lifeMs, tokenEndpoint = 'https://issuer.test/oauth/token' } = {}) {
  return saveLogin({
    endpoint,
    tokens: tokens(tag, issuedAt, lifeMs),
    issuer: 'https://issuer.test',
    tokenEndpoint,
    clientId: 'claude-client',
    resource: endpoint,
    signedInAs: 'Ada Lovelace',
  })
}

describe('the login file', () => {
  it('has no credential before anyone signs in, and a corrupt file reads as signed out', async () => {
    assert.equal(await resolveCredential({ env: {}, endpoint: PROD }), null)
    assert.deepEqual(loginState(PROD), { kind: 'none' })
    fs.mkdirSync(authDir(), { recursive: true })
    fs.writeFileSync(authFilePath(), '{ not json')
    assert.equal(await resolveCredential({ env: {}, endpoint: PROD }), null)
  })

  it('lives in its own place, owner-only, and is used for its own server', async () => {
    await save(PROD, 'prod')
    assert.equal(authFilePath(), path.join(sandbox, '.devspec', 'claude-code', 'auth.json'))
    assert.equal(fs.statSync(authFilePath()).mode & 0o777, 0o600)
    assert.equal(fs.statSync(authDir()).mode & 0o777, 0o700)
    const resolved = await resolveCredential({ env: {}, endpoint: PROD })
    assert.equal(resolved.token, 'oat_prod')
    assert.equal(resolved.source, 'login')
    assert.equal(fs.readdirSync(authDir()).filter((f) => f.endsWith('.tmp')).length, 0, 'written aside and renamed')
  })

  it('keeps staging and production side by side; the server setting picks, and switching back needs no new login', async () => {
    await save(PROD, 'prod')
    await save(STAGING, 'staging')
    assert.equal((await resolveCredential({ env: {}, endpoint: PROD })).token, 'oat_prod')
    assert.equal((await resolveCredential({ env: {}, endpoint: `${STAGING}?model_tools=heartbeat_connection` })).token, 'oat_staging')
    assert.equal((await resolveCredential({ env: {}, endpoint: PROD })).token, 'oat_prod')
  })

  it('never saves a login under a server other than the one that approved it', async () => {
    await assert.rejects(saveLogin({
      endpoint: PROD,
      tokens: tokens('x'),
      issuer: 'https://issuer.test',
      tokenEndpoint: 'https://issuer.test/oauth/token',
      clientId: 'claude-client',
      resource: STAGING,
    }), /only be saved for the server it was approved for/)
    assert.deepEqual(loginState(PROD), { kind: 'none' })
  })

  it('signing out removes only that server\'s login', async () => {
    await save(PROD, 'prod')
    await save(STAGING, 'staging')
    const removed = await removeLogin(STAGING)
    assert.equal(removed.refreshToken, 'rt_staging')
    assert.equal(loginState(STAGING).kind, 'none')
    assert.equal(loginState(PROD).kind, 'active')
    assert.equal(await removeLogin(STAGING), null)
  })

  it('records who DevSpec says a login acts as, for that login only', async () => {
    const login = await save(PROD, 'prod')
    await setSignedInAs(PROD, 'some-other-login', 'Mallory')
    assert.equal(loginState(PROD).login.signedInAs, 'Ada Lovelace')
    await setSignedInAs(PROD, login.loginId, 'Ada King')
    assert.equal(loginState(PROD).login.signedInAs, 'Ada King')
  })
})

describe('DEVSPEC_MCP_TOKEN', () => {
  it('wins over a saved login, for machines with no browser', async () => {
    await save(PROD, 'prod')
    const resolved = await resolveCredential({ env: { DEVSPEC_MCP_TOKEN: ' dvs_env ' }, endpoint: PROD })
    assert.equal(resolved.token, 'dvs_env')
    assert.equal(resolved.source, 'env')
  })

  it('keeps the fingerprint a pasted token always had; a login keeps one identity across renewals', async () => {
    assert.equal(principalOf({ token: 'dvs_env' }), createHash('sha256').update('dvs_env').digest('hex'))
    assert.equal((await resolveCredential({ env: { DEVSPEC_MCP_TOKEN: 'dvs_env' }, endpoint: PROD })).principal, principalOf({ token: 'dvs_env' }))

    await save(PROD, 'first', { issuedAt: Date.now() - 13 * HOUR })
    const before = await resolveCredential({ env: {}, endpoint: PROD, refresh: async () => tokens('second') })
    const again = await resolveCredential({ env: {}, endpoint: PROD })
    assert.equal(before.token, 'oat_second')
    assert.equal(again.token, 'oat_second')
    assert.match(principalOf(before), /^[a-f0-9]{64}$/)
    assert.equal(principalOf(before), principalOf(again))
    assert.equal(principalOf(before), loginPrincipal(loginState(PROD).login))
    assert.notEqual(principalOf(before), principalOf({ token: 'oat_second' }), 'not the token string')
  })
})

describe('renewal', () => {
  it('happens once a token is past half its life, never before', async () => {
    const life = { issuedAt: new Date(0).toISOString(), expiresAt: new Date(24 * HOUR).toISOString() }
    assert.equal(needsRenewal(life, 11 * HOUR), false)
    assert.equal(needsRenewal(life, 12 * HOUR), true)
    await save(PROD, 'fresh')
    let calls = 0
    const active = await activeLogin(PROD, { refresh: async () => { calls += 1; return tokens('unused') } })
    assert.equal(active.token, 'oat_fresh')
    assert.equal(calls, 0)
  })

  it('a renewal DevSpec refuses ends the login, and it is never offered again', async () => {
    await save(PROD, 'old', { issuedAt: Date.now() - 20 * HOUR })
    assert.equal(await activeLogin(PROD, { refresh: async () => { throw new SignInEndedError('ended') } }), null)
    const state = loginState(PROD)
    assert.equal(state.kind, 'ended')
    assert.ok(state.login.endedAt)
    assert.equal(await activeLogin(PROD, { refresh: async () => tokens('never') }), null)
  })

  it('a renewal that fails for a passing reason keeps the login and hands back the current token', async () => {
    await save(PROD, 'old', { issuedAt: Date.now() - 20 * HOUR })
    const active = await activeLogin(PROD, { refresh: async () => { throw new Error('offline') } })
    assert.equal(active.token, 'oat_old')
    assert.equal(loginState(PROD).kind, 'active')
  })

  it('an abandoned lock from a process that died does not block renewal', async () => {
    await save(PROD, 'old', { issuedAt: Date.now() - 20 * HOUR })
    fs.writeFileSync(`${authFilePath()}.lock`, '999999999')
    const active = await activeLogin(PROD, { refresh: async () => tokens('after-crash') })
    assert.equal(active.token, 'oat_after-crash')
    assert.equal(fs.existsSync(`${authFilePath()}.lock`), false)
  })

  it('a lock older than a minute is abandoned even if its pid is alive', async () => {
    await save(PROD, 'old', { issuedAt: Date.now() - 20 * HOUR })
    const lock = `${authFilePath()}.lock`
    fs.writeFileSync(lock, String(process.pid))
    const old = new Date(Date.now() - 2 * 60_000)
    fs.utimesSync(lock, old, old)
    assert.equal((await activeLogin(PROD, { refresh: async () => tokens('stale-lock') })).token, 'oat_stale-lock')
  })

  it('a caller with a deadline is not held by a live lock: it gets the token the file holds', async () => {
    await save(PROD, 'old', { issuedAt: Date.now() - 20 * HOUR })
    fs.writeFileSync(`${authFilePath()}.lock`, String(process.pid))
    let calls = 0
    const started = Date.now()
    const active = await activeLogin(PROD, { lockWaitMs: 100, refresh: async () => { calls += 1; return tokens('x') } })
    assert.equal(active.token, 'oat_old')
    assert.equal(calls, 0, 'never renews without the lock')
    assert.ok(Date.now() - started < 2_000)
    fs.rmSync(`${authFilePath()}.lock`, { force: true })
  })

  it('concurrent renewals in one process spend the single-use renewal key exactly once', async () => {
    await save(PROD, 'old', { issuedAt: Date.now() - 20 * HOUR })
    const spent = []
    const refresh = async (input) => {
      spent.push(input.refreshToken)
      await new Promise((resolve) => setTimeout(resolve, 50))
      return tokens(`renewed${spent.length}`)
    }
    const results = await Promise.all(Array.from({ length: 5 }, () => activeLogin(PROD, { refresh })))
    assert.deepEqual(spent, ['rt_old'])
    assert.deepEqual(new Set(results.map((r) => r.token)), new Set(['oat_renewed1']))
    assert.equal(loginState(PROD).login.refreshToken, 'rt_renewed1')
  })
})

describe('renewal across separate processes', () => {
  let fake
  before(async () => { fake = await startFakeDevspec({ refreshDelayMs: 150 }) })
  after(() => fake.close())

  function renewIn(home, endpoint) {
    const script = `const { activeLogin } = await import(${JSON.stringify(AUTH_STORE)}); ` +
      `const a = await activeLogin(${JSON.stringify(endpoint)}); process.stdout.write(a ? a.token : 'none')`
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
      })
      let out = ''
      child.stdout.on('data', (chunk) => { out += chunk })
      child.on('close', (code) => resolve({ code, out }))
    })
  }

  it('six Claude Code processes renewing at once spend the renewal key once and all get the same new token', async () => {
    const seeded = fake.mint('cross-process')
    const issuedAt = Date.now() - 20 * HOUR
    await saveLogin({
      endpoint: fake.mcpUrl,
      tokens: { ...seeded, issuedAt, expiresAt: issuedAt + 24 * HOUR },
      issuer: fake.issuer,
      tokenEndpoint: `${fake.base}/oauth/token`,
      clientId: 'claude-client',
      resource: fake.mcpUrl,
    })
    const results = await Promise.all(Array.from({ length: 6 }, () => renewIn(sandbox, fake.mcpUrl)))
    assert.ok(results.every((r) => r.code === 0), JSON.stringify(results))
    assert.deepEqual(fake.refreshUses.filter((t) => t === seeded.refreshToken), [seeded.refreshToken])
    assert.equal(fake.refreshUses.length, 1, 'nobody renewed twice')
    const handed = new Set(results.map((r) => r.out))
    assert.equal(handed.size, 1)
    assert.match([...handed][0], /^oat_/)
    assert.notEqual([...handed][0], seeded.accessToken)
    assert.equal(loginState(fake.mcpUrl).kind, 'active')
    assert.equal(fs.existsSync(`${authFilePath()}.lock`), false)
  })
})
