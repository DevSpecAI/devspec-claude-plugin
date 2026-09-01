#!/usr/bin/env node
/**
 * Resolve DevSpec MCP URL + Bearer token for remote-control hooks/poller.
 *
 * Credentials are enumerated as token+URL PAIRS from a single source. Never mix
 * a token from one place with a URL from another (item 8bb707fd): a plugin
 * userConfig token must not inherit the project `.mcp.json` URL.
 *
 * Lookup order (first token pair wins for the default pick):
 * 1. DEVSPEC_MCP_TOKEN / DEVSPEC_TOKEN (+ DEVSPEC_MCP_URL) — explicit human override.
 * 2. opts.hostToken — the bearer the HOST MCP client used to call register_connection,
 *    paired with THIS source's URL (plugin → prod default; never `.mcp.json`).
 * 3. Project .mcp.json (cwd and parents) — that file's token AND url.
 * 4. ~/.claude.json project entries that match cwd (mcpServers.devspec)
 * 5. ~/.claude.json top-level mcpServers.devspec
 * 6. CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN — plugin userConfig token + plugin URL
 *    (https://devspec.ai/api/mcp). Lowest priority so a developer's own .mcp.json
 *    (e.g. staging) still wins when no host token was supplied.
 *
 * At write time, proveCredentialPair heartbeats the just-registered connection
 * under each distinct token until one owns it. The poller caches that pair.
 *
 * Prints JSON: { ok, token?, mcp_url?, source?, error? }
 * Never prints the full token in human logs — only to stdout JSON for piping.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_PROD_URL = 'https://devspec.ai/api/mcp'
const WRONG_TOKEN_RE = /belongs to a different token/i

export const DEFAULT_MCP_URL = DEFAULT_PROD_URL

export const TOKENS_WARNING_FIX =
  'Open You → Connections, reveal the key you want, and make the plugin key and the project .mcp.json key the same.'

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function extractBearer(headers) {
  if (!headers || typeof headers !== 'object') return null
  const auth = headers.Authorization || headers.authorization
  if (typeof auth !== 'string') return null
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : auth.trim() || null
}

function fromServerEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const url = entry.url || entry.serverUrl || entry.server_url || null
  const token = extractBearer(entry.headers) || entry.token || null
  if (!url && !token) return null
  return { mcp_url: url || DEFAULT_PROD_URL, token: token || null }
}

function walkMcpJson(startDir) {
  let dir = path.resolve(startDir || process.cwd())
  for (let i = 0; i < 12; i++) {
    for (const name of ['.mcp.json', 'mcp.json']) {
      const file = path.join(dir, name)
      if (!fs.existsSync(file)) continue
      const j = readJson(file)
      const servers = j?.mcpServers || j?.mcp?.servers || {}
      const entry = servers.devspec || servers.DevSpec || servers['devspec-mcp']
      const got = fromServerEntry(entry)
      if (got?.token) return { ...got, source: file }
      if (got?.mcp_url) return { ...got, source: file }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function fromClaudeJson(cwd) {
  const file = path.join(os.homedir(), '.claude.json')
  const j = readJson(file)
  if (!j) return null

  const abs = path.resolve(cwd || process.cwd())

  // Prefer project-scoped config matching cwd prefix (longest match wins)
  const projects = j.projects || {}
  const matches = Object.keys(projects)
    .filter((p) => abs === p || abs.startsWith(p + path.sep) || p.startsWith(abs + path.sep))
    .sort((a, b) => b.length - a.length)

  for (const proj of matches) {
    const servers = projects[proj]?.mcpServers || {}
    const entry = servers.devspec || servers.DevSpec
    const got = fromServerEntry(entry)
    if (got?.token) return { ...got, source: `${file}#projects[${proj}]` }
  }

  // Any project entry named for this path substring
  for (const [proj, cfg] of Object.entries(projects)) {
    if (!proj.includes('devspec') && !abs.includes(path.basename(proj))) continue
    const servers = cfg?.mcpServers || {}
    const entry = servers.devspec || servers.DevSpec
    const got = fromServerEntry(entry)
    if (got?.token) return { ...got, source: `${file}#projects[${proj}]` }
  }

  const top = fromServerEntry((j.mcpServers || {}).devspec)
  if (top?.token) return { ...top, source: `${file}#mcpServers` }

  return null
}

function trimToken(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function pairIdentity(pair) {
  return `${pair.token}\0${pair.mcp_url}`
}

/**
 * SHA-256 prefix — enough to tell two keys apart, never the secret itself.
 */
export function fingerprintToken(token) {
  if (typeof token !== 'string' || !token) return 'unknown'
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 8)
}

/**
 * The bearer the HOST MCP client is expected to have used for register_connection,
 * drawn from the reachable process env. The one host-token carrier that reaches
 * hook/tool subprocesses today is CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN — the plugin
 * userConfig token Claude Code exports, which IS the token the host uses for the
 * plugin-declared `devspec` MCP server (so register_connection runs on it). Pass the
 * result as resolveDevspecMcpAuth(cwd, { hostToken }) at connect/write time to keep
 * the poller on the same token. Returns null where the plugin env is unset (a
 * dev-from-source .mcp.json setup, or the non-Claude local-poller plugins) → the
 * caller's resolution is unchanged.
 */
export function hostTokenFromEnv(env = process.env) {
  const t = env.CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN || env.CLAUDE_PLUGIN_OPTION_devspec_token || null
  return typeof t === 'string' && t.trim() ? t.trim() : null
}

function pluginTokenFromEnv(env) {
  return trimToken(env.CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN || env.CLAUDE_PLUGIN_OPTION_devspec_token)
}

/**
 * Every reachable credential as a { token, mcp_url } pair from ONE source.
 * First occurrence of an identical token+URL wins (precedence order).
 */
export function enumerateCredentialPairs(cwd = process.cwd(), opts = {}) {
  const env = opts.env || process.env
  const pairs = []
  const seen = new Set()

  const push = (pair) => {
    if (!pair?.token) return
    const id = pairIdentity(pair)
    if (seen.has(id)) return
    seen.add(id)
    pairs.push(pair)
  }

  const envToken = trimToken(env.DEVSPEC_MCP_TOKEN || env.DEVSPEC_TOKEN)
  const envUrl = trimToken(env.DEVSPEC_MCP_URL) || DEFAULT_PROD_URL
  const pluginToken = pluginTokenFromEnv(env)
  const hostToken =
    typeof opts.hostToken === 'string' && opts.hostToken.trim() ? opts.hostToken.trim() : null
  const fromProject = walkMcpJson(cwd)
  const fromClaude = fromClaudeJson(cwd)

  if (envToken) {
    push({
      source: 'env',
      sourceLabel: 'DEVSPEC_MCP_TOKEN',
      token: envToken,
      mcp_url: envUrl,
    })
  }

  if (hostToken) {
    let mcp_url = DEFAULT_PROD_URL
    let sourceLabel = 'host MCP client'
    if (hostToken === envToken) {
      mcp_url = envUrl
      sourceLabel = 'DEVSPEC_MCP_TOKEN'
    } else if (pluginToken && hostToken === pluginToken) {
      mcp_url = DEFAULT_PROD_URL
      sourceLabel = 'plugin userConfig'
    } else if (fromProject?.token && hostToken === fromProject.token) {
      mcp_url = fromProject.mcp_url || DEFAULT_PROD_URL
      sourceLabel = 'project .mcp.json'
    } else if (fromClaude?.token && hostToken === fromClaude.token) {
      mcp_url = fromClaude.mcp_url || DEFAULT_PROD_URL
      sourceLabel = '~/.claude.json'
    }
    push({
      source: 'host',
      sourceLabel,
      token: hostToken,
      mcp_url,
    })
  }

  if (fromProject?.token) {
    push({
      source: fromProject.source,
      sourceLabel: 'project .mcp.json',
      token: fromProject.token,
      mcp_url: fromProject.mcp_url || DEFAULT_PROD_URL,
    })
  }

  if (fromClaude?.token) {
    push({
      source: fromClaude.source,
      sourceLabel: '~/.claude.json',
      token: fromClaude.token,
      mcp_url: fromClaude.mcp_url || DEFAULT_PROD_URL,
    })
  }

  if (pluginToken) {
    push({
      source: 'plugin_user_config',
      sourceLabel: 'plugin userConfig',
      token: pluginToken,
      mcp_url: DEFAULT_PROD_URL,
    })
  }

  return { pairs, fromProject }
}

export function distinctTokenPairs(pairs) {
  const seen = new Set()
  const out = []
  for (const pair of pairs || []) {
    if (!pair?.token || seen.has(pair.token)) continue
    seen.add(pair.token)
    out.push(pair)
  }
  return out
}

export function buildTokensWarning(pairs) {
  const tokens = distinctTokenPairs(pairs)
  if (tokens.length < 2) return null
  const named = tokens
    .map((pair) => `${pair.sourceLabel} (${fingerprintToken(pair.token)})`)
    .join(', ')
  return (
    `This machine has more than one DevSpec key: ${named}. ` +
    `Connect will use the key that owns this connection. ${TOKENS_WARNING_FIX}`
  )
}

export function isWrongTokenError(err) {
  const msg = err?.message || String(err || '')
  return WRONG_TOKEN_RE.test(msg)
}

/**
 * Probe candidates with heartbeat_connection. Skip the probe when only one
 * distinct token is reachable (it is the only candidate).
 *
 * `probe(pair, connectionId)` should throw on failure. A "belongs to a different
 * token" error falls through to the next pair; other errors also try the next
 * pair (a token sent to the wrong host looks like a network/auth failure).
 */
export async function proveCredentialPair(pairs, { connectionId, probe } = {}) {
  const warning = buildTokensWarning(pairs)
  const tokens = distinctTokenPairs(pairs)
  if (tokens.length === 0) {
    return { pair: null, probed: false, warning: null, error: 'no_token' }
  }
  if (tokens.length === 1) {
    return { pair: tokens[0], probed: false, warning: null, error: null }
  }
  if (typeof probe !== 'function') {
    return { pair: null, probed: false, warning, error: 'unproven' }
  }
  for (const pair of tokens) {
    try {
      await probe(pair, connectionId)
      return { pair, probed: true, warning, error: null }
    } catch (err) {
      if (isWrongTokenError(err)) continue
      continue
    }
  }
  return { pair: null, probed: true, warning, error: 'no_proven_pair' }
}

/**
 * `opts.env` exists so a caller that is already handed an environment can resolve
 * against THAT one instead of the ambient process — the commit-provenance hook takes
 * `env` for everything else it does, and credentials silently ignoring it would make
 * the same call answer differently under test than in the field. Defaults to
 * `process.env`, so every existing caller is unchanged.
 */
export function resolveDevspecMcpAuth(cwd = process.cwd(), opts = {}) {
  const env = opts.env || process.env
  const envUrl = trimToken(env.DEVSPEC_MCP_URL)
  const { pairs, fromProject } = enumerateCredentialPairs(cwd, opts)
  const first = pairs.find((p) => p.token)
  if (first) {
    return {
      ok: true,
      token: first.token,
      mcp_url: first.mcp_url,
      source: first.source,
    }
  }

  // URL-only from project file (token missing)
  if (fromProject?.mcp_url) {
    return {
      ok: false,
      mcp_url: fromProject.mcp_url,
      source: fromProject.source,
      error:
        'Found DevSpec MCP URL but no Bearer token. Set DEVSPEC_MCP_TOKEN or add headers.Authorization on the devspec server in .mcp.json.',
    }
  }

  return {
    ok: false,
    mcp_url: envUrl || DEFAULT_PROD_URL,
    error:
      'No DevSpec MCP token found. Provide your token via the plugin configuration, set DEVSPEC_MCP_TOKEN, or configure mcpServers.devspec.headers.Authorization in project .mcp.json.',
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('resolve-mcp-auth.mjs')) {
  // Reflect the same host-token preference the write path uses, for diagnostics.
  const result = resolveDevspecMcpAuth(process.cwd(), { hostToken: hostTokenFromEnv(process.env) })
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exit(result.ok ? 0 : 1)
}
