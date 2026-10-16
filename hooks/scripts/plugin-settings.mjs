#!/usr/bin/env node
/**
 * This session's plugin settings — the DevSpec key and server the person saved in
 * `/plugin` — for the processes Claude Code does not hand them to.
 *
 * Claude Code gives `userConfig` to HOOKS only (as `CLAUDE_PLUGIN_OPTION_*`). Bash tool
 * calls, where every command in `commands/` runs, and plugin monitors such as the
 * startup listener get none of it (item bb97c9f6). So the SessionStart hook
 * (`session-env-credentials.mjs`) files the settings here, one private file per
 * conversation, and puts only this conversation's id into the session environment
 * (`PLUGIN_SETTINGS_SESSION_VAR`). A script that was not handed the settings reads
 * them back with `pluginSettingsFromEnv`.
 *
 * ## Why a file and not the environment (item 4d40407b)
 *
 * The obvious route — exporting the key itself from `$CLAUDE_ENV_FILE` — put it on
 * the command line of every process Claude Code starts for the session. Measured on
 * Claude Code 2.1.301: the Bash tool reads the hook-written env files and splices
 * their TEXT into the shell's argv (`zsh -c "source <snapshot> && <env file text>
 * : && …"`), and the plugin monitor is started the same way. A command line cannot be
 * permissioned: on Linux any local account reads it from `/proc/<pid>/cmdline`, and
 * it lands in anything that captures a process list. Eleven processes on one
 * developer machine were carrying the key that way.
 *
 * What goes into the session environment instead is the conversation id, which is
 * not a secret. It is also a plain `export NAME='value'` with no path separator in
 * the value, which matters on Windows: there Claude Code's PowerShell tool reads the
 * env files by parsing them, keeps them only if every line is a plain assignment, and
 * drops any value containing `/` or `\`. A `. <file>` line would have silently
 * emptied every hook's session environment for PowerShell, and a path-valued variable
 * would never reach it.
 *
 * ## Where the file lives and who can read it
 *
 * `~/.devspec/remote-control/startup/<conversation-id>.json`, beside the plugin's
 * other remote-control state that holds bearer tokens. The directory is created
 * 0700 and the file is written 0600 by `writePrivateJson` (written aside, then
 * renamed, so it never exists at a looser mode; a looser existing file is replaced).
 * On Windows, POSIX modes do not apply: the file inherits the ACL of the user's
 * profile folder, which by default grants only that user, SYSTEM and Administrators.
 *
 * ## How long it lives
 *
 * Written at every SessionStart — startup, resume, /clear and compaction — and
 * removed at SessionEnd by the same hook. A session that ends without SessionEnd (a
 * crash, a killed terminal) leaves its file behind; the next SessionStart on the
 * machine removes it once the Claude Code process that wrote it has gone
 * (`sweepSessionSettings` in `session-env-credentials.mjs`). The file is never the
 * only copy of anything: Claude Code keeps the key in its own credential store.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readPrivateJsonResult, STATE_OK, writePrivateJson } from './private-state.mjs'

/** Mirrors DEFAULT_PROD_URL in resolve-mcp-auth.mjs — the manifest's declared default. */
export const DEFAULT_PLUGIN_MCP_URL = 'https://api.devspec.ai/api/mcp'

/**
 * The directory. Kept at the path the startup listener has always read (item
 * b7ef1fe2), so files filed by an earlier version are found and cleaned up.
 */
export const SESSION_SETTINGS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'startup')

/** The one thing the session environment carries: which conversation's file to read. */
export const PLUGIN_SETTINGS_SESSION_VAR = 'DEVSPEC_PLUGIN_SETTINGS_SESSION'

/** The names Claude Code uses for this plugin's `userConfig` keys, both spellings. */
export const TOKEN_KEYS = ['CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN', 'CLAUDE_PLUGIN_OPTION_devspec_token']
export const URL_KEYS = ['CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL', 'CLAUDE_PLUGIN_OPTION_devspec_mcp_url']
export const STARTUP_KEYS = ['CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP', 'CLAUDE_PLUGIN_OPTION_connect_at_startup']

export function firstValue(env, keys) {
  for (const key of keys) {
    const raw = env?.[key]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  }
  return null
}

/** A conversation id reduced to the characters a file name may safely hold, or null. */
export function sanitizeSessionId(sessionId) {
  const id = String(sessionId ?? '').replace(/[^a-zA-Z0-9._-]/g, '')
  return id && id !== '.' && id !== '..' ? id : null
}

export function sessionSettingsPath(sessionId, dir = SESSION_SETTINGS_DIR) {
  const id = sanitizeSessionId(sessionId)
  return id ? path.join(dir, `${id}.json`) : null
}

/**
 * The settings Claude Code handed a hook, in the file's shape, or null when the plugin
 * settings hold no key. Token and URL travel together or not at all (item 8bb707fd).
 */
export function pluginSettingsFromHookEnv(env = process.env) {
  const token = firstValue(env, TOKEN_KEYS)
  if (!token) return null
  const connectAtStartup = firstValue(env, STARTUP_KEYS)
  return {
    token,
    mcp_url: firstValue(env, URL_KEYS) || DEFAULT_PLUGIN_MCP_URL,
    ...(connectAtStartup === null ? {} : { connect_at_startup: connectAtStartup }),
  }
}

/**
 * File the settings for one conversation. `owner` names the Claude Code process the
 * conversation runs in (`{ pid, started }`), so a file left behind by a crash can be
 * told apart from a live one. Never throws: returns whether the file was written.
 */
export function writeSessionSettings(sessionId, settings, { dir = SESSION_SETTINGS_DIR, owner = null } = {}) {
  const file = sessionSettingsPath(sessionId, dir)
  if (!file || !settings?.token) return false
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      // mkdir's mode applies only when it creates the directory.
      fs.chmodSync(dir, 0o700)
    } catch {
      /* the file's own 0600 is what protects the key */
    }
    writePrivateJson(file, {
      token: settings.token,
      mcp_url: settings.mcp_url || DEFAULT_PLUGIN_MCP_URL,
      ...(settings.connect_at_startup === undefined ? {} : { connect_at_startup: settings.connect_at_startup }),
      owner_pid: Number.isInteger(owner?.pid) && owner.pid > 1 ? owner.pid : null,
      owner_started: owner?.started ?? null,
      written_at: new Date().toISOString(),
    })
    return true
  } catch {
    return false
  }
}

/** The filed settings for one conversation, or null. */
export function readSessionSettings(sessionId, { dir = SESSION_SETTINGS_DIR } = {}) {
  const file = sessionSettingsPath(sessionId, dir)
  if (!file) return null
  const read = readPrivateJsonResult(file)
  if (read.status !== STATE_OK || typeof read.value?.token !== 'string' || !read.value.token.trim()) return null
  return read.value
}

export function removeSessionSettingsFile(sessionId, { dir = SESSION_SETTINGS_DIR } = {}) {
  const file = sessionSettingsPath(sessionId, dir)
  if (!file) return false
  try {
    fs.rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * The plugin's own key and server, wherever this process can reach them, or null.
 *
 * A hook is handed them in its environment, and that wins. Anything else Claude Code
 * starts for the session — a Bash tool call, a monitor — finds the conversation id the
 * SessionStart hook exported and reads that conversation's file. Both answers are the
 * same pair, so `resolve-mcp-auth.mjs` keeps it at source 6 either way: where it is
 * read from changes, its precedence does not.
 */
export function pluginSettingsFromEnv(env = process.env, { dir = SESSION_SETTINGS_DIR } = {}) {
  const fromHook = pluginSettingsFromHookEnv(env)
  if (fromHook) return { ...fromHook, carried: 'hook_environment' }
  const sessionId = sanitizeSessionId(env?.[PLUGIN_SETTINGS_SESSION_VAR])
  if (!sessionId) return null
  const filed = readSessionSettings(sessionId, { dir })
  if (!filed) return null
  return {
    token: filed.token.trim(),
    mcp_url: (typeof filed.mcp_url === 'string' && filed.mcp_url.trim()) || DEFAULT_PLUGIN_MCP_URL,
    ...(filed.connect_at_startup === undefined ? {} : { connect_at_startup: filed.connect_at_startup }),
    carried: 'session_file',
  }
}
