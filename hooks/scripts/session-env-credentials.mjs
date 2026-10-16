#!/usr/bin/env node
/**
 * Make the plugin's own configured credentials reachable from the plugin's own
 * scripts, without ever putting the key on a command line.
 *
 *   (default)     SessionStart: file this conversation's settings privately
 *                 (`plugin-settings.mjs`), point the session environment at them, and
 *                 clear away files left by Claude Code processes that have gone.
 *   session-end   SessionEnd: remove this conversation's file.
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
 * `/devspec:devspec.remote` at all.
 *
 * ## The mechanism, and why the key itself is not in it (item 4d40407b)
 *
 * For SessionStart (also Setup, CwdChanged, FileChanged) Claude Code sets
 * `CLAUDE_ENV_FILE` in the hook env, pointing at
 * `<config>/session-env/<session-id>/sessionstart-hook-<n>.sh`, and applies what the
 * hook writes there to the session's later Bash tool calls and monitors.
 *
 * HOW it applies it decides what may be written there. Measured on Claude Code
 * 2.1.301 (Linux), read from its shell-command builder and confirmed on the process
 * table: the env files' text is spliced into the shell's own command line,
 *
 *     /usr/bin/zsh -c "source <snapshot> 2>/dev/null || true && <env file text>
 *     : && … eval '<the command>'"
 *
 * so until 0.46.1 every Bash tool call and the startup listener carried
 * `export CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN='dvs_…'` in argv, readable by every local
 * account through `/proc/<pid>/cmdline`. The PowerShell tool (Windows) instead PARSES
 * the joined files into environment variables, and only if every line is a comment or
 * a plain `export NAME=value`; one other line empties it for every hook, and values
 * holding `/` or `\` are dropped.
 *
 * So the file written here holds no secret and only plain assignments: this
 * conversation's id (`DEVSPEC_PLUGIN_SETTINGS_SESSION`, no path separators) and, when
 * set, the non-secret `connect_at_startup`. The key and its server are filed at mode
 * 0600 under `~/.devspec/remote-control/startup/`, and `pluginSettingsFromEnv` reads
 * them back by that id. The file is per-session AND per-hook-index, so it belongs to
 * this hook alone; truncating it is safe.
 *
 * ## Why the plugin's own names, and not DEVSPEC_MCP_TOKEN
 *
 * The resolver reads the filed pair at the same rung as the hook's own
 * `CLAUDE_PLUGIN_OPTION_*` values — source 6. Exporting `DEVSPEC_MCP_TOKEN` instead
 * would have been shorter and wrong: it is source 1, so the plugin's own configured key
 * would have started outranking a developer's project `.mcp.json` (source 3) and their
 * `~/.claude.json` (sources 4-5). Those sources exist precisely so a local endpoint can
 * win. What carries the plugin's settings changed; where they rank did not.
 *
 * ## Why not read the credential store directly
 *
 * Because there is no portable credential store to read. `pluginSecrets` goes through
 * Claude Code's platform-dispatched secure storage: the macOS Keychain, the Windows
 * Credential Manager, or `~/.claude/.credentials.json` on Linux. Only the last is a
 * file. The hook is handed the resolved value whatever stored it, so this route is the
 * same everywhere.
 *
 * Both values travel together or not at all (item 8bb707fd): a token that arrives
 * without its URL silently pairs against the production default, which is the
 * cross-wiring this plugin has now removed twice.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  firstValue,
  PLUGIN_SETTINGS_SESSION_VAR,
  pluginSettingsFromHookEnv,
  readSessionSettings,
  removeSessionSettingsFile,
  sanitizeSessionId,
  SESSION_SETTINGS_DIR,
  sessionSettingsPath,
  STARTUP_KEYS,
  TOKEN_KEYS,
  writeSessionSettings,
} from './plugin-settings.mjs'
import { readPrivateJsonResult, STATE_OK } from './private-state.mjs'
import { pidAlive, processStartTime, resolveClaudePid } from './startup-listener.mjs'

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

/**
 * How old a filed settings file must be before the sweep removes it when it cannot tell
 * whether the Claude Code process that wrote it is still running: a file from a version
 * before 0.46.1 (which recorded no owner, and whose listener read it only in its first
 * twenty seconds), or one whose owner could not be identified. A live conversation's
 * file is rewritten at every session start, resume, /clear and compaction, so a day
 * only reaches a conversation that has run a whole day without any of them.
 */
export const UNOWNED_SETTINGS_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Single-quote for POSIX sh. Every value written here is quoted rather than trusted,
 * even though a conversation id and a boolean option are inert today.
 */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

/**
 * The script to hand to Claude Code, or null when there is no key to point at.
 *
 * It never contains the key: only the conversation id whose private file holds it, and
 * `connect_at_startup` when set (read by the startup listener, which Claude Code does
 * not hand plugin settings either; only when set, so an unset option keeps its default
 * rather than becoming ""). Every line is a comment or a plain `export NAME='value'`.
 */
export function buildSessionEnvScript(env = process.env, sessionId = null) {
  if (!firstValue(env, TOKEN_KEYS)) return null
  const id = sanitizeSessionId(sessionId)
  if (!id) return null
  const connectAtStartup = firstValue(env, STARTUP_KEYS)
  return [
    '# DevSpec plugin: this session\'s DevSpec key is in a file only you can read, never here (items bb97c9f6, 4d40407b).',
    `export ${PLUGIN_SETTINGS_SESSION_VAR}=${shellQuote(id)}`,
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

/** The Claude Code process this hook runs for, as a settings file records it. */
function ownerOf(env) {
  const pid = resolveClaudePid(env)
  return pid ? { pid, started: processStartTime(pid) } : null
}

/**
 * SessionStart: file the settings, then write `$CLAUDE_ENV_FILE`.
 *
 * Returns a small result object for the tests. Never throws: an older Claude Code
 * that does not set `CLAUDE_ENV_FILE` or a read-only path means "carry nothing", and
 * the resolver's other sources still work. A plugin with no key gets the missing-key
 * marker instead (reason `no_token`). If the settings cannot be filed the session
 * environment says nothing about the key (reason `settings_not_filed`): falling back
 * to exporting it would put it back on every command line. A session must never fail
 * to start over this.
 */
export function writeSessionEnvCredentials(options = {}) {
  const {
    env = process.env,
    sessionId = null,
    writeFile = fs.writeFileSync,
    dir = SESSION_SETTINGS_DIR,
    owner = undefined,
  } = options
  const settings = pluginSettingsFromHookEnv(env)
  const id = sanitizeSessionId(sessionId)

  // Filed whether or not this host sets CLAUDE_ENV_FILE: the startup listener reads
  // it by its own conversation id.
  const filed =
    settings !== null &&
    id !== null &&
    writeSessionSettings(id, settings, { dir, owner: owner === undefined ? ownerOf(env) : owner })

  const target = typeof env.CLAUDE_ENV_FILE === 'string' ? env.CLAUDE_ENV_FILE.trim() : ''
  if (!target) return { written: false, filed, reason: 'no_env_file' }

  let script
  let reason
  if (settings === null) {
    script = buildMissingKeyScript()
    reason = 'no_token'
  } else if (!filed) {
    // Still carry the non-secret option, so the listener keeps the person's choice.
    const connectAtStartup = firstValue(env, STARTUP_KEYS)
    script =
      connectAtStartup === null ? '' : `export CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP=${shellQuote(connectAtStartup)}\n`
    reason = 'settings_not_filed'
  } else {
    script = buildSessionEnvScript(env, id)
    reason = 'ok'
  }

  try {
    // Truncate rather than append: the file is this hook's alone, and a resumed
    // session re-running the hook must not stack lines — nor keep the key an earlier
    // version of this hook wrote here.
    writeFile(target, script, { encoding: 'utf8', mode: 0o600 })
    return { written: true, filed, reason }
  } catch {
    return { written: false, filed, reason: 'write_failed' }
  }
}

/**
 * Remove filed settings whose Claude Code process has gone, so a crash or a killed
 * terminal does not leave a copy of the key behind indefinitely. `keep` is the
 * conversation being started. A file is removed when:
 *   - the process that wrote it is no longer running, or its pid now belongs to a
 *     different process (start time differs, where the platform reports one); or
 *   - it names no owner (an earlier version, or an owner that could not be
 *     identified) and is older than UNOWNED_SETTINGS_MAX_AGE_MS.
 * A file that cannot be read is left alone: it may be mid-write by another session.
 */
export function sweepSessionSettings({
  dir = SESSION_SETTINGS_DIR,
  keep = null,
  now = Date.now(),
  isAlive = pidAlive,
  startTimeOf = processStartTime,
} = {}) {
  const removed = []
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return removed
  }
  const keepName = keep ? `${sanitizeSessionId(keep)}.json` : null
  for (const name of names) {
    if (!name.endsWith('.json') || name === keepName) continue
    const file = path.join(dir, name)
    const read = readPrivateJsonResult(file)
    if (read.status !== STATE_OK || !read.value || typeof read.value !== 'object') continue
    const ownerPid = Number(read.value.owner_pid)
    let stale
    if (Number.isInteger(ownerPid) && ownerPid > 1) {
      const recorded = read.value.owner_started ?? null
      const current = isAlive(ownerPid) ? startTimeOf(ownerPid) : undefined
      stale = current === undefined || (recorded !== null && current !== null && String(recorded) !== String(current))
    } else {
      let mtime = now
      try {
        mtime = fs.statSync(file).mtimeMs
      } catch {
        /* gone already */
      }
      stale = now - mtime > UNOWNED_SETTINGS_MAX_AGE_MS
    }
    if (!stale) continue
    try {
      fs.rmSync(file, { force: true })
      removed.push(name)
    } catch {
      /* best effort; the next session start tries again */
    }
  }
  return removed
}

/**
 * SessionEnd: remove this conversation's settings. Kept when the file now belongs to a
 * different Claude Code process that is still running — the same conversation resumed
 * in another window, whose own SessionStart re-filed it.
 */
export function removeSessionSettings(sessionId, {
  dir = SESSION_SETTINGS_DIR,
  ownerPid = null,
  isAlive = pidAlive,
} = {}) {
  const file = sessionSettingsPath(sessionId, dir)
  if (!file) return { removed: false, reason: 'no_session' }
  const filed = readSessionSettings(sessionId, { dir })
  const filedOwner = Number(filed?.owner_pid)
  if (
    Number.isInteger(ownerPid) && ownerPid > 1 &&
    Number.isInteger(filedOwner) && filedOwner > 1 &&
    filedOwner !== ownerPid && isAlive(filedOwner)
  ) {
    return { removed: false, reason: 'owned_by_another_process' }
  }
  return { removed: removeSessionSettingsFile(sessionId, { dir }), reason: 'ended' }
}

function readPayload() {
  try {
    if (process.stdin.isTTY) return {}
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  // SessionStart stdout is parsed as hook JSON. The only thing this hook ever says is
  // the missing-key notice, as a systemMessage, which Claude Code shows the person:
  // they are the one who can fix it, and nothing else surfaces it. Always exit 0.
  try {
    const payload = readPayload()
    const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : null
    if (process.argv[2] === 'session-end') {
      removeSessionSettings(sessionId, { ownerPid: resolveClaudePid(process.env) })
    } else {
      writeSessionEnvCredentials({ sessionId })
      sweepSessionSettings({ keep: sessionId })
      if (!pluginSettingsHoldKey()) {
        process.stdout.write(`${JSON.stringify({ systemMessage: PLUGIN_SETTINGS_KEY_MISSING_MESSAGE })}\n`)
      }
    }
  } catch {
    /* never block a session over this */
  }
  process.exit(0)
}
