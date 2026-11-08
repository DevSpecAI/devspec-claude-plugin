#!/usr/bin/env node
/**
 * The `headersHelper` for Claude Code's own DevSpec connection (item 47f0dbdf).
 *
 * plugin.json declares the `devspec` MCP server with
 *   "headersHelper": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/mcp-headers.mjs\""
 * Claude Code runs it when it connects, on every reconnect, and again after DevSpec
 * refuses a request, and sends the JSON object it prints as request headers. That is how
 * the host's connection uses the same browser sign-in as everything else the plugin does,
 * renewed as it goes, with nothing pasted.
 *
 * What Claude Code gives it, measured on 2.1.319 and matching its MCP documentation:
 *   - CLAUDE_CODE_MCP_SERVER_URL: the server URL with `${user_config.devspec_mcp_url}`
 *     already substituted and the `?model_tools=…` query still on. The query is stripped
 *     to find the login.
 *   - CLAUDE_PLUGIN_ROOT, CLAUDE_CODE_MCP_SERVER_NAME, HOME, PATH; working directory = the
 *     plugin root.
 *   - NOT any variable whose name looks like a credential: DEVSPEC_MCP_TOKEN is removed.
 *   - Ten seconds before Claude Code gives up on it.
 * Its headers replace static `headers` of the same name; a header it does not print keeps
 * the static value. A helper that fails or prints nothing leaves the static headers.
 *
 * So:
 *   - a usable sign-in for this server → `Authorization: Bearer <access token>` plus the
 *     plugin header. Renewed first, under the cross-process lock, once past half its life.
 *   - no sign-in, or one that has ended → the plugin header only. The static
 *     `Authorization: Bearer ${DEVSPEC_MCP_TOKEN:-}` then applies: the environment token on
 *     a machine with no browser, otherwise an empty one that DevSpec refuses, which Claude
 *     Code shows as a failed connection rather than starting a sign-in of its own (an
 *     Authorization header is configured, so it does not fall back to OAuth). The session
 *     start message (`devspec-login.mjs session-start`) tells the person to run
 *     /devspec:devspec.login.
 * It never waits on a person and never runs past its own deadline: a renewal that cannot
 * finish in time hands back the token the file already holds.
 *
 * stdout carries the JSON object and nothing else. Exit status is always 0.
 */

import { activeLogin, readStore } from './auth-store.mjs'
import { PLUGIN_HEADER, pluginHeaderValue } from './mcp-call.mjs'
import { resourceKey } from './oauth.mjs'
import { isEntryPoint } from './entry-point.mjs'

/**
 * Inside Claude Code's ten seconds with room for node to start and print. The lock wait
 * plus the renewal's own timeout stay below it, so a renewal always finishes (and its
 * rotated renewal key is written) before the deadline could cut it off.
 */
export const HELPER_DEADLINE_MS = 8_000
const LOCK_WAIT_MS = 2_000
const RENEW_TIMEOUT_MS = 4_000

function staticHeaders() {
  const value = pluginHeaderValue()
  return value ? { [PLUGIN_HEADER]: value } : {}
}

/** The token the file holds for `key` right now, renewed or not, unless the login ended. */
function storedToken(key) {
  const login = key ? readStore().logins[key] : null
  return login && !login.endedAt ? login.accessToken : null
}

/**
 * The headers for the server Claude Code is connecting to. `deps` exists for the tests.
 */
export async function connectionHeaders(env = process.env, {
  deadlineMs = HELPER_DEADLINE_MS,
  lockWaitMs = LOCK_WAIT_MS,
  refreshTimeoutMs = RENEW_TIMEOUT_MS,
  refresh,
} = {}) {
  const headers = staticHeaders()
  const key = resourceKey(env.CLAUDE_CODE_MCP_SERVER_URL)
  if (!key) return headers
  let timer
  const outOfTime = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), deadlineMs)
    timer.unref?.()
  })
  let token = null
  try {
    const result = await Promise.race([
      activeLogin(key, { lockWaitMs, refreshTimeoutMs, ...(refresh ? { refresh } : {}) }),
      outOfTime,
    ])
    token = result?.timedOut ? storedToken(key) : (result?.token ?? null)
  } catch {
    token = storedToken(key)
  } finally {
    clearTimeout(timer)
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

if (isEntryPoint(import.meta.url)) {
  let headers
  try {
    headers = await connectionHeaders()
  } catch {
    headers = staticHeaders()
  }
  process.stdout.write(`${JSON.stringify(headers)}\n`)
  // A renewal still in flight past the deadline must not hold the process open.
  process.exit(0)
}
