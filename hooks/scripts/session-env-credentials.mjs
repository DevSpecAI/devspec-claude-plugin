#!/usr/bin/env node
/**
 * Make the plugin's own settings — its DevSpec server and the connect-at-startup choice —
 * reachable from the plugin's own scripts that Claude Code does not hand them to.
 *
 *   (default)     SessionStart: file this conversation's settings privately
 *                 (`plugin-settings.mjs`), point the session environment at them, and
 *                 clear away files left by Claude Code processes that have gone.
 *   session-end   SessionEnd: remove this conversation's file.
 *
 * ## The gap this closes (item bb97c9f6)
 *
 * Claude Code puts `userConfig` into HOOK subprocesses only (as `CLAUDE_PLUGIN_OPTION_*`).
 * Bash tool calls — where every command in `commands/` runs — and plugin monitors such as
 * the startup listener receive none of it, not even the non-secret `devspec_mcp_url`.
 * Without this, a person who pointed the plugin at staging would have `/devspec:devspec.login`
 * and `/devspec:devspec.remote` talk to production.
 *
 * No credential passes through here (item 47f0dbdf): the plugin signs in through the
 * browser and keeps that login in its own file (`auth-store.mjs`). Until 0.54.0 this hook
 * also filed the pasted DevSpec key and warned when the key field was empty; both went
 * with the field.
 *
 * ## The mechanism (item 4d40407b)
 *
 * For SessionStart Claude Code sets `CLAUDE_ENV_FILE` in the hook env and applies what
 * the hook writes there to the session's later Bash tool calls and monitors — by splicing
 * the file's TEXT into their command line (measured on Claude Code 2.1.301, Linux), and on
 * Windows' PowerShell tool by parsing it, keeping it only if every line is a comment or a
 * plain `export NAME=value` with no `/` or `\\` in the value. So the file written here
 * holds only plain assignments: this conversation's id (`DEVSPEC_PLUGIN_SETTINGS_SESSION`)
 * and, when set, `connect_at_startup`. The server setting is filed at mode 0600 under
 * `~/.devspec/remote-control/startup/`, and `pluginSettingsFromEnv` reads it back by that
 * id. The env file is per-session AND per-hook-index, so it belongs to this hook alone;
 * truncating it is safe.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_PLUGIN_MCP_URL,
  firstValue,
  PLUGIN_SETTINGS_SESSION_VAR,
  pluginSettingsFromHookEnv,
  readSessionSettings,
  removeSessionSettingsFile,
  sanitizeSessionId,
  SESSION_SETTINGS_DIR,
  sessionSettingsPath,
  STARTUP_KEYS,
  writeSessionSettings,
} from './plugin-settings.mjs'
import { readPrivateJsonResult, STATE_OK } from './private-state.mjs'
import { pidAlive, processStartTime, resolveClaudePid } from './startup-listener.mjs'
import { isEntryPoint } from './entry-point.mjs'

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
 * The script to hand to Claude Code, or null without a conversation id.
 *
 * Only this conversation's id, whose private file holds the settings, and
 * `connect_at_startup` when set (read by the startup listener; only when set, so an unset
 * option keeps its default rather than becoming ""). Every line is a comment or a plain
 * `export NAME='value'`.
 */
export function buildSessionEnvScript(env = process.env, sessionId = null) {
  const id = sanitizeSessionId(sessionId)
  if (!id) return null
  const connectAtStartup = firstValue(env, STARTUP_KEYS)
  return [
    '# DevSpec plugin: this session\'s plugin settings are in a file only you can read (items bb97c9f6, 4d40407b).',
    `export ${PLUGIN_SETTINGS_SESSION_VAR}=${shellQuote(id)}`,
    ...(connectAtStartup === null
      ? []
      : [`export CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP=${shellQuote(connectAtStartup)}`]),
    '',
  ].join('\n')
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
 * that does not set `CLAUDE_ENV_FILE` or a read-only path means "carry nothing", and the
 * scripts fall back to the manifest's default server. If the settings cannot be filed the
 * session environment carries only the non-secret startup choice (reason
 * `settings_not_filed`). A session must never fail to start over this.
 */
export function writeSessionEnvCredentials(options = {}) {
  const {
    env = process.env,
    sessionId = null,
    writeFile = fs.writeFileSync,
    dir = SESSION_SETTINGS_DIR,
    owner = undefined,
  } = options
  // A hook is always handed the settings Claude Code resolved; with none at all, the
  // manifest's default server still has to reach the Bash tool and the listener.
  const settings = pluginSettingsFromHookEnv(env) ?? { mcp_url: DEFAULT_PLUGIN_MCP_URL }
  const id = sanitizeSessionId(sessionId)

  // Filed whether or not this host sets CLAUDE_ENV_FILE: the startup listener reads
  // it by its own conversation id.
  const filed =
    id !== null &&
    writeSessionSettings(id, settings, { dir, owner: owner === undefined ? ownerOf(env) : owner })

  const target = typeof env.CLAUDE_ENV_FILE === 'string' ? env.CLAUDE_ENV_FILE.trim() : ''
  if (!target) return { written: false, filed, reason: 'no_env_file' }

  let script
  let reason
  if (!filed) {
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
    // session re-running the hook must not stack lines — nor keep anything an earlier
    // version of this hook wrote here.
    writeFile(target, script, { encoding: 'utf8', mode: 0o600 })
    return { written: true, filed, reason }
  } catch {
    return { written: false, filed, reason: 'write_failed' }
  }
}

/**
 * Remove filed settings whose Claude Code process has gone, so a crash or a killed
 * terminal does not leave files behind indefinitely (and an older version's copy of a
 * pasted key goes with them). `keep` is the
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

const isMain = isEntryPoint(import.meta.url)
if (isMain) {
  // SessionStart stdout is parsed as hook JSON; this hook says nothing (sign-in notices
  // are `devspec-login.mjs session-start`). Always exit 0.
  try {
    const payload = readPayload()
    const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : null
    if (process.argv[2] === 'session-end') {
      removeSessionSettings(sessionId, { ownerPid: resolveClaudePid(process.env) })
    } else {
      writeSessionEnvCredentials({ sessionId })
      sweepSessionSettings({ keep: sessionId })
    }
  } catch {
    /* never block a session over this */
  }
  process.exit(0)
}
