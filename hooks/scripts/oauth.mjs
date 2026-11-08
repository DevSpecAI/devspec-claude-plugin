/**
 * Browser sign-in for Claude Code's DevSpec plugin: OAuth 2.1 authorization code + PKCE
 * (item 47f0dbdf, brief d122804d).
 *
 * DevSpec's MCP endpoint names its authorization server (Clerk) in its protected-resource
 * metadata (RFC 9728). The plugin signs in through Claude Code's OWN pre-registered public
 * client at that server, so the approval page shows Claude Code and DevSpec's Agent setup
 * page lists it once (decisions 7f6b2262, 912b3b3e). Everything the plugin does, the host's
 * DevSpec connection included, uses that one login.
 *
 * The approval always comes back through the person's own browser (risk 65cc21b1):
 *   - normally to a short-lived listener on 127.0.0.1 (RFC 8252 loopback);
 *   - where the browser cannot reach this machine (SSH, a remote box), to DevSpec's own
 *     "copy this code" page, and the person pastes `code#state` back.
 * Nothing ever learns the result by polling a server, and the authorization code is
 * useless without the PKCE verifier that never leaves this machine.
 *
 * Ported from DevSpec's Pi plugin (extensions/core/oauth.ts). Each plugin owns its copy:
 * nothing here is imported from, or shared with, another plugin. Node built-ins only.
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

/** Scopes every DevSpec sign-in asks for: DevSpec access, plus renewal. */
export const SIGN_IN_SCOPE = 'devspec offline_access'

export const PRODUCTION_MCP_URL = 'https://api.devspec.ai/api/mcp'
export const STAGING_MCP_URL = 'https://api.devspecstaging.com/api/mcp'

/**
 * Claude Code's own sign-in app on each DevSpec Clerk instance, by issuer. A public client
 * id is an identifier, not a secret. Keyed by the authorization server rather than the
 * DevSpec address, so a local DevSpec on the Development instance signs in exactly like
 * staging does.
 */
export const CLAUDE_CODE_CLIENT_IDS = Object.freeze({
  'https://clerk.devspec.ai': 'fjxmjlWH4Nzq54hU',
  'https://apt-hare-75.clerk.accounts.dev': '0xLi8PElmOG3ndz0',
})

/**
 * How long an unanswered sign-in keeps its local listener open. The listener is a port on
 * this machine waiting for a browser, so it must close by itself; ten minutes matches how
 * long Clerk keeps an authorization request alive.
 */
export const SIGN_IN_WAIT_MS = 10 * 60 * 1000

/** One network round trip to DevSpec or Clerk during sign-in or renewal. */
export const SIGN_IN_REQUEST_TIMEOUT_MS = 15_000

export class SignInError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SignInError'
  }
}

/** The server refused to renew: the sign-in is over until the person signs in again. */
export class SignInEndedError extends SignInError {
  constructor(message) {
    super(message)
    this.name = 'SignInEndedError'
  }
}

/** Origin + path with no trailing slash, query or fragment: one key per DevSpec server. */
export function normalizeResource(url) {
  const parsed = new URL(String(url))
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
}

/** The normalized key, or null for anything that is not an http(s) URL. */
export function resourceKey(url) {
  try {
    const parsed = new URL(String(url))
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return normalizeResource(parsed.toString())
  } catch {
    return null
  }
}

/** "production", "staging", or the address itself for any other DevSpec. */
export function environmentLabel(endpoint) {
  const key = resourceKey(endpoint)
  if (key === PRODUCTION_MCP_URL) return 'production'
  if (key === STAGING_MCP_URL) return 'staging'
  try {
    return new URL(String(endpoint)).origin
  } catch {
    return String(endpoint)
  }
}

/** DevSpec's own "copy this code" page for the deployment an MCP URL belongs to. */
export function signInCodePageUrl(endpoint) {
  const key = resourceKey(endpoint)
  if (key === PRODUCTION_MCP_URL) return 'https://app.devspec.ai/oauth-code'
  if (key === STAGING_MCP_URL) return 'https://app.devspecstaging.com/oauth-code'
  return `${new URL(String(endpoint)).origin}/oauth-code`
}

async function getJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(SIGN_IN_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new SignInError(`${url} answered ${response.status}`)
  return response.json()
}

function stringField(value, key) {
  const field = value && typeof value === 'object' ? value[key] : undefined
  return typeof field === 'string' && field ? field : undefined
}

const trimSlash = (value) => value.replace(/\/+$/, '')

/**
 * Find where this DevSpec server sends people to sign in. Refuses a server that does not
 * offer browser sign-in, and metadata that names a different endpoint or server.
 */
export async function discoverSignIn(mcpUrl, fetchImpl = fetch) {
  const resource = normalizeResource(mcpUrl)
  const { origin, pathname } = new URL(resource)
  let metadata
  try {
    metadata = await getJson(`${origin}/.well-known/oauth-protected-resource${pathname}`, fetchImpl)
  } catch {
    throw new SignInError(`This DevSpec server (${origin}) does not offer browser sign-in yet.`)
  }
  const named = stringField(metadata, 'resource')
  if (named === undefined || resourceKey(named) !== resource) {
    throw new SignInError(`This DevSpec server's sign-in details are for a different address than ${resource}.`)
  }
  const servers = metadata?.authorization_servers
  const issuer = Array.isArray(servers) && typeof servers[0] === 'string' ? trimSlash(servers[0]) : undefined
  if (!issuer) throw new SignInError('This DevSpec server does not name where to sign in.')

  let server
  try {
    server = await getJson(`${issuer}/.well-known/oauth-authorization-server`, fetchImpl)
  } catch {
    throw new SignInError("DevSpec's sign-in server could not be reached. Check your connection and try again.")
  }
  if (trimSlash(stringField(server, 'issuer') ?? '') !== issuer) {
    throw new SignInError("DevSpec's sign-in server described itself as a different server.")
  }
  const authorizationEndpoint = stringField(server, 'authorization_endpoint')
  const tokenEndpoint = stringField(server, 'token_endpoint')
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new SignInError("DevSpec's sign-in server did not list its endpoints.")
  }
  return {
    resource: named,
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    revocationEndpoint: stringField(server, 'revocation_endpoint'),
  }
}

export function clientIdFor(issuer, ids = CLAUDE_CODE_CLIENT_IDS) {
  const clientId = ids[trimSlash(String(issuer ?? ''))]
  if (!clientId) {
    throw new SignInError(
      `This version of the DevSpec plugin does not know how to sign in to ${issuer}. ` +
        'Update the plugin (/plugin → Installed → DevSpec → Update), then try again.',
    )
  }
  return clientId
}

const base64url = (bytes) => Buffer.from(bytes).toString('base64url')

export function createPkce() {
  const verifier = base64url(randomBytes(32))
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) }
}

export function createState() {
  return base64url(randomBytes(24))
}

export function authorizationUrl({ discovery, clientId, redirectUri, state, challenge }) {
  const url = new URL(discovery.authorizationEndpoint)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SIGN_IN_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: discovery.resource,
  }).toString()
  return url.toString()
}

async function postToken(tokenEndpoint, body, fetchImpl, timeoutMs) {
  let response
  try {
    response = await fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(timeoutMs ?? SIGN_IN_REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw new SignInError(`DevSpec's sign-in server could not be reached (${err?.message || err}).`)
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const code = typeof payload?.error === 'string' ? payload.error : `status ${response.status}`
    // invalid_grant: the code or renewal key is spent, revoked or expired. The grant is
    // over; anything else may be transient and is worth trying again later.
    if (code === 'invalid_grant') throw new SignInEndedError('DevSpec ended this sign-in.')
    throw new SignInError(`DevSpec's sign-in server refused the request (${code}).`)
  }
  const accessToken = typeof payload?.access_token === 'string' ? payload.access_token : ''
  const refreshToken = typeof payload?.refresh_token === 'string' ? payload.refresh_token : ''
  const expiresIn = typeof payload?.expires_in === 'number' ? payload.expires_in : Number.NaN
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn)) {
    throw new SignInError("DevSpec's sign-in server answered without a complete sign-in.")
  }
  const issuedAt = Date.now()
  return { accessToken, refreshToken, issuedAt, expiresAt: issuedAt + expiresIn * 1000 }
}

export function exchangeCode({ discovery, clientId, code, redirectUri, verifier }, fetchImpl = fetch) {
  return postToken(discovery.tokenEndpoint, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
    resource: discovery.resource,
  }, fetchImpl)
}

/**
 * Renew a sign-in. Clerk rotates the renewal key on every use and treats a second use of
 * the same key as theft, ending the grant, so callers must hold the store lock
 * (auth-store.mjs) around this.
 */
export function refreshTokens({ tokenEndpoint, clientId, refreshToken, resource, timeoutMs }, fetchImpl = fetch) {
  return postToken(tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    resource,
  }, fetchImpl, timeoutMs)
}

/** Best effort: cancel the grant at Clerk when the person signs out. */
export async function revokeRefreshToken({ revocationEndpoint, clientId, refreshToken }, fetchImpl = fetch) {
  if (!revocationEndpoint || !refreshToken) return
  await fetchImpl(revocationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }).toString(),
    signal: AbortSignal.timeout(SIGN_IN_REQUEST_TIMEOUT_MS),
  }).catch(() => {})
}

/**
 * Open a URL in the default browser without a shell, so nothing in it is re-parsed.
 * Spawned detached and never awaited; a missing opener is ignored, because the URL is
 * always printed as well.
 */
export function openInBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const [cmd, args] = platform === 'darwin'
    ? ['open', [url]]
    : platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]]
  try {
    const child = spawnImpl(cmd, args, { stdio: 'ignore', detached: true })
    child.on?.('error', () => {})
    child.unref?.()
  } catch {
    /* the printed link is the fallback */
  }
}

/**
 * Whether a browser opened here can reach a listener on this machine. Over SSH the browser
 * runs on the person's own computer, where 127.0.0.1 is not us.
 */
export function browserCanReachThisMachine(env = process.env) {
  return !env.SSH_CONNECTION && !env.SSH_TTY && !env.SSH_CLIENT
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function logoUrlForResource(resource) {
  try {
    const u = new URL(resource)
    if (u.protocol === 'https:') {
      if (u.hostname.startsWith('api.')) u.hostname = `app.${u.hostname.slice(4)}`
      return `${u.origin}/logo-icon.png`
    }
  } catch {
    /* fall through */
  }
  return 'https://app.devspec.ai/logo-icon.png'
}

function page(title, body, logoUrl = 'https://app.devspec.ai/logo-icon.png') {
  const safeTitle = escapeHtml(title)
  const safeBody = escapeHtml(body)
  const safeLogo = escapeHtml(logoUrl)
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${safeTitle} — DevSpec</title>`,
    '<style>',
    ':root{color-scheme:light dark;--bg:#f9f7f2;--card:#fdfcfa;--fg:#18202c;--muted:#5c6573;--border:#e3dfd6;--primary:#2e548a;--shadow:0 1px 3px rgba(24,32,44,.06)}',
    '@media (prefers-color-scheme:dark){:root{--bg:#0c1017;--card:#141b26;--fg:#eae7df;--muted:#939ba8;--border:#232c3b;--primary:#7aa5e8;--shadow:0 2px 8px rgba(0,0,0,.35)}}',
    '*{box-sizing:border-box}',
    "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.5;background:var(--bg);color:var(--fg)}",
    'main{width:100%;max-width:28rem;background:var(--card);border:1px solid var(--border);border-radius:.75rem;padding:1.75rem;box-shadow:var(--shadow)}',
    '.brand{display:inline-flex;align-items:center;gap:.5rem;margin-bottom:1.25rem}',
    '.brand img{width:1.5rem;height:1.5rem;display:block}',
    '.brand span{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:.75rem;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--primary)}',
    'h1{font-size:1.125rem;font-weight:600;margin:0 0 .5rem;color:var(--fg)}',
    'p{font-size:.875rem;margin:0;color:var(--muted)}',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    `<div class="brand"><img src="${safeLogo}" alt="DevSpec" width="24" height="24"><span>DevSpec</span></div>`,
    `<h1>${safeTitle}</h1>`,
    `<p>${safeBody}</p>`,
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}

function reply(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

const LOGIN_AGAIN = 'Start again with /devspec:devspec.login in Claude Code.'

/**
 * Sign in through a loopback listener: open `url`, and the browser brings the approval
 * back to this process. `state` and the issuer echo (RFC 9207) are checked before the code
 * is exchanged.
 *
 * Returns `{ url, redirectUri, done, cancel }`; `done` settles with the new token set, or
 * rejects when canceled, refused or timed out.
 */
export async function startLoopbackSignIn({ discovery, clientId, waitMs = SIGN_IN_WAIT_MS }, fetchImpl = fetch) {
  const { verifier, challenge } = createPkce()
  const state = createState()
  let settle
  const done = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })
  // A canceled sign-in may have nobody listening for the result; never crash over it.
  done.catch(() => {})
  let finished = false
  let redirectUri = ''
  let timer

  const logoUrl = logoUrlForResource(discovery.resource)
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (requestUrl.pathname !== '/callback' || finished) {
      reply(res, 404, page('Not found', 'This address is only used to finish signing in to DevSpec.', logoUrl))
      return
    }
    const params = requestUrl.searchParams
    if (params.get('state') !== state) {
      // Not our request (or a replay): never exchange a code we did not ask for.
      reply(res, 400, page('Sign-in not recognized', `This sign-in was not started by this Claude Code. ${LOGIN_AGAIN}`, logoUrl))
      return
    }
    const iss = params.get('iss')
    if (iss !== null && trimSlash(iss) !== discovery.issuer) {
      reply(res, 400, page('Sign-in not recognized', `This sign-in came back from a different server. ${LOGIN_AGAIN}`, logoUrl))
      finish(new SignInError('The sign-in came back from a different server.'))
      return
    }
    const error = params.get('error')
    if (error) {
      reply(res, 200, page('Sign-in canceled', 'Nothing was connected. You can close this tab.', logoUrl))
      finish(new SignInError(error === 'access_denied' ? 'Sign-in was canceled in the browser.' : `Sign-in failed (${error}).`))
      return
    }
    const code = params.get('code')
    if (!code) {
      reply(res, 400, page('Sign-in incomplete', `The browser did not bring back a sign-in. ${LOGIN_AGAIN}`, logoUrl))
      return
    }
    finished = true
    exchangeCode({ discovery, clientId, code, redirectUri, verifier }, fetchImpl).then(
      (tokens) => {
        reply(res, 200, page('Signed in to DevSpec', 'You can close this tab and go back to Claude Code. Restart Claude Code to finish connecting.', logoUrl))
        finish(tokens)
      },
      (err) => {
        reply(res, 500, page('Sign-in failed', 'Claude Code could not finish signing in. Go back to Claude Code for details.', logoUrl))
        finish(err instanceof Error ? err : new SignInError(String(err)))
      },
    )
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  redirectUri = `http://127.0.0.1:${server.address().port}/callback`
  timer = setTimeout(
    () => finish(new SignInError('Sign-in timed out waiting for the browser. Run /devspec:devspec.login to try again.')),
    waitMs,
  )
  timer.unref?.()

  function finish(result) {
    finished = true
    clearTimeout(timer)
    server.close()
    server.closeAllConnections?.()
    if (result instanceof Error) settle.reject(result)
    else settle.resolve(result)
  }

  return {
    url: authorizationUrl({ discovery, clientId, redirectUri, state, challenge }),
    redirectUri,
    done,
    cancel: () => finish(new SignInError('Sign-in canceled.')),
  }
}

/**
 * Begin a sign-in where the browser cannot reach this machine: the approval returns to
 * DevSpec's own page (`codePageUrl`), which shows `code#state` for the person to paste
 * back. The verifier and state are returned so a later process can finish it
 * (`completeCopyCodeSignIn`): Claude Code runs each step as a separate command.
 */
export function beginCopyCodeSignIn({ discovery, clientId, codePageUrl }) {
  const { verifier, challenge } = createPkce()
  const state = createState()
  return {
    url: authorizationUrl({ discovery, clientId, redirectUri: codePageUrl, state, challenge }),
    state,
    verifier,
    redirectUri: codePageUrl,
  }
}

/** Split `code#state`, refusing anything whose state is not the one this sign-in made. */
export function parsePastedCode(pasted, expectedState) {
  const value = String(pasted ?? '').trim()
  const hash = value.lastIndexOf('#')
  const code = hash > 0 ? value.slice(0, hash) : ''
  if (!code || !expectedState || value.slice(hash + 1) !== expectedState) {
    throw new SignInError(
      'That code is not from this sign-in. Copy the whole code from the DevSpec page, or run /devspec:devspec.login again.',
    )
  }
  return code
}

export async function completeCopyCodeSignIn({ discovery, clientId, pasted, state, verifier, redirectUri }, fetchImpl = fetch) {
  const code = parsePastedCode(pasted, state)
  return exchangeCode({ discovery, clientId, code, redirectUri, verifier }, fetchImpl)
}
