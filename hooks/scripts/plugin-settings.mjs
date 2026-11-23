#!/usr/bin/env node
/**
 * This session's plugin settings — the DevSpec server and the connect-at-startup choice
 * the person saved in `/plugin` — for the processes Claude Code does not hand them to.
 *
 * Claude Code gives `userConfig` to HOOKS only (as `CLAUDE_PLUGIN_OPTION_*`). Bash tool
 * calls, where every command in `commands/` runs, and plugin monitors such as the
 * startup listener get none of it (item bb97c9f6). So the SessionStart hook
 * (`session-env-credentials.mjs`) files the settings here, one private file per
 * conversation, and puts only this conversation's id into the session environment
 * (`PLUGIN_SETTINGS_SESSION_VAR`). A script that was not handed the settings reads
 * them back with `pluginSettingsFromEnv`.
 *
 * No credential is filed here any more (item 47f0dbdf). The plugin signs in through the
 * browser and keeps that login in its own file (`auth-store.mjs`); the server setting
 * filed here only says WHICH of its logins to use.
 *
 * ## Why a file and not the environment (item 4d40407b)
 *
 * Claude Code splices the text of hook-written env files into the command line of every
 * Bash tool call and monitor it starts (measured on 2.1.301), and on Windows its
 * PowerShell tool keeps an env file only if every line is a plain assignment with no
 * path separator in its value. A conversation id meets both constraints; anything else
 * stays in the file.
 *
 * ## Where the file lives and who can read it
 *
 * `~/.devspec/remote-control/startup/<conversation-id>.json`, directory 0700, file 0600
 * (`writePrivateJson`: written aside, then renamed). On Windows the file inherits the ACL
 * of the user's profile folder.
 *
 * ## How long it lives
 *
 * Written at every SessionStart — startup, resume, /clear and compaction — and removed at
 * SessionEnd by the same hook. A session that ends without SessionEnd leaves its file
 * behind; the next SessionStart on the machine removes it once the Claude Code process
 * that wrote it has gone (`sweepSessionSettings` in `session-env-credentials.mjs`).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readPrivateJsonResult, STATE_OK, writePrivateJson } from './private-state.mjs'

/** The manifest's declared default for the server setting: DevSpec production. */
export const DEFAULT_PLUGIN_MCP_URL = 'https://api.devspec.ai/api/mcp'

/**
 * The directory. Kept at the path the startup listener has always read (item
 * b7ef1fe2), so files filed by an earlier version are found and cleaned up.
 */
export const SESSION_SETTINGS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'startup')

/** The one thing the session environment carries: which conversation's file to read. */
export const PLUGIN_SETTINGS_SESSION_VAR = 'DEVSPEC_PLUGIN_SETTINGS_SESSION'

/** The names Claude Code uses for this plugin's `userConfig` keys, both spellings. */
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
 * The settings Claude Code handed a hook, in the file's shape, or null when this process
 * was handed none (it is not a hook). The server defaults to the manifest's default.
 */
export function pluginSettingsFromHookEnv(env = process.env) {
  const mcpUrl = firstValue(env, URL_KEYS)
  const connectAtStartup = firstValue(env, STARTUP_KEYS)
  if (mcpUrl === null && connectAtStartup === null) return null
  return {
    mcp_url: mcpUrl || DEFAULT_PLUGIN_MCP_URL,
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
  if (!file || !settings) return false
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      // mkdir's mode applies only when it creates the directory.
      fs.chmodSync(dir, 0o700)
    } catch {
      /* the file's own 0600 still applies */
    }
    writePrivateJson(file, {
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
  if (read.status !== STATE_OK || !read.value || typeof read.value !== 'object') return null
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
 * The plugin's own server setting (and connect-at-startup choice), wherever this process
 * can reach them, or null.
 *
 * A hook is handed them in its environment, and that wins. Anything else Claude Code
 * starts for the session — a Bash tool call, a monitor — finds the conversation id the
 * SessionStart hook exported and reads that conversation's file.
 */
export function pluginSettingsFromEnv(env = process.env, { dir = SESSION_SETTINGS_DIR } = {}) {
  // Only the server option proves this process was handed the settings: the session
  // environment re-exports CONNECT_AT_STARTUP to every Bash tool call, which must still
  // read the server from the conversation's file.
  if (firstValue(env, URL_KEYS) !== null) return { ...pluginSettingsFromHookEnv(env), carried: 'hook_environment' }
  const sessionId = sanitizeSessionId(env?.[PLUGIN_SETTINGS_SESSION_VAR])
  const filed = sessionId ? readSessionSettings(sessionId, { dir }) : null
  if (!filed) {
    const fromHook = pluginSettingsFromHookEnv(env)
    return fromHook ? { ...fromHook, carried: 'hook_environment' } : null
  }
  return {
    mcp_url: (typeof filed.mcp_url === 'string' && filed.mcp_url.trim()) || DEFAULT_PLUGIN_MCP_URL,
    ...(filed.connect_at_startup === undefined ? {} : { connect_at_startup: filed.connect_at_startup }),
    carried: 'session_file',
  }
}
