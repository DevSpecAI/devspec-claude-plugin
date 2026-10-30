/**
 * What every DevSpec git stand-in agrees on, so that two of them on one PATH never
 * take each other for git (item 30978c06).
 *
 * The Claude Code, Pi and Antigravity plugins each put a `git` stand-in first on their
 * agent's PATH. Each used to recognise only its own when looking for the real git, so
 * with two on one PATH (a Pi test run or Pi session started from a Claude Code agent's
 * shell) each picked the other and they handed every call back and forth, a new Node
 * process per hop: about 10 GB in 30 seconds on 2026-10-30, until the machine's
 * low-memory guard killed the agents. The plugins share this as a contract, not a file
 * (convention 1d06cdc6): Pi (item 80bceb2c) and Antigravity (item 65658d3b) implement
 * the same three rules by hand.
 *
 * 1. Every stand-in's `git` file carries STAND_IN_MARKER in its first bytes.
 * 2. Looking for the real git, skip any candidate that carries it.
 * 3. Everything a stand-in starts runs one level deeper (STAND_IN_DEPTH_ENV). A
 *    stand-in started inside another's work runs git straight through, and one started
 *    MAX_STAND_IN_DEPTH deep starts nothing: that bounds a loop with an older or
 *    foreign stand-in that does not follow rules 1 and 2.
 *
 * Imports only Node built-ins: this file is copied next to the stand-in and runs
 * outside the plugin.
 */

import { closeSync, openSync, readSync, realpathSync } from 'node:fs'

export const STAND_IN_MARKER = '# devspec-git-stand-in'
export const STAND_IN_DEPTH_ENV = 'DEVSPEC_GIT_STAND_IN_DEPTH'
/** How far into its file a stand-in's marker must be; the other plugins read this much. */
const MARKER_WINDOW_BYTES = 256
/**
 * How deep stand-ins may nest before one refuses. Real nesting is a stand-in, then git,
 * then a git hook that runs git under a stand-in again: two or three levels. Eight bounds
 * a loop to a few short-lived processes that fail in well under a second.
 */
export const MAX_STAND_IN_DEPTH = 8

/** Whether `file` is a DevSpec git stand-in, whichever plugin wrote it. */
export function isMarkedStandIn(file) {
  let fd = null
  try {
    fd = openSync(realpathSync(file), 'r')
    const head = Buffer.alloc(MARKER_WINDOW_BYTES)
    const read = readSync(fd, head, 0, head.length, 0)
    return head.subarray(0, read).toString('latin1').includes(STAND_IN_MARKER)
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* already closed */ }
    }
  }
}

/** How many stand-ins this process is already nested inside: 0 unless one started it. */
export function standInDepth(env = process.env) {
  const value = String(env[STAND_IN_DEPTH_ENV] ?? '').trim()
  return /^\d{1,6}$/.test(value) ? Number(value) : 0
}

/** What git prints when a stand-in refuses to go deeper. Read by the person and the agent. */
export function loopStoppedText() {
  return 'git: DevSpec stopped this command because two DevSpec plugins were passing it back and forth instead of running git. Nothing was changed. Update the DevSpec plugin for each coding agent you use, then start a new session.'
}
