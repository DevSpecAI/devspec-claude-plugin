#!/usr/bin/env node
/**
 * Sign Claude Code's DevSpec plugin in and out through the browser (item 47f0dbdf).
 *
 *   login            Start a browser sign-in for the plugin's DevSpec server: opens the
 *                    approval page, prints its link, and returns at once. A detached
 *                    helper process keeps a listener on 127.0.0.1 for up to ten minutes
 *                    and finishes the sign-in when the browser comes back to it.
 *   login --wait     Wait for that sign-in to finish and say how it went.
 *   login --code     For a machine the browser cannot reach (any SSH session uses it
 *                    by itself): prints the link; DevSpec's page then shows a code.
 *   login --complete '<code#state>'
 *                    Finish a --code sign-in with the code the person copied.
 *   logout           Sign out of the plugin's DevSpec server only.
 *   status           Which server, which credential, and whether it is signed in.
 *   session-start    SessionStart hook: say plainly when there is no usable sign-in.
 *
 * Why the browser sign-in is split in two: Claude Code runs a slash command's scripts
 * through its Bash tool, which has no stdin and shows a command's output only once the
 * command ends. A single blocking command would hide the link until it timed out, so
 * `login` hands the link back straight away and `login --wait` does the waiting.
 *
 * A sign-in is discovered, approved, verified and saved against ONE server — the
 * plugin's server setting — so a login can never land under another server. It is saved
 * only once DevSpec has accepted it (`verify_agent_connection`).
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { activeLogin, authDir, loginState, removeLogin, saveLogin, TOKEN_ENV_VAR } from './auth-store.mjs'
import { mcpToolsCall, readServerFailure, PLUGIN_HEADER, pluginHeaderValue } from './mcp-call.mjs'
import {
  beginCopyCodeSignIn,
  browserCanReachThisMachine,
  CLAUDE_CODE_CLIENT_IDS,
  clientIdFor,
  completeCopyCodeSignIn,
  discoverSignIn,
  openInBrowser,
  revokeRefreshToken,
  signInCodePageUrl,
  SIGN_IN_WAIT_MS,
  startLoopbackSignIn,
} from './oauth.mjs'
import { readPrivateJsonResult, STATE_OK, writePrivateJson } from './private-state.mjs'
import { configuredMcpUrl, credentialMcpUrl, credentialNotice, envToken } from './resolve-mcp-auth.mjs'
import {
  envTokenOverridesLoginNotice,
  LOGIN_COMMAND,
  loginRefusedForEnvTokenNotice,
  missingCredentialNotice,
  refusedCredentialMessage,
  serverLabel,
} from './sign-in-notices.mjs'
import { isEntryPoint } from './entry-point.mjs'

const THIS_SCRIPT = fileURLToPath(import.meta.url)

/** The one sign-in in progress on this machine, for this plugin: 0600, beside the login file. */
export function pendingSignInPath() {
  return path.join(authDir(), 'sign-in.json')
}

/** How long `login --wait` waits before handing back, inside the Bash tool's ten minutes. */
export const WAIT_LIMIT_MS = 9.5 * 60 * 1000
const WAIT_POLL_MS = 500

/** How long a session-start check may take, inside the hook's ten seconds. */
const SESSION_START_PROBE_MS = 3_000

export class LoginError extends Error {}

function readPending() {
  const read = readPrivateJsonResult(pendingSignInPath())
  return read.status === STATE_OK && read.value && typeof read.value === 'object' ? read.value : null
}

function writePending(value) {
  writePrivateJson(pendingSignInPath(), value)
}

function clearPending() {
  try {
    fs.rmSync(pendingSignInPath(), { force: true })
  } catch {
    /* already gone */
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/** Stop a browser sign-in this machine is still waiting on, if any: a new one replaces it. */
function cancelPending() {
  const pending = readPending()
  if (pending?.mode === 'browser' && !pending.result && pidAlive(pending.pid)) {
    try {
      process.kill(pending.pid, 'SIGTERM')
    } catch {
      /* gone */
    }
  }
  clearPending()
}

function failureText(err) {
  return err instanceof Error ? err.message : String(err)
}

/** Refuse while DEVSPEC_MCP_TOKEN is set: a sign-in now would be overridden at once. */
function refuseWhileEnvToken(env) {
  if (envToken(env)) throw new LoginError(loginRefusedForEnvTokenNotice())
}

/**
 * Confirm DevSpec accepts the new sign-in at the very server it was approved for, then
 * save it. Returns the success sentence.
 */
export async function verifyAndSave({ endpoint, discovery, clientId, tokens }, { call = mcpToolsCall } = {}) {
  let verified
  try {
    verified = await call({ mcpUrl: endpoint, token: tokens.accessToken, name: 'verify_agent_connection', arguments: {}, timeoutMs: 20_000 })
  } catch (err) {
    const refused = refusedCredentialMessage(err, { endpoint })
    throw new LoginError(
      refused ?? `DevSpec could not confirm the sign-in (${failureText(err)}). Nothing was saved. Run ${LOGIN_COMMAND} to try again.`,
    )
  }
  const who = typeof verified?.connected_as === 'string' && verified.connected_as.trim() ? verified.connected_as.trim() : null
  await saveLogin({
    endpoint,
    tokens,
    issuer: discovery.issuer,
    tokenEndpoint: discovery.tokenEndpoint,
    revocationEndpoint: discovery.revocationEndpoint,
    clientId,
    resource: discovery.resource,
    signedInAs: who ?? undefined,
  })
  return `Signed in to DevSpec (${serverLabel(endpoint)})${who ? ` as ${who}` : ''}. ` +
    'Start a new Claude Code session to use it everywhere. To use it in this session, open /mcp, choose ' +
    "devspec and Reconnect for Claude Code's DevSpec tools, and run /devspec:devspec.remote for remote control."
}

async function discover(endpoint, fetchImpl, clientIds) {
  try {
    const discovery = await discoverSignIn(endpoint, fetchImpl)
    return { discovery, clientId: clientIdFor(discovery.issuer, clientIds) }
  } catch (err) {
    throw new LoginError(`DevSpec sign-in is unavailable: ${failureText(err)}`)
  }
}

/**
 * Start a sign-in. Returns the lines to print. `deps` exists for the tests: `spawnListener`
 * starts the detached listener and resolves with its first report, `open` opens a browser.
 */
export async function startLogin({ env = process.env, code = false } = {}, deps = {}) {
  const { fetchImpl = fetch, open = openInBrowser, spawnListener = spawnBrowserListener, clientIds = CLAUDE_CODE_CLIENT_IDS } = deps
  refuseWhileEnvToken(env)
  const endpoint = configuredMcpUrl(env)
  const label = serverLabel(endpoint)
  const { discovery, clientId } = await discover(endpoint, fetchImpl, clientIds)
  cancelPending()

  if (code || !browserCanReachThisMachine(env)) {
    const flow = beginCopyCodeSignIn({ discovery, clientId, codePageUrl: signInCodePageUrl(endpoint) })
    writePending({
      mode: 'code',
      endpoint,
      discovery,
      clientId,
      state: flow.state,
      verifier: flow.verifier,
      redirectUri: flow.redirectUri,
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SIGN_IN_WAIT_MS).toISOString(),
    })
    if (browserCanReachThisMachine(env)) open(flow.url)
    return [
      `Sign in to DevSpec (${label}): open this link in a browser, approve, then copy the code the page shows.`,
      flow.url,
      'Paste the code here when you have it. The link works for 10 minutes.',
    ]
  }

  const report = await spawnListener({ endpoint, discovery, clientId })
  if (!report?.url) throw new LoginError(`DevSpec sign-in could not start: ${report?.error || 'the sign-in helper did not start'}.`)
  open(report.url)
  return [
    `Approve DevSpec (${label}) in your browser. If it did not open, open this link:`,
    report.url,
    `Waiting up to 10 minutes for the approval. On a machine your browser cannot reach, run ${LOGIN_COMMAND} --code instead.`,
  ]
}

/** Run this script's `browser-listener` detached and read the one line it reports. */
export function spawnBrowserListener({ endpoint, discovery, clientId }, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify({ endpoint, discovery, clientId })).toString('base64url')
    let child
    try {
      child = spawn(process.execPath, [THIS_SCRIPT, 'browser-listener', payload], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: process.env,
      })
    } catch (err) {
      resolve({ error: failureText(err) })
      return
    }
    let buffered = ''
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout?.removeAllListeners('data')
      child.stdout?.destroy()
      child.unref()
      resolve(value)
    }
    const timer = setTimeout(() => done({ error: 'the sign-in helper did not answer' }), timeoutMs)
    child.on('error', (err) => done({ error: failureText(err) }))
    child.on('exit', () => done({ error: 'the sign-in helper stopped' }))
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      const newline = buffered.indexOf('\n')
      if (newline < 0) return
      try {
        done(JSON.parse(buffered.slice(0, newline)))
      } catch {
        done({ error: 'the sign-in helper answered unreadably' })
      }
    })
  })
}

/**
 * The detached half of a browser sign-in: hold the loopback listener, then exchange,
 * verify and save, and record how it went for `login --wait`. Never prints a token.
 */
export async function runBrowserListener(payload, deps = {}) {
  const { fetchImpl = fetch, call = mcpToolsCall, report = (line) => process.stdout.write(`${line}\n`), waitMs } = deps
  const { endpoint, discovery, clientId } = payload
  let pending
  try {
    pending = await startLoopbackSignIn({ discovery, clientId, ...(waitMs ? { waitMs } : {}) }, fetchImpl)
  } catch (err) {
    report(JSON.stringify({ error: failureText(err) }))
    return { ok: false, message: failureText(err) }
  }
  const attempt = {
    mode: 'browser',
    endpoint,
    pid: process.pid,
    url: pending.url,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + (waitMs ?? SIGN_IN_WAIT_MS)).toISOString(),
  }
  writePending(attempt)
  report(JSON.stringify({ url: pending.url }))
  const stop = () => pending.cancel()
  process.once('SIGTERM', stop)
  let result
  try {
    const tokens = await pending.done
    result = { ok: true, message: await verifyAndSave({ endpoint, discovery, clientId, tokens }, { call }) }
  } catch (err) {
    result = { ok: false, message: `DevSpec sign-in did not finish: ${failureText(err)}` }
  } finally {
    process.removeListener('SIGTERM', stop)
  }
  // Record the outcome only for the attempt that is still current: a newer login replaced
  // this one and owns the file now.
  const current = readPending()
  if (current?.pid === process.pid && current?.mode === 'browser') {
    writePending({ ...attempt, result: { ...result, finishedAt: new Date().toISOString() } })
  }
  return result
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait for the browser sign-in `login` started. Returns `{ ok, message }`. */
export async function waitForLogin({ limitMs = WAIT_LIMIT_MS, pollMs = WAIT_POLL_MS } = {}) {
  const deadline = Date.now() + limitMs
  for (;;) {
    const pending = readPending()
    if (!pending || pending.mode !== 'browser') {
      return { ok: false, message: `No browser sign-in is waiting. Run ${LOGIN_COMMAND} to start one.` }
    }
    if (pending.result) {
      clearPending()
      return { ok: !!pending.result.ok, message: pending.result.message }
    }
    if (!pidAlive(pending.pid)) {
      clearPending()
      return { ok: false, message: `The sign-in stopped before it finished. Run ${LOGIN_COMMAND} to try again.` }
    }
    if (Date.now() >= deadline) {
      return { ok: false, waiting: true, message: `Still waiting for the approval in the browser. Run ${LOGIN_COMMAND} --wait to keep waiting, or ${LOGIN_COMMAND} to start again.` }
    }
    await sleep(pollMs)
  }
}

/** Finish a --code sign-in with what the person pasted. Returns the success sentence. */
export async function completeLogin(pasted, { env = process.env } = {}, deps = {}) {
  const { fetchImpl = fetch, call = mcpToolsCall } = deps
  refuseWhileEnvToken(env)
  const pending = readPending()
  if (!pending || pending.mode !== 'code') {
    throw new LoginError(`No sign-in is waiting for a code. Run ${LOGIN_COMMAND} --code to start one.`)
  }
  if (!(Date.parse(pending.expiresAt) > Date.now())) {
    clearPending()
    throw new LoginError(`That sign-in has expired. Run ${LOGIN_COMMAND} --code to start again.`)
  }
  // The server it was started for, even if the setting changed since: the code is only
  // good there, and a login is saved only under the server that approved it.
  let tokens
  try {
    tokens = await completeCopyCodeSignIn({
      discovery: pending.discovery,
      clientId: pending.clientId,
      pasted,
      state: pending.state,
      verifier: pending.verifier,
      redirectUri: pending.redirectUri,
    }, fetchImpl)
  } catch (err) {
    // A wrong paste keeps the sign-in open for a second try; a refused code does not.
    if (!/not from this sign-in/.test(failureText(err))) clearPending()
    throw new LoginError(`DevSpec sign-in failed: ${failureText(err)}`)
  }
  clearPending()
  return verifyAndSave({ endpoint: pending.endpoint, discovery: pending.discovery, clientId: pending.clientId, tokens }, { call })
}

/** Sign out of the plugin's server only. Returns the sentence to print. */
export async function logout({ env = process.env } = {}, { fetchImpl = fetch } = {}) {
  const endpoint = configuredMcpUrl(env)
  cancelPending()
  const removed = await removeLogin(endpoint)
  if (removed) {
    await revokeRefreshToken({
      revocationEndpoint: removed.revocationEndpoint,
      clientId: removed.clientId,
      refreshToken: removed.refreshToken,
    }, fetchImpl)
  }
  const label = serverLabel(endpoint)
  const said = removed
    ? `Signed out of DevSpec (${label}). Start a new session, or open /mcp and Reconnect devspec, so Claude Code's own DevSpec connection stops using it too.`
    : `Claude Code was not signed in to DevSpec (${label}).`
  return envToken(env) ? `${said} ${TOKEN_ENV_VAR} is still set, so the plugin keeps using that token.` : said
}

/** One status line, offline. */
export function status({ env = process.env } = {}) {
  const endpoint = configuredMcpUrl(env)
  const label = serverLabel(endpoint)
  const state = loginState(endpoint)
  if (envToken(env)) {
    const lines = [`DevSpec (${label}): using the token in ${TOKEN_ENV_VAR} · ${credentialMcpUrl(env)}`]
    if (state.kind !== 'none') lines.push(envTokenOverridesLoginNotice())
    return lines.join('\n')
  }
  if (state.kind === 'active') {
    return `DevSpec (${label}): signed in through the browser${state.login.signedInAs ? ` as ${state.login.signedInAs}` : ''} · ${endpoint}`
  }
  return missingCredentialNotice(state, endpoint)
}

/**
 * Ask the server whether it still accepts a saved sign-in, as cheaply as the endpoint
 * allows: an authenticated GET, which DevSpec answers 405 once the credential checks out
 * and 401 with its reason when it does not. Returns the plain sentence for a refusal, or
 * null (accepted, or no verdict — offline is not a sign-in problem).
 */
export async function probeSignIn(endpoint, token, { fetchImpl = fetch, timeoutMs = SESSION_START_PROBE_MS } = {}) {
  let response
  try {
    const header = pluginHeaderValue()
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json', ...(header ? { [PLUGIN_HEADER]: header } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return null
  }
  if (response.status !== 401) {
    response.body?.cancel?.().catch?.(() => {})
    return null
  }
  const text = await response.text().catch(() => '')
  const failure = Object.assign(new Error(`MCP HTTP 401: ${text.slice(0, 400)}`), readServerFailure(401, text))
  return refusedCredentialMessage(failure, { endpoint })
}

/**
 * SessionStart: the sentence to show, or null. Offline facts first (no sign-in, ended,
 * DEVSPEC_MCP_TOKEN overriding a sign-in); then, for an active sign-in, one quick check
 * that DevSpec still accepts it, so a disconnected tool is said at once rather than
 * found by a failing tool call.
 */
export async function sessionStartNotice({ env = process.env } = {}, deps = {}) {
  const offline = credentialNotice(env)
  if (offline || envToken(env)) return offline
  const endpoint = configuredMcpUrl(env)
  const active = await activeLogin(endpoint, { lockWaitMs: 2_000, refreshTimeoutMs: 3_000, ...(deps.refresh ? { refresh: deps.refresh } : {}) })
  if (!active) return missingCredentialNotice(loginState(endpoint), endpoint)
  return probeSignIn(endpoint, active.token, deps)
}

function parseArgs(argv) {
  const out = { verb: argv[0] ?? 'status', code: false, wait: false, complete: null, rest: [] }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--code') out.code = true
    else if (a === '--wait') out.wait = true
    else if (a === '--complete') out.complete = argv[++i] ?? ''
    else out.rest.push(a)
  }
  return out
}

function readHookPayload() {
  try {
    if (process.stdin.isTTY) return {}
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.verb === 'session-start') {
    // A hook: always exit 0, and say something only when there is something to fix.
    try {
      const payload = readHookPayload()
      if (payload?.source === 'compact') return 0
      const notice = await sessionStartNotice()
      if (notice) {
        process.stdout.write(`${JSON.stringify({
          systemMessage: `DevSpec: ${notice}`,
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `DevSpec sign-in: ${notice}` },
        })}\n`)
      }
    } catch {
      /* never block a session over this */
    }
    return 0
  }
  if (args.verb === 'browser-listener') {
    let payload
    try {
      payload = JSON.parse(Buffer.from(args.rest[0] ?? '', 'base64url').toString('utf8'))
    } catch {
      process.stdout.write(`${JSON.stringify({ error: 'bad sign-in request' })}\n`)
      return 1
    }
    const result = await runBrowserListener(payload)
    return result.ok ? 0 : 1
  }
  try {
    if (args.verb === 'login') {
      if (args.complete !== null) {
        process.stdout.write(`${await completeLogin(args.complete)}\n`)
        return 0
      }
      if (args.wait) {
        const result = await waitForLogin()
        process.stdout.write(`${result.message}\n`)
        return result.ok ? 0 : result.waiting ? 3 : 1
      }
      process.stdout.write(`${(await startLogin({ code: args.code })).join('\n')}\n`)
      return 0
    }
    if (args.verb === 'logout') {
      process.stdout.write(`${await logout()}\n`)
      return 0
    }
    if (args.verb === 'status') {
      process.stdout.write(`${status()}\n`)
      return 0
    }
    process.stderr.write('usage: devspec-login.mjs login [--code | --wait | --complete <code#state>] | logout | status\n')
    return 2
  } catch (err) {
    process.stdout.write(`${failureText(err)}\n`)
    return 1
  }
}

if (isEntryPoint(import.meta.url)) {
  const code = await main()
  // The detached listener has finished; nothing else should keep this process.
  process.exit(code)
}
