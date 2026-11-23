/**
 * A local stand-in for DevSpec AND its sign-in server (Clerk), for the browser sign-in
 * tests (item 47f0dbdf). One HTTP server plays:
 *
 *   - DevSpec's protected-resource metadata (RFC 9728) for `<base>/api/mcp`;
 *   - the authorization server's metadata, authorize page, token and revocation
 *     endpoints. The authorize page acts as a person pressing Allow (or Deny with
 *     `?deny=1` appended): it mints a code bound to the PKCE challenge and redirect, and
 *     redirects the "browser" back with `code`, `state` and `iss`. The token endpoint
 *     pays out only when the verifier matches the challenge, and rotates renewal keys
 *     single-use, exactly like Clerk: a spent key is `invalid_grant`;
 *   - DevSpec's own copy-a-code page (`/oauth-code`), which shows `code#state`;
 *   - DevSpec's MCP endpoint: GET answers 405 once the credential checks out, POST runs
 *     `verify_agent_connection`, and a refused credential gets DevSpec's 401 bodies.
 *
 * Not a test file: imported by them.
 */

import { createHash } from 'node:crypto'
import http from 'node:http'

export async function startFakeDevspec({ connectedAs = 'Ada Lovelace', refreshDelayMs = 0, expiresIn = 86400 } = {}) {
  let base = ''
  let counter = 0
  const codes = new Map()
  const accessTokens = new Set()
  const refreshTokens = new Set()
  const fake = {
    signedOut: new Set(),
    refreshUses: [],
    revoked: [],
    verifications: [],
    probes: [],
    tokenRequests: [],
    metadataResource: null,
    get base() { return base },
    get mcpUrl() { return `${base}/api/mcp` },
    get issuer() { return base },
    /** Mint a valid access + renewal key pair directly, as if signed in earlier. */
    mint(tag = `seed${++counter}`) {
      const tokens = { accessToken: `oat_${tag}`, refreshToken: `rt_${tag}` }
      accessTokens.add(tokens.accessToken)
      refreshTokens.add(tokens.refreshToken)
      return tokens
    },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  const readBody = (req) => new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => resolve(raw))
  })
  const issue = () => {
    counter += 1
    const tokens = { access_token: `oat_${counter}`, refresh_token: `rt_${counter}`, expires_in: expiresIn, token_type: 'bearer' }
    accessTokens.add(tokens.access_token)
    refreshTokens.add(tokens.refresh_token)
    return tokens
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base)
    if (url.pathname === '/.well-known/oauth-protected-resource/api/mcp') {
      return json(res, 200, {
        resource: fake.metadataResource ?? `${base}/api/mcp`,
        authorization_servers: [base],
        scopes_supported: ['devspec', 'offline_access'],
      })
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        revocation_endpoint: `${base}/oauth/revoke`,
      })
    }
    if (url.pathname === '/oauth/authorize') {
      const back = new URL(url.searchParams.get('redirect_uri'))
      back.searchParams.set('state', url.searchParams.get('state') ?? '')
      back.searchParams.set('iss', base)
      if (url.searchParams.get('deny') === '1') {
        back.searchParams.set('error', 'access_denied')
      } else {
        const code = `code_${++counter}`
        codes.set(code, {
          challenge: url.searchParams.get('code_challenge'),
          redirectUri: url.searchParams.get('redirect_uri'),
          clientId: url.searchParams.get('client_id'),
          resource: url.searchParams.get('resource'),
        })
        back.searchParams.set('code', code)
      }
      res.writeHead(302, { location: back.toString() })
      return res.end()
    }
    if (url.pathname === '/oauth-code') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end(`${url.searchParams.get('code')}#${url.searchParams.get('state')}`)
    }
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      const body = Object.fromEntries(new URLSearchParams(await readBody(req)))
      fake.tokenRequests.push(body)
      if (body.grant_type === 'refresh_token') {
        fake.refreshUses.push(body.refresh_token)
        if (refreshDelayMs) await new Promise((resolve) => setTimeout(resolve, refreshDelayMs))
        if (!refreshTokens.has(body.refresh_token)) return json(res, 400, { error: 'invalid_grant' })
        refreshTokens.delete(body.refresh_token)
        return json(res, 200, issue())
      }
      const grant = codes.get(body.code ?? '')
      const verified = grant && grant.redirectUri === body.redirect_uri &&
        createHash('sha256').update(body.code_verifier ?? '').digest('base64url') === grant.challenge
      if (!verified) return json(res, 400, { error: 'invalid_grant' })
      codes.delete(body.code)
      return json(res, 200, issue())
    }
    if (url.pathname === '/oauth/revoke' && req.method === 'POST') {
      fake.revoked.push(Object.fromEntries(new URLSearchParams(await readBody(req))))
      res.writeHead(200)
      return res.end()
    }
    if (url.pathname === '/api/mcp') {
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
      if (req.method === 'GET') fake.probes.push(bearer)
      if (fake.signedOut.has(bearer)) {
        return json(res, 401, {
          error: 'This tool was disconnected from your DevSpec account. You can reconnect it from Agent setup in your DevSpec settings.',
          code: 'signed_out',
          retryable: false,
        })
      }
      if (!accessTokens.has(bearer)) {
        return json(res, 401, { error: 'Invalid or revoked API token', code: 'invalid_api_token', retryable: false })
      }
      if (req.method === 'GET') {
        res.writeHead(405, { allow: 'POST, DELETE' })
        return res.end()
      }
      const message = JSON.parse((await readBody(req)) || '{}')
      if (message.method === 'tools/call' && message.params?.name === 'verify_agent_connection') {
        fake.verifications.push({ bearer, plugin: req.headers['x-devspec-plugin'] ?? null })
        return json(res, 200, {
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: JSON.stringify({ verified: true, connected_as: connectedAs }) }] },
        })
      }
      return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '{}' }] } })
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  return fake
}
