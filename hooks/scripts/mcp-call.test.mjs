#!/usr/bin/env node
/**
 * Unit tests for the server's typed failure contract reaching callers.
 * Run: node --test hooks/scripts/mcp-call.test.mjs
 *
 * The regression these encode: every non-OK response used to collapse into an
 * untyped Error whose only carrier was a message string, so a caller wanting to
 * tell "DevSpec could not check the credential right now" from "the credential is
 * dead" had to regex prose. That is what turned transient 503s into "your token is
 * revoked" in the Pi client (DevSpec item 781886cf), and what made `/devspec.remote`
 * die on a Bad Gateway that worked on the next attempt (item 1f0e1e3b).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mcpToolsCall, readServerFailure, isRetryableHttpFailure } from './mcp-call.mjs'

describe('readServerFailure', () => {
  it('reads the outage contract: 503 + auth_validation_unavailable + retryable', () => {
    const f = readServerFailure(503, JSON.stringify({
      error: 'Could not validate credentials',
      code: 'auth_validation_unavailable',
      credential_type: 'api_token',
      retryable: true,
    }))
    assert.equal(f.status, 503)
    assert.equal(f.serverCode, 'auth_validation_unavailable')
    assert.equal(f.retryable, true)
    assert.equal(f.credentialType, 'api_token')
  })

  it('reads the rejection contract: 401 + invalid_api_token + not retryable', () => {
    const f = readServerFailure(401, JSON.stringify({
      error: 'Invalid or revoked API token',
      code: 'invalid_api_token',
      retryable: false,
    }))
    assert.equal(f.status, 401)
    assert.equal(f.serverCode, 'invalid_api_token')
    assert.equal(f.retryable, false)
  })

  it('reads a rejected connection capability', () => {
    const f = readServerFailure(401, JSON.stringify({
      code: 'invalid_connection_capability',
      credential_type: 'connection_capability',
      retryable: false,
    }))
    assert.equal(f.serverCode, 'invalid_connection_capability')
    assert.equal(f.credentialType, 'connection_capability')
    assert.equal(f.retryable, false)
  })

  it('still yields the status when the body carries no JSON at all', () => {
    // The real 502 that broke connect had exactly this body.
    const f = readServerFailure(502, 'Bad Gateway')
    assert.equal(f.status, 502)
    assert.equal(f.serverCode, null)
    assert.equal(f.retryable, null)
  })

  it('survives an HTML error page without inventing fields', () => {
    const f = readServerFailure(500, '<html><body>nginx {oops}</body></html>')
    assert.equal(f.status, 500)
    assert.equal(f.serverCode, null)
    assert.equal(f.retryable, null)
  })

  it('ignores a credential_type it does not recognise', () => {
    const f = readServerFailure(401, JSON.stringify({ credential_type: 'something_else' }))
    assert.equal(f.credentialType, null)
  })
})

describe('isRetryableHttpFailure', () => {
  it('retries what the server called retryable', () => {
    assert.equal(isRetryableHttpFailure({ status: 503, retryable: true }), true)
  })

  it('does NOT retry a credential the server actually rejected', () => {
    // The whole point: a dead token must not be hammered, and must reach the
    // human as an auth failure rather than as a slow connect.
    assert.equal(isRetryableHttpFailure({ status: 401, serverCode: 'invalid_api_token', retryable: false }), false)
  })

  it("lets the server's explicit false win over a retryable-looking status", () => {
    assert.equal(isRetryableHttpFailure({ status: 503, retryable: false }), false)
  })

  it('retries a body-less gateway failure on status alone', () => {
    for (const status of [408, 429, 502, 503, 504]) {
      assert.equal(isRetryableHttpFailure({ status, retryable: null }), true, `status ${status}`)
    }
  })

  it('does not retry a 4xx that is a verdict on the request', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      assert.equal(isRetryableHttpFailure({ status, retryable: null }), false, `status ${status}`)
    }
  })

  it('never retries a deliberate abort', () => {
    // err.code is the ABORT reason in this module, not the server's code.
    assert.equal(isRetryableHttpFailure({ code: 'owner_gone', status: 503 }), false)
    assert.equal(isRetryableHttpFailure({ code: 'timeout', status: 503 }), false)
  })

  it('retries a request the server never saw (fa9b809b)', async () => {
    // DNS, refused, reset, no network: fetch throws before any status exists. That is
    // no verdict, and reading it as one put an offline-at-startup agent to sleep.
    let thrown = null
    try {
      await mcpToolsCall({ mcpUrl: 'http://127.0.0.1:1/api/mcp', token: 'dvs_x', name: 'list_projects', arguments: {} })
    } catch (e) {
      thrown = e
    }
    assert.ok(thrown, 'an unreachable server throws')
    assert.equal(thrown.transport, true)
    assert.equal(thrown.status, undefined)
    assert.equal(isRetryableHttpFailure(thrown), true)
    // A deliberate abort still wins over the transport mark.
    assert.equal(isRetryableHttpFailure({ transport: true, code: 'timeout' }), false)
  })

  it('is safe on non-objects', () => {
    assert.equal(isRetryableHttpFailure(null), false)
    assert.equal(isRetryableHttpFailure('MCP HTTP 502: Bad Gateway'), false)
  })
})
