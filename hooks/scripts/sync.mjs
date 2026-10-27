#!/usr/bin/env node
/**
 * sync — pull origin/staging, then confirm what Claude Code actually runs.
 *
 * Claude Code serves hooks from a version-keyed cache that refreshes only at
 * host startup and only when the manifest version changed, so a pull here does
 * NOT refresh hooks. Restarting Claude Code is the install step, and it is
 * manual; this script reports it rather than pretending to do it.
 *
 * Usage: node hooks/scripts/sync.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`.trim()
  }
}

console.log('== Claude Code: pull origin staging ==')
console.log(sh('git', ['pull', '--ff-only', 'origin', 'staging']) || 'Already up to date.')
console.log('')

const check = spawnSync('node', [join(repo, 'hooks', 'scripts', 'check-currency.mjs')], { cwd: repo, stdio: 'inherit' })
if ((check.status ?? 1) !== 0) {
  console.log('Next step: restart Claude Code completely. Hooks re-sync from the cache at startup, landing next session, never this one.')
}
process.exit(check.status ?? 1)
