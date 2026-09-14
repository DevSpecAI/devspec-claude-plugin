#!/usr/bin/env node
/**
 * Minimal JSON-RPC tools/call against DevSpec streamable HTTP MCP.
 *
 * Optional `timeoutMs` and `isAlive` exist for the LONG-POLL tick (`poll_connection`
 * holds a request open for ~25s):
 *   - timeoutMs: fetch has no default timeout, so a silently-dropped TCP connection
 *     would otherwise wedge a held request — and therefore the poller's heartbeat —
 *     forever. Always set a ceiling above the server's own hold.
 *   - isAlive: polled while the request is in flight. Returning false aborts it, so a
 *     poller whose owning agent process died tears down immediately instead of after
 *     the hold expires (the anti-zombie contract).
 * Both throw an Error carrying `code` ('timeout' | 'owner_gone') so callers can tell a
 * deliberate abort from a network failure. Omitting them keeps the original behaviour.
 */

/** HTTP statuses that describe a transient condition, not a verdict on the request. */
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 502, 503, 504])

/**
 * Read the server's typed failure contract off a non-OK response body (DevSpec
 * item 798e2375). A validation outage answers 503 with
 * `{code:'auth_validation_unavailable', retryable:true, credential_type}`; a
 * genuinely rejected credential answers 401 with
 * `{code:'invalid_api_token'|'invalid_connection_capability', retryable:false}`.
 *
 * Without this the status and the machine code exist only inside the error's
 * message string, so every caller has to regex them back out — the pattern that
 * turned transient 503s into "your token is revoked, go log in" in the Pi client
 * (DevSpec item 781886cf).
 *
 * The server's word is carried as `serverCode`, deliberately NOT `code`: in this
 * module `err.code` already means the ABORT reason ('timeout' | 'owner_gone') and
 * callers switch on it. Exported for tests.
 */
export function readServerFailure(status, bodyText) {
  const out = {
    status: Number.isInteger(status) ? status : null,
    serverCode: null,
    retryable: null,
    credentialType: null,
  }
  const text = typeof bodyText === 'string' ? bodyText : ''
  const start = text.indexOf('{')
  // No JSON at all — a proxy's body-less "Bad Gateway" is the common case, and
  // the status alone still has to be enough to classify it.
  if (start < 0) return out
  let body = null
  try {
    body = JSON.parse(text.slice(start))
  } catch {
    body = null
  }
  if (!body || typeof body !== 'object') return out
  if (typeof body.code === 'string') out.serverCode = body.code
  if (typeof body.retryable === 'boolean') out.retryable = body.retryable
  if (body.credential_type === 'api_token' || body.credential_type === 'connection_capability') {
    out.credentialType = body.credential_type
  }
  return out
}

/**
 * Should this failure be tried again?
 *
 * The server's explicit word wins over the status, so a credential it has actually
 * rejected is never retried however the transport dressed it up. A body-less
 * 502/503 from a proxy mid-redeploy carries no word to offer — that is exactly the
 * case that killed `/devspec.remote` on 2026-09-14 — hence the status fallback.
 *
 * A deliberate abort is never retried: 'owner_gone' means the owning agent died,
 * and retrying a timeout would double a ceiling the caller chose. Exported for tests.
 */
export function isRetryableHttpFailure(err) {
  if (!err || typeof err !== 'object') return false
  if (err.code === 'owner_gone' || err.code === 'timeout') return false
  if (err.retryable === false) return false
  if (err.retryable === true) return true
  return RETRYABLE_HTTP_STATUSES.has(err.status)
}

export async function mcpRequest({
  mcpUrl,
  token,
  method,
  params = {},
  connectionCapability = null,
  timeoutMs = 0,
  isAlive = null,
  aliveCheckMs = 2_000,
}) {
  const body = {
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params,
  }

  const controller = new AbortController()
  let abortCode = null
  let timeoutTimer = null
  let aliveTimer = null
  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      abortCode = 'timeout'
      controller.abort()
    }, timeoutMs)
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref()
  }
  if (typeof isAlive === 'function') {
    aliveTimer = setInterval(() => {
      let alive = true
      try {
        alive = isAlive() !== false
      } catch {
        alive = true // a broken liveness probe must never kill a healthy request
      }
      if (!alive) {
        abortCode = 'owner_gone'
        controller.abort()
      }
    }, aliveCheckMs)
    if (typeof aliveTimer.unref === 'function') aliveTimer.unref()
  }

  let res
  try {
    res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(connectionCapability
          ? { 'x-devspec-connection-capability': connectionCapability }
          : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (e) {
    if (abortCode) {
      const err = new Error(`MCP request ${method} aborted: ${abortCode}`)
      err.code = abortCode
      throw err
    }
    throw e
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (aliveTimer) clearInterval(aliveTimer)
  }

  const text = await res.text()
  if (!res.ok) {
    // Message text is deliberately unchanged — logs and existing matching read it.
    // The structure goes alongside it so callers stop parsing prose (item 1f0e1e3b).
    const err = new Error(`MCP HTTP ${res.status}: ${text.slice(0, 400)}`)
    Object.assign(err, readServerFailure(res.status, text))
    throw err
  }

  // Parse JSON or SSE-ish responses
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    // SSE: lines like data: {...}
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('data:')) {
        try {
          payload = JSON.parse(trimmed.slice(5).trim())
          break
        } catch {
          /* continue */
        }
      }
    }
  }

  if (!payload) {
    throw new Error(`Unparseable MCP response: ${text.slice(0, 200)}`)
  }
  if (payload.error) {
    throw new Error(payload.error.message || JSON.stringify(payload.error))
  }

  return payload.result ?? payload
}

export async function mcpToolsCall({
  mcpUrl,
  token,
  name,
  arguments: toolArgs,
  connectionCapability = null,
  onResultMeta = null,
  timeoutMs = 0,
  isAlive = null,
  aliveCheckMs = 2_000,
}) {
  const result = await mcpRequest({
    mcpUrl,
    token,
    method: 'tools/call',
    params: { name, arguments: toolArgs || {} },
    connectionCapability,
    timeoutMs,
    isAlive,
    aliveCheckMs,
  })
  if (typeof onResultMeta === 'function' && result?._meta) onResultMeta(result._meta)

  // tools/call result content is usually { content: [{ type:'text', text:'...' }], isError? }
  const content = result?.content
  if (Array.isArray(content)) {
    const textParts = content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
    const joined = textParts.join('\n')
    if (result?.isError) {
      throw new Error(joined || 'MCP tool error')
    }
    try {
      return JSON.parse(joined)
    } catch {
      return { raw: joined, result }
    }
  }
  return result
}

export async function mcpToolsList(options) {
  const result = await mcpRequest({ ...options, method: 'tools/list', params: {} })
  return Array.isArray(result?.tools) ? result.tools : []
}
