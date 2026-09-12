#!/usr/bin/env node
/**
 * Carry the plugin's own configured credentials into the session environment, so
 * the plugin's own scripts can see them.
 *
 * ## The gap this closes (item bb97c9f6)
 *
 * Claude Code puts `userConfig` into HOOK subprocesses only. Its hook-spawn env
 * builder does, with no sensitivity filter:
 *
 *     for (const [key, value] of Object.entries(resolvedUserConfig))
 *       env[`CLAUDE_PLUGIN_OPTION_${normalise(key)}`] = String(value)
 *
 * Bash tool calls are a different spawn path and receive none of it — not even the
 * non-sensitive `devspec_mcp_url`. Every command in `commands/` runs its script as a
 * Bash tool call, so `resolve-mcp-auth.mjs` source 6 was unreachable from exactly the
 * scripts it existed for: the connect, poll and wait trio. A customer who installed
 * the plugin and pasted their token — the documented, supported path — had no working
 * `/devspec:devspec.remote` at all. It only ever worked for developers who had also
 * hand-written a project `.mcp.json`, which is what hid this.
 *
 * ## The mechanism
 *
 * For SessionStart (also Setup, CwdChanged, FileChanged) Claude Code sets
 * `CLAUDE_ENV_FILE` in the hook env, pointing at
 * `<config>/session-env/<session-id>/sessionstart-hook-<n>.sh`. Whatever the hook
 * writes there is read back, concatenated with the other hook files, and applied to
 * the session environment — so it reaches Bash tool subprocesses. Measured on
 * 2026-09-03 against Claude Code 2.1.259: a hook writing `export FOO=bar` to that
 * path yields `FOO=bar` inside a subsequent Bash tool call.
 *
 * The file is per-session AND per-hook-index, so it belongs to this hook alone.
 * Nothing else writes it and truncating it is safe.
 *
 * ## Why these variable names and not DEVSPEC_MCP_TOKEN
 *
 * We re-export the SAME names the hook was given. That makes the Bash environment
 * match the hook environment and nothing more.
 *
 * Exporting `DEVSPEC_MCP_TOKEN` instead would have been shorter and wrong: it is
 * source 1 of the resolver, so the plugin's own configured key would have started
 * outranking a developer's project `.mcp.json` (source 3) and their `~/.claude.json`
 * (sources 4-5). Those sources exist precisely so a local endpoint can win. Feeding
 * plugin config in at the top of the ladder would have inverted the order for every
 * existing developer, silently, while looking like a bug fix.
 *
 * ## Why not read the credential store directly
 *
 * Because there is no portable credential store to read. `pluginSecrets` goes through
 * Claude Code's platform-dispatched secure storage: the macOS Keychain, the Windows
 * Credential Manager, or `~/.claude/.credentials.json` on Linux. Only the last is a
 * file. Reading it would pass on a Linux developer's machine and fail silently for
 * most customers — the exact shape of bug this item exists to remove. The hook is
 * handed the resolved value whatever stored it, so this route is the same everywhere.
 *
 * Both values travel together or not at all (item 8bb707fd): a token that arrives
 * without its URL silently pairs against the production default, which is the
 * cross-wiring this plugin has now removed twice.
 */

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Mirrors DEFAULT_PROD_URL in resolve-mcp-auth.mjs — the manifest's declared default. */
const DEFAULT_PROD_URL = 'https://api.devspec.ai/api/mcp'

/**
 * The names Claude Code uses for this plugin's `userConfig` keys, both spellings.
 * `resolve-mcp-auth.mjs` reads the same pairs, so the two stay in step.
 */
const TOKEN_KEYS = ['CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN', 'CLAUDE_PLUGIN_OPTION_devspec_token']
const URL_KEYS = ['CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL', 'CLAUDE_PLUGIN_OPTION_devspec_mcp_url']

function firstValue(env, keys) {
  for (const key of keys) {
    const raw = env[key]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  }
  return null
}

/**
 * Single-quote for POSIX sh. A userConfig value is arbitrary user input that reaches
 * a shell, so it is quoted rather than trusted — even though a `dvs_` token and an
 * https URL both happen to be inert today.
 */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

/**
 * The script to hand to Claude Code, or null when there is nothing to say.
 *
 * Null when no token is configured — that is the un-enabled plugin, not an error.
 * The URL falls back to the manifest default so the pair is never half-written.
 */
export function buildSessionEnvScript(env = process.env) {
  const token = firstValue(env, TOKEN_KEYS)
  if (!token) return null
  const mcpUrl = firstValue(env, URL_KEYS) || DEFAULT_PROD_URL
  return [
    '# DevSpec plugin: userConfig reaches hooks but not Bash tool calls (item bb97c9f6).',
    `export CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN=${shellQuote(token)}`,
    `export CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL=${shellQuote(mcpUrl)}`,
    '',
  ].join('\n')
}

/**
 * Write the script to `$CLAUDE_ENV_FILE`.
 *
 * Returns a small result object for the tests. Never throws: an older Claude Code
 * that does not set `CLAUDE_ENV_FILE`, a read-only path, or a plugin with no token
 * all mean "carry nothing", and the resolver's other sources still work. A session
 * must never fail to start over this.
 */
export function writeSessionEnvCredentials(options = {}) {
  const { env = process.env, writeFile = fs.writeFileSync } = options
  const target = typeof env.CLAUDE_ENV_FILE === 'string' ? env.CLAUDE_ENV_FILE.trim() : ''
  if (!target) return { written: false, reason: 'no_env_file' }

  const script = buildSessionEnvScript(env)
  if (!script) return { written: false, reason: 'no_token' }

  try {
    // Truncate rather than append: the file is this hook's alone, and a resumed
    // session re-running the hook should not stack duplicate exports.
    writeFile(target, script, { encoding: 'utf8', mode: 0o600 })
    return { written: true, reason: 'ok' }
  } catch {
    return { written: false, reason: 'write_failed' }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  // No stdout: SessionStart stdout is parsed as hook JSON, and this hook has
  // nothing to tell the model. Always exit 0 — see writeSessionEnvCredentials.
  writeSessionEnvCredentials()
}
