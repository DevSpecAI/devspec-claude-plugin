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
/**
 * `connect_at_startup` (item b7ef1fe2) is read by the listener Claude Code starts as a
 * plugin monitor, and monitors are not handed plugin settings either. Carried the same
 * way, and only when set, so an unset option keeps its default rather than becoming "".
 */
const STARTUP_KEYS = ['CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP', 'CLAUDE_PLUGIN_OPTION_connect_at_startup']

/**
 * Set to `missing` in the session environment when the plugin's own settings hold no
 * DevSpec key (item 721f9c67). Claude Code refuses to load the plugin's hooks module
 * while a `required` userConfig field is empty, and it says so only in a debug log, so
 * the status line, the runtime model report, Stop from DevSpec and the room copy of a
 * typed prompt all stop with no sign. Everything else keeps working when the key reaches
 * Claude Code another way (a project `.mcp.json`, `DEVSPEC_MCP_TOKEN`), which is what
 * hid it. Only this hook can tell: it is handed the plugin settings, and Bash tool calls
 * (where `/devspec:devspec.remote` runs) are not. So it leaves an explicit marker rather
 * than letting the connect script read "no token in my env" as proof. That env is empty
 * for other reasons too, e.g. a Claude Code too old to have `CLAUDE_ENV_FILE`.
 */
export const PLUGIN_SETTINGS_KEY_VAR = 'DEVSPEC_PLUGIN_SETTINGS_KEY'

/**
 * What the person is told, at session start and in the connect status block. Written
 * for someone who has never seen our internals: what is off, and the one step that
 * turns it back on. The menu path matches the README's troubleshooting table.
 */
export const PLUGIN_SETTINGS_KEY_MISSING_MESSAGE =
  "DevSpec: your DevSpec key isn't saved in the plugin's settings, so some DevSpec features are switched off: " +
  "your agent's model on the Agents page, the DevSpec status line here, stopping this agent from DevSpec, and copying what you type into the session. " +
  'To turn them on, run /plugin → Installed → DevSpec, press Enter, paste your dvs_ key, then restart Claude Code.'

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
 * Null when no token is configured: the plugin is enabled but its settings hold no
 * key (see PLUGIN_SETTINGS_KEY_VAR for what is written instead).
 * The URL falls back to the manifest default so the pair is never half-written.
 */
export function buildSessionEnvScript(env = process.env) {
  const token = firstValue(env, TOKEN_KEYS)
  if (!token) return null
  const mcpUrl = firstValue(env, URL_KEYS) || DEFAULT_PROD_URL
  const connectAtStartup = firstValue(env, STARTUP_KEYS)
  return [
    '# DevSpec plugin: userConfig reaches hooks but not Bash tool calls (item bb97c9f6).',
    `export CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN=${shellQuote(token)}`,
    `export CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL=${shellQuote(mcpUrl)}`,
    ...(connectAtStartup === null
      ? []
      : [`export CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP=${shellQuote(connectAtStartup)}`]),
    '',
  ].join('\n')
}

/** The marker script for a session whose plugin settings hold no key. */
export function buildMissingKeyScript() {
  return [
    '# DevSpec plugin: no key in the plugin settings, so its live features are off (item 721f9c67).',
    `export ${PLUGIN_SETTINGS_KEY_VAR}='missing'`,
    '',
  ].join('\n')
}

/** Whether the plugin's own settings hold a DevSpec key, from the env a hook is handed. */
export function pluginSettingsHoldKey(env = process.env) {
  return firstValue(env, TOKEN_KEYS) !== null
}

/**
 * Write the script to `$CLAUDE_ENV_FILE`.
 *
 * Returns a small result object for the tests. Never throws: an older Claude Code
 * that does not set `CLAUDE_ENV_FILE` or a read-only path means "carry nothing", and
 * the resolver's other sources still work. A plugin with no token gets the missing-key
 * marker instead of credentials (reason `no_token`). A session
 * must never fail to start over this.
 */
export function writeSessionEnvCredentials(options = {}) {
  const { env = process.env, writeFile = fs.writeFileSync } = options
  const target = typeof env.CLAUDE_ENV_FILE === 'string' ? env.CLAUDE_ENV_FILE.trim() : ''
  if (!target) return { written: false, reason: 'no_env_file' }

  const script = buildSessionEnvScript(env)
  const missing = script === null

  try {
    // Truncate rather than append: the file is this hook's alone, and a resumed
    // session re-running the hook should not stack duplicate exports.
    writeFile(target, missing ? buildMissingKeyScript() : script, { encoding: 'utf8', mode: 0o600 })
    return { written: true, reason: missing ? 'no_token' : 'ok' }
  } catch {
    return { written: false, reason: 'write_failed' }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  // SessionStart stdout is parsed as hook JSON. The only thing this hook ever says is
  // the missing-key notice, as a systemMessage, which Claude Code shows the person:
  // they are the one who can fix it, and nothing else surfaces it. Always exit 0;
  // see writeSessionEnvCredentials.
  writeSessionEnvCredentials()
  if (!pluginSettingsHoldKey()) {
    process.stdout.write(`${JSON.stringify({ systemMessage: PLUGIN_SETTINGS_KEY_MISSING_MESSAGE })}\n`)
  }
}
