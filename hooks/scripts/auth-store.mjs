/**
 * The Claude Code plugin's DevSpec login file (item 47f0dbdf).
 *
 * `~/.devspec/claude-code/auth.json` (file 0600, directory 0700) holds one browser sign-in
 * per DevSpec server, keyed by the server's MCP endpoint (origin + path, no query), so a
 * staging login and a production login sit side by side and switching servers never needs
 * a fresh login (decision 7f6b2262). Only this plugin reads or writes it: sign-in is once
 * per tool (decision 912b3b3e), and the Pi, Cursor and Antigravity plugins keep their own.
 *
 * Which server is used is never decided here. The plugin's server setting picks the
 * endpoint (resolve-mcp-auth.mjs), and a login is saved only under the server it was
 * discovered, approved and verified on.
 *
 * Renewal: Clerk rotates the renewal key on every use and ends the whole grant if one is
 * used twice. Claude Code runs many of this plugin's processes at once (the MCP header
 * helper, hooks, the listener, the poller), so every renewal holds an exclusive lock on
 * the file across processes and re-reads it after taking the lock: another process may
 * already have renewed. A token is renewed once it is past half its life, so any token
 * handed out still has at least half its life left.
 *
 * Ported from DevSpec's Pi plugin (extensions/core/auth-store.ts); nothing is shared with it.
 */

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { refreshTokens, resourceKey, SignInEndedError } from './oauth.mjs'

const STORE_VERSION = 1

/** The environment variable for machines with no browser (CI, cloud workers). It always wins. */
export const TOKEN_ENV_VAR = 'DEVSPEC_MCP_TOKEN'

/**
 * A lock older than this is abandoned. A holder only renews (one network round trip,
 * bounded by the request timeout) or writes the file, so a live holder always finishes
 * well inside it.
 */
export const LOCK_STALE_MS = 60_000
const LOCK_RETRY_MS = 50

export class LockTimeoutError extends Error {}

export function authDir() {
  return path.join(os.homedir(), '.devspec', 'claude-code')
}

export function authFilePath() {
  return path.join(authDir(), 'auth.json')
}

function lockPath() {
  return `${authFilePath()}.lock`
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * The stable, non-secret identity of a resolved credential (64 hex characters). A token
 * from the environment is fingerprinted by its value, so it is the same identity it always
 * was; a browser login by its server, sign-in app and login id, so it survives the access
 * token changing at every renewal. Caches, ownership checks and commit attribution compare
 * this, never the token string.
 */
export function principalOf(credential) {
  if (typeof credential?.principal === 'string' && credential.principal) return credential.principal
  return sha256(String(credential?.token ?? ''))
}

export function loginPrincipal(login) {
  return sha256(`devspec-claude-code-login\0${login.issuer}\0${login.clientId}\0${login.loginId}`)
}

/**
 * Renew once an access token is past half its life, so any token the plugin hands out
 * still has at least half its life left: a long-held poll or a retry never holds one that
 * is about to stop working.
 */
export function needsRenewal(login, now = Date.now()) {
  const issued = Date.parse(login?.issuedAt)
  const expires = Date.parse(login?.expiresAt)
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return true
  return now >= issued + (expires - issued) / 2
}

function isLogin(value) {
  return !!value && typeof value === 'object' &&
    typeof value.accessToken === 'string' && typeof value.refreshToken === 'string' &&
    typeof value.issuedAt === 'string' && typeof value.expiresAt === 'string' &&
    typeof value.issuer === 'string' && typeof value.tokenEndpoint === 'string' &&
    typeof value.clientId === 'string' && typeof value.resource === 'string' &&
    typeof value.loginId === 'string'
}

/** The whole store. A missing, unreadable or foreign file reads as signed out everywhere. */
export function readStore() {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(authFilePath(), 'utf8'))
  } catch {
    return { version: STORE_VERSION, logins: {} }
  }
  const logins = {}
  if (parsed && parsed.version === STORE_VERSION && parsed.logins && typeof parsed.logins === 'object') {
    for (const [key, value] of Object.entries(parsed.logins)) if (isLogin(value)) logins[key] = value
  }
  return { version: STORE_VERSION, logins }
}

function ensureDir() {
  fs.mkdirSync(authDir(), { recursive: true, mode: 0o700 })
  try {
    // mkdir's mode applies only when it creates the directory.
    fs.chmodSync(authDir(), 0o700)
  } catch {
    /* the file's own 0600 is what protects the login */
  }
}

/** Write aside and rename, so a reader never sees half a file and it never exists looser than 0600. */
function writeStore(store) {
  ensureDir()
  const temp = `${authFilePath()}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
    try {
      fs.chmodSync(temp, 0o600)
    } catch {
      /* POSIX modes do not apply on Windows; the profile folder's ACL does */
    }
    fs.renameSync(temp, authFilePath())
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      /* nothing to clean */
    }
    throw err
  }
}

/**
 * The lock's modification time when its holder is gone (crashed mid-renewal) or it is
 * older than any live holder could keep it; null while it is held.
 */
function staleLockStamp(now = Date.now()) {
  let info
  try {
    info = fs.statSync(lockPath())
  } catch {
    return null
  }
  if (now - info.mtimeMs > LOCK_STALE_MS) return info.mtimeMs
  let holder
  try {
    holder = Number.parseInt(fs.readFileSync(lockPath(), 'utf8'), 10)
  } catch {
    return null
  }
  if (!Number.isInteger(holder) || holder <= 0) return null
  try {
    process.kill(holder, 0)
    return null
  } catch (err) {
    return err?.code === 'ESRCH' ? info.mtimeMs : null
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run `work` holding the store's exclusive lock across processes. `waitMs` bounds how long
 * to wait for another holder (default: until the lock goes stale); past it,
 * LockTimeoutError is thrown and nothing was done.
 */
export async function withStoreLock(work, { waitMs = Infinity } = {}) {
  ensureDir()
  const deadline = Date.now() + waitMs
  for (;;) {
    let fd = null
    try {
      fd = fs.openSync(lockPath(), 'wx', 0o600)
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
    }
    if (fd !== null) {
      try {
        fs.writeSync(fd, String(process.pid))
      } finally {
        fs.closeSync(fd)
      }
      break
    }
    const stale = staleLockStamp()
    if (stale !== null) {
      // Clear it only if it is still the lock judged stale, not one a waiter beside us
      // has just taken.
      let current = null
      try {
        current = fs.statSync(lockPath()).mtimeMs
      } catch {
        /* already gone */
      }
      if (current === stale) fs.rmSync(lockPath(), { force: true })
      continue
    }
    if (Date.now() >= deadline) throw new LockTimeoutError('Another DevSpec process is renewing the sign-in.')
    await sleep(LOCK_RETRY_MS)
  }
  try {
    return await work()
  } finally {
    fs.rmSync(lockPath(), { force: true })
  }
}

/** What the store holds for one server: `none`, `active` or `ended`. */
export function loginState(endpoint) {
  const key = resourceKey(endpoint)
  const login = key ? readStore().logins[key] : undefined
  if (!login) return { kind: 'none' }
  return login.endedAt ? { kind: 'ended', login } : { kind: 'active', login }
}

/** Save a new sign-in under the server it was approved for, replacing only that server's. */
export async function saveLogin({
  endpoint,
  tokens,
  issuer,
  tokenEndpoint,
  revocationEndpoint,
  clientId,
  resource,
  signedInAs,
}) {
  const key = resourceKey(endpoint)
  if (!key || resourceKey(resource) !== key) {
    throw new Error('A sign-in can only be saved for the server it was approved for.')
  }
  const login = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    issuedAt: new Date(tokens.issuedAt).toISOString(),
    expiresAt: new Date(tokens.expiresAt).toISOString(),
    issuer,
    tokenEndpoint,
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
    clientId,
    resource,
    loginId: randomUUID(),
    ...(signedInAs ? { signedInAs } : {}),
    savedAt: new Date().toISOString(),
  }
  await withStoreLock(async () => {
    const store = readStore()
    store.logins[key] = login
    writeStore(store)
  })
  return login
}

/** Record who a saved login acts as, once DevSpec has said. */
export async function setSignedInAs(endpoint, loginId, signedInAs) {
  const key = resourceKey(endpoint)
  if (!key) return
  await withStoreLock(async () => {
    const store = readStore()
    const login = store.logins[key]
    if (!login || login.loginId !== loginId || login.signedInAs === signedInAs) return
    login.signedInAs = signedInAs
    writeStore(store)
  })
}

/** Remove the sign-in for one server only. Returns what was removed, if anything. */
export async function removeLogin(endpoint) {
  const key = resourceKey(endpoint)
  if (!key) return null
  return withStoreLock(async () => {
    const store = readStore()
    const login = store.logins[key] ?? null
    if (login) {
      delete store.logins[key]
      writeStore(store)
    }
    return login
  })
}

function handOut(login) {
  return { token: login.accessToken, login, principal: loginPrincipal(login) }
}

/**
 * The server's access token, renewed first once it is past half its life. Null when there
 * is no usable login (none saved, or it has ended).
 *
 * A renewal that fails for a passing reason (offline, a slow server, another process still
 * holding the lock past `lockWaitMs`) hands back the token it has: the next use either
 * works or reports the real problem. Only `invalid_grant` ends the login.
 */
export async function activeLogin(endpoint, {
  refresh = refreshTokens,
  lockWaitMs = Infinity,
  refreshTimeoutMs,
  now = () => Date.now(),
} = {}) {
  const key = resourceKey(endpoint)
  if (!key) return null
  const current = readStore().logins[key]
  if (!current || current.endedAt) return null
  if (!needsRenewal(current, now())) return handOut(current)
  try {
    return await withStoreLock(async () => {
      // Another process may have renewed while this one waited for the lock.
      const latest = readStore()
      const login = latest.logins[key]
      if (!login || login.endedAt) return null
      if (!needsRenewal(login, now())) return handOut(login)
      let tokens
      try {
        tokens = await refresh({
          tokenEndpoint: login.tokenEndpoint,
          clientId: login.clientId,
          refreshToken: login.refreshToken,
          resource: login.resource,
          ...(refreshTimeoutMs ? { timeoutMs: refreshTimeoutMs } : {}),
        })
      } catch (err) {
        if (err instanceof SignInEndedError) {
          login.endedAt = new Date().toISOString()
          writeStore(latest)
          return null
        }
        return handOut(login)
      }
      login.accessToken = tokens.accessToken
      login.refreshToken = tokens.refreshToken
      login.issuedAt = new Date(tokens.issuedAt).toISOString()
      login.expiresAt = new Date(tokens.expiresAt).toISOString()
      try {
        writeStore(latest)
      } catch {
        /* the renewed token still works for this use; the next renewal reports the rest */
      }
      return handOut(login)
    }, { waitMs: lockWaitMs })
  } catch (err) {
    if (err instanceof LockTimeoutError) return handOut(current)
    // An unwritable file must not cost the person a working token.
    return handOut(current)
  }
}

/**
 * The credential for one DevSpec server. `DEVSPEC_MCP_TOKEN` wins outright, so a machine
 * with no browser never depends on login state; otherwise the saved login for `endpoint`.
 * Returns `{ token, source: 'env'|'login', principal, login? }` or null.
 */
export async function resolveCredential({ env = process.env, endpoint, ...options } = {}) {
  const envToken = typeof env?.[TOKEN_ENV_VAR] === 'string' ? env[TOKEN_ENV_VAR].trim() : ''
  if (envToken) return { token: envToken, source: 'env', principal: sha256(envToken) }
  const active = await activeLogin(endpoint, options)
  if (!active) return null
  return { token: active.token, source: 'login', principal: active.principal, login: active.login }
}
