#!/usr/bin/env node
/**
 * The only reader/writer for remote-control JSON state that can contain bearer or
 * per-connection capability secrets. Existing files are repaired to owner-only mode
 * before any byte is read; mode is reasserted after every write because opening an
 * existing file with `{ mode: 0o600 }` does not change its prior permissions.
 *
 * WRITES ARE ATOMIC, and that is a correctness property rather than tidiness
 * (item 3b88955e). Three processes write one connection's state concurrently — the
 * poller loop, the wait stream and the Stop hook — and an in-place `writeFileSync`
 * truncates the real file before it writes a byte. A reader landing in that window
 * used to get a JSON parse error, which this module reported as `null`: exactly what
 * it reports for a file that does not exist. Both patch helpers then treated "no
 * state" as "empty state" and wrote back an object holding only their own fields,
 * so one unlucky interleaving permanently destroyed the bond — local_id, owner_pid,
 * the token. With the bond gone the Stop hook can no longer tell which connection
 * this conversation is, the `.turn` marker is never cleared, and the driver watches
 * Working tick up for an hour on an agent that answered minutes ago.
 *
 * So: write a sibling temp file and rename it into place (atomic within a
 * directory on POSIX, and MoveFileEx with replace on Windows), and give callers
 * `readPrivateJsonResult` so they can tell an absent file from an unreadable one
 * and decline to overwrite what they could not read.
 */

import fs from 'node:fs'
import path from 'node:path'

/** A file that is not there. Safe to treat as empty state. */
export const STATE_ABSENT = 'absent'
/** Parsed cleanly. `value` is the state. */
export const STATE_OK = 'ok'
/**
 * The file EXISTS but could not be read or parsed — a torn read against a writer,
 * a truncated file, corruption. Never safe to treat as empty: whatever is in there
 * belongs to someone, and writing over it is how the bond gets lost.
 */
export const STATE_UNREADABLE = 'unreadable'

/**
 * Read remote-control state, saying WHICH kind of nothing it found.
 * Returns `{ status, value }`; `value` is null unless status is `ok`.
 */
export function readPrivateJsonResult(filePath) {
  if (!filePath) return { status: STATE_ABSENT, value: null }
  try {
    if (!fs.existsSync(filePath)) return { status: STATE_ABSENT, value: null }
  } catch {
    return { status: STATE_UNREADABLE, value: null }
  }
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    /* mode repair is best-effort; a readable file is still worth reading */
  }
  try {
    return { status: STATE_OK, value: JSON.parse(fs.readFileSync(filePath, 'utf8')) }
  } catch {
    return { status: STATE_UNREADABLE, value: null }
  }
}

/**
 * Lenient read — the state, or null for both "absent" and "unreadable".
 * Unchanged for every existing caller. Anything that goes on to WRITE the file back
 * must use `readPrivateJsonResult` instead, or it cannot tell the difference between
 * a connection that has no state and one whose state it is about to destroy.
 */
export function readPrivateJson(filePath) {
  const result = readPrivateJsonResult(filePath)
  return result.status === STATE_OK ? result.value : null
}

/**
 * Rename retries. Windows can refuse the replace while another process still holds
 * the destination open, and these files are read by two or three processes at a
 * time. A few short retries cover that; after them the write fails loudly rather
 * than falling back to a truncating write, because a stalled cursor costs one
 * repeated delivery and a torn bond costs an hour of phantom Working.
 */
const RENAME_ATTEMPTS = 5
const RENAME_BACKOFF_MS = 20

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  // Same directory as the destination: rename is only atomic within one filesystem.
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    // The temp file carries 0600 through the rename, so the destination never
    // exists in a permissive state — not even for an instant.
    fs.chmodSync(tmp, 0o600)
    let lastError = null
    for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
      try {
        fs.renameSync(tmp, filePath)
        return
      } catch (e) {
        lastError = e
        if (attempt < RENAME_ATTEMPTS - 1) sleepSync(RENAME_BACKOFF_MS)
      }
    }
    throw lastError
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true })
    } catch {
      /* the rename already consumed it, or the directory went away */
    }
  }
}

/**
 * Merge `patch` into an existing state file and write it back atomically.
 *
 * Returns `true` when the file was written, `false` when it was left alone because
 * it exists and could not be read. A caller that cannot read the current state has
 * nothing to merge into and must not invent one — see STATE_UNREADABLE.
 */
export function patchPrivateJson(filePath, patch) {
  const current = readPrivateJsonResult(filePath)
  if (current.status === STATE_UNREADABLE) return false
  writePrivateJson(filePath, { ...(current.value ?? {}), ...patch })
  return true
}
