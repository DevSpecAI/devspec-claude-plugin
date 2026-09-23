/**
 * Shared facts about the listener Claude Code starts with the session (item b7ef1fe2),
 * kept apart from the listener itself so the state CLI and the session hooks can read
 * them without importing the listener (which imports them).
 *
 * Two files:
 *   - `connections/<id>.listener.json` — "a startup listener holds this connection's
 *     wake, and this is its pid". Liveness is proved by the pid, never by the file.
 *   - `startup/<session>.json` — the plugin's settings as the SessionStart hook saw
 *     them, for a listener that starts before the session environment reaches it.
 *
 * ## Why /clear needs this at all
 *
 * Measured on Claude Code 2.1.280: `/clear` and `/resume` give the conversation a new
 * id, run SessionEnd for the old one and SessionStart for the new one — and leave a
 * plugin monitor running. The listener therefore outlives the conversation that
 * registered it. Before this, SessionEnd disabled the old conversation's connection,
 * which ended the listener's stream: the agent stayed on the Agents page and heard
 * nothing. Now SessionEnd keeps a connection whose startup listener is alive, and
 * SessionStart moves the bond to the new conversation so the turn hooks find it.
 */

import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { readPrivateJsonResult, STATE_OK, writePrivateJson } from './private-state.mjs'

const REMOTE_DIR = path.join(os.homedir(), '.devspec', 'remote-control')
const CONNECTIONS_DIR = path.join(REMOTE_DIR, 'connections')
export const STARTUP_DIR = path.join(REMOTE_DIR, 'startup')

/** SessionEnd reasons after which the same Claude Code process carries on. */
export const CONVERSATION_SWITCH_REASONS = new Set(['clear', 'resume'])

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !!e && e.code === 'EPERM'
  }
}

/** Command name of a pid, or null. Linux reads /proc; everything else asks `ps`. */
function commandOf(pid) {
  try {
    if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
    if (process.platform === 'win32') return null
    return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim()
  } catch {
    return null
  }
}

function parentOf(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      // Field 4, after the parenthesised command name (which may itself contain spaces).
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return Number.parseInt(after[1], 10) || null
    }
    if (process.platform === 'win32') return null
    return Number.parseInt(
      execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim(),
      10,
    ) || null
  } catch {
    return null
  }
}

const looksLikeClaude = (name) => typeof name === 'string' && /(^|\/)claude(\.exe)?$/i.test(name.trim())

/**
 * The Claude Code process this listener belongs to — the anchor every remote-control
 * process uses to prove it should still exist.
 *
 * Claude Code puts its own pid in `CLAUDE_PID` for the processes it starts. That value
 * is inherited by anything those processes start in turn, including a nested `claude`,
 * so it is only trusted when it is alive AND is an ancestor of this process. Otherwise
 * the ancestry is walked to the nearest process named `claude`.
 */
export function resolveClaudePid(env = process.env, { startPid = process.pid, maxHops = 12 } = {}) {
  const ancestors = []
  let cursor = startPid
  for (let i = 0; i < maxHops && cursor && cursor > 1; i++) {
    const parent = parentOf(cursor)
    if (!parent || parent === cursor) break
    ancestors.push(parent)
    cursor = parent
  }
  const claimed = Number.parseInt(String(env.CLAUDE_PID ?? ''), 10)
  if (Number.isInteger(claimed) && claimed > 1 && pidAlive(claimed) && ancestors.includes(claimed)) {
    return claimed
  }
  for (const pid of ancestors) {
    if (looksLikeClaude(commandOf(pid))) return pid
  }
  // No ancestry to read (Windows): fall back to the claim alone if it is alive.
  if (ancestors.length === 0 && Number.isInteger(claimed) && claimed > 1 && pidAlive(claimed)) return claimed
  return null
}

export function listenerMarkerPath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.listener.json`)
}

export function writeListenerMarker(connectionId, { pid = process.pid, ownerPid = null, localId = null, dir = CONNECTIONS_DIR } = {}) {
  writePrivateJson(listenerMarkerPath(connectionId, dir), {
    kind: 'startup',
    connection_id: connectionId,
    pid,
    owner_pid: ownerPid,
    local_id: localId,
    started_at: new Date().toISOString(),
  })
}

/** The live startup listener's marker for a connection, or null. */
export function readLiveStartupListener(connectionId, dir = CONNECTIONS_DIR) {
  if (!connectionId) return null
  const read = readPrivateJsonResult(listenerMarkerPath(connectionId, dir))
  if (read.status !== STATE_OK || read.value?.kind !== 'startup') return null
  return pidAlive(Number(read.value.pid)) ? read.value : null
}

export function startupListenerAlive(connectionId, dir = CONNECTIONS_DIR) {
  return readLiveStartupListener(connectionId, dir) !== null
}

/**
 * The connection a live startup listener holds on behalf of one Claude Code process,
 * or null. One Claude Code process runs one listener, so its pid is the key that
 * survives the conversation id changing underneath it.
 */
export function findStartupListenerForOwner(ownerPid, dir = CONNECTIONS_DIR) {
  if (!Number.isInteger(ownerPid) || ownerPid <= 1) return null
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  for (const name of names) {
    if (!name.endsWith('.listener.json')) continue
    const connectionId = name.slice(0, -'.listener.json'.length)
    const marker = readLiveStartupListener(connectionId, dir)
    if (marker && Number(marker.owner_pid) === ownerPid) return marker
  }
  return null
}

export function startupFilePath(sessionId, dir = STARTUP_DIR) {
  return path.join(dir, `${String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '')}.json`)
}

/** File the plugin's settings for this session's listener. Never throws. */
export function writeStartupConfig(sessionId, config, { dir = STARTUP_DIR } = {}) {
  if (!sessionId || !config?.token) return false
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    writePrivateJson(startupFilePath(sessionId, dir), { ...config, written_at: new Date().toISOString() })
    return true
  } catch {
    return false
  }
}

export function removeStartupConfig(sessionId, { dir = STARTUP_DIR } = {}) {
  if (!sessionId) return
  try {
    fs.rmSync(startupFilePath(sessionId, dir), { force: true })
  } catch {
    /* best effort */
  }
}
