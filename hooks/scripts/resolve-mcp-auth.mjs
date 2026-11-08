#!/usr/bin/env node
/**
 * The DevSpec server and credential for everything this plugin's own scripts send:
 * remote control, commit tracking, the listener, the poller and every hook (item 47f0dbdf).
 *
 * Two sources, in this order, and nothing else:
 *   1. DEVSPEC_MCP_TOKEN — for machines with no browser (CI, cloud workers). It wins over
 *      a browser sign-in. DEVSPEC_MCP_URL is read only as its pair; without it the token
 *      goes to the plugin's configured server.
 *   2. The plugin's own browser sign-in (`auth-store.mjs`) for the plugin's configured
 *      server — the `devspec_mcp_url` setting, production by default — renewed once it is
 *      past half its life.
 *
 * The host's own DevSpec connection gets the same sign-in from `mcp-headers.mjs`, the
 * `headersHelper` declared in plugin.json, so one login serves everything.
 *
 * Retired with browser sign-in: the pasted `devspec_token` setting, and reading tokens out
 * of a project `.mcp.json` or `~/.claude.json` (items 8bb707fd, 74b29c76 existed to choose
 * among several keys; with one source there is nothing left to choose or prove).
 *
 * CLI: prints `{ ok, mcp_url, source, error? }` — never the token.
 */

import { activeLogin, loginState, resolveCredential, TOKEN_ENV_VAR } from './auth-store.mjs'
import { resourceKey } from './oauth.mjs'
import { DEFAULT_PLUGIN_MCP_URL, pluginSettingsFromEnv } from './plugin-settings.mjs'
import { envTokenOverridesLoginNotice, missingCredentialNotice } from './sign-in-notices.mjs'
import { isEntryPoint } from './entry-point.mjs'

export const DEFAULT_MCP_URL = DEFAULT_PLUGIN_MCP_URL

function trimmed(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** The environment token, when this process has one. */
export function envToken(env = process.env) {
  return trimmed(env?.[TOKEN_ENV_VAR])
}

/** The server the plugin is configured for — the one its sign-in and host connection use. */
export function configuredMcpUrl(env = process.env, opts = {}) {
  const settings = pluginSettingsFromEnv(env, opts.pluginSettingsDir ? { dir: opts.pluginSettingsDir } : undefined)
  return trimmed(settings?.mcp_url) || DEFAULT_MCP_URL
}

/**
 * The server this process's credential is for: DEVSPEC_MCP_URL when the environment token
 * is in use and names one, otherwise the configured server. Synchronous and offline.
 */
export function credentialMcpUrl(env = process.env, opts = {}) {
  if (envToken(env)) return trimmed(env.DEVSPEC_MCP_URL) || configuredMcpUrl(env, opts)
  return configuredMcpUrl(env, opts)
}

/**
 * Whether a credential is available without asking the network: the environment token,
 * or a saved sign-in for the configured server that has not ended. For deciding whether
 * to offer something, never as proof the credential works.
 */
export function hasCredential(env = process.env, opts = {}) {
  if (envToken(env)) return true
  return loginState(configuredMcpUrl(env, opts)).kind === 'active'
}

/**
 * Resolve the credential now: `{ ok, token, mcp_url, source, principal, error? }`.
 *
 * `source` is `env` or `login`; `principal` is the credential's stable identity
 * (`auth-store.mjs` principalOf). On failure `error` is the plain sentence to show the
 * person. `cwd` is accepted for callers' symmetry and no longer consulted: a folder's
 * MCP configuration is not a source of credentials.
 */
export async function resolveDevspecMcpAuth(cwd = process.cwd(), opts = {}) {
  void cwd
  const env = opts.env || process.env
  const mcpUrl = credentialMcpUrl(env, opts)
  const credential = await resolveCredential({
    env,
    endpoint: mcpUrl,
    ...(opts.refresh ? { refresh: opts.refresh } : {}),
    ...(opts.lockWaitMs !== undefined ? { lockWaitMs: opts.lockWaitMs } : {}),
  })
  if (credential) {
    return {
      ok: true,
      token: credential.token,
      mcp_url: mcpUrl,
      source: credential.source,
      principal: credential.principal,
    }
  }
  return {
    ok: false,
    mcp_url: mcpUrl,
    source: null,
    error: missingCredentialNotice(loginState(mcpUrl), mcpUrl),
  }
}

/**
 * The credential a connection was registered with, as it is NOW (item 47f0dbdf).
 *
 * Long-lived consumers (the poller, the listener, a hook acting for a live connection)
 * call this every time they talk to DevSpec instead of holding a token from the start,
 * because a browser sign-in's access token changes at every renewal. They never switch
 * identity: a connection made with a browser sign-in is served only by that same sign-in
 * (its `principal`), and one made with DEVSPEC_MCP_TOKEN keeps the token it recorded.
 *
 * A state that recorded neither (a caller with no connection yet) resolves afresh.
 * Returns `{ ok, token, mcp_url, source, principal }` or `{ ok: false, reason, error }`.
 */
export async function connectionCredential(state, opts = {}) {
  const env = opts.env || process.env
  const recordedUrl = trimmed(state?.mcp_url)
  if (state?.auth_source === 'login' && trimmed(state?.principal) && recordedUrl) {
    const active = await activeLogin(recordedUrl, {
      ...(opts.refresh ? { refresh: opts.refresh } : {}),
      ...(opts.lockWaitMs !== undefined ? { lockWaitMs: opts.lockWaitMs } : {}),
    })
    if (!active) {
      return { ok: false, reason: 'signed_out', mcp_url: recordedUrl, error: missingCredentialNotice(loginState(recordedUrl), recordedUrl) }
    }
    if (active.principal !== state.principal) {
      return {
        ok: false,
        reason: 'identity_changed',
        mcp_url: recordedUrl,
        error: 'This connection was made with a different DevSpec sign-in. Connect again with /devspec:devspec.remote.',
      }
    }
    return { ok: true, token: active.token, mcp_url: recordedUrl, source: 'login', principal: active.principal }
  }
  if (trimmed(state?.token)) {
    return {
      ok: true,
      token: state.token.trim(),
      mcp_url: recordedUrl || credentialMcpUrl(env, opts),
      source: state.auth_source === 'env' ? 'env' : 'recorded',
      principal: trimmed(state.principal) || null,
    }
  }
  const fresh = await resolveDevspecMcpAuth(state?.cwd || process.cwd(), opts)
  if (!fresh.ok) return { ok: false, reason: 'no_credential', mcp_url: fresh.mcp_url, error: fresh.error }
  return fresh
}

/**
 * What to record on a connection for its credential: everything `connectionCredential`
 * needs later, and the token itself only when it came from the environment (a browser
 * sign-in's token would be stale within a day, and the login file already keeps it).
 */
export function credentialRecord(credential) {
  if (!credential?.ok) return { token: undefined, principal: undefined, auth_source: null }
  return {
    mcp_url: credential.mcp_url,
    auth_source: credential.source === 'login' ? 'login' : 'env',
    principal: credential.principal ?? undefined,
    token: credential.source === 'login' ? undefined : credential.token,
  }
}

/** The identity a connection's record names, for comparing two records without the network. */
export function recordedIdentity(state) {
  if (!state) return null
  if (state.auth_source === 'login') return trimmed(state.principal)
  return trimmed(state.token) || trimmed(state.principal)
}

/**
 * The session-start sentence about the credential, or null when there is nothing to say.
 * Offline: reads only the environment and the login file.
 */
export function credentialNotice(env = process.env, opts = {}) {
  const mcpUrl = configuredMcpUrl(env, opts)
  const state = loginState(mcpUrl)
  if (envToken(env)) {
    const envUrl = credentialMcpUrl(env, opts)
    // The environment token only overrides a sign-in for the same server.
    return state.kind !== 'none' && resourceKey(envUrl) === resourceKey(mcpUrl)
      ? envTokenOverridesLoginNotice()
      : null
  }
  return state.kind === 'active' ? null : missingCredentialNotice(state, mcpUrl)
}

// CLI: diagnostics only. Never prints a token.
if (isEntryPoint(import.meta.url)) {
  const result = await resolveDevspecMcpAuth(process.cwd())
  const { token: _token, principal: _principal, ...shown } = result
  process.stdout.write(JSON.stringify(shown) + '\n')
  process.exit(result.ok ? 0 : 1)
}
