#!/usr/bin/env node
/**
 * The only reader/writer for remote-control JSON state that can contain bearer or
 * per-connection capability secrets. Existing files are repaired to owner-only mode
 * before any byte is read; mode is reasserted after every write because opening an
 * existing file with `{ mode: 0o600 }` does not change its prior permissions.
 */

import fs from 'node:fs'
import path from 'node:path'

export function readPrivateJson(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null
    fs.chmodSync(filePath, 0o600)
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

export function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600)
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}
