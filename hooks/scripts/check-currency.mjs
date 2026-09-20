#!/usr/bin/env node
/**
 * check-currency — is what Claude Code RUNS the version this checkout declares?
 *
 * Claude Code serves hooks from a version-keyed cache:
 *   ~/.claude/plugins/cache/<marketplace>/<plugin>/<VERSION>/
 * The cache refreshes only when the manifest version changes and only at host
 * startup. Anything invoked by explicit path (wait script, connect, the poller)
 * runs from THIS checkout instead, so hooks and path-invoked scripts can be on
 * different versions at the same time. This reports both.
 *
 * Run from the repo root:  node hooks/scripts/check-currency.mjs
 * Exit 0 = current, non-zero = stale (or unreadable).
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const repo = process.cwd()
const home = os.homedir()

const isDir = (p) => {
  try { return statSync(p).isDirectory() } catch { return false }
}
function git(args) {
  try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim() } catch { return '' }
}

// The plugin version a fresh install would materialise (the cache dir is keyed
// on it). Read plugin.json first; marketplace.json is the fallback.
function manifestVersion() {
  for (const f of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']) {
    const p = join(repo, f)
    if (!existsSync(p)) continue
    try {
      const v = JSON.parse(readFileSync(p, 'utf8')).version
      if (v) return v
    } catch {}
  }
  return null
}

// Every cached devspec plugin version on this machine. The marketplace dir and
// plugin dir are legacy-named on some installs (devspec-autopilot-marketplace /
// devspec), so match on the plugin dir containing "devspec" rather than a
// hard-coded name.
function cachedVersions() {
  const found = []
  const root = join(home, '.claude', 'plugins', 'cache')
  if (!existsSync(root)) return found
  for (const mp of readdirSync(root)) {
    const mpDir = join(root, mp)
    if (!isDir(mpDir)) continue
    for (const plugin of readdirSync(mpDir)) {
      const pDir = join(mpDir, plugin)
      if (!isDir(pDir) || !plugin.toLowerCase().includes('devspec')) continue
      for (const ver of readdirSync(pDir)) {
        const vDir = join(pDir, ver)
        if (isDir(vDir)) found.push({ marketplace: mp, plugin, version: ver, path: vDir })
      }
    }
  }
  return found
}

const manifest = manifestVersion()
const cached = cachedVersions()
const cachedVersionsList = cached.map((c) => c.version)

git(['fetch', '--quiet', 'origin', 'staging'])
const head = git(['rev-parse', 'HEAD'])
const originStaging = git(['rev-parse', 'origin/staging'])

console.log('host: Claude Code')
console.log(`manifest version (what a fresh install runs): ${manifest ?? 'UNKNOWN'}`)
console.log('cached hook versions (what hooks actually run):')
if (cached.length === 0) console.log('  (none found under ~/.claude/plugins/cache)')
for (const c of cached) console.log(`  ${c.version}  ${c.path}`)
console.log(`checkout HEAD (what path-invoked scripts run): ${head || 'UNKNOWN'}`)
console.log(`origin staging: ${originStaging || 'UNKNOWN'}`)

const hooksCurrent = manifest !== null && cachedVersionsList.includes(manifest)
const checkoutCurrent = head !== '' && originStaging !== '' && head === originStaging

console.log(`hooks currency: ${hooksCurrent ? 'CURRENT' : 'STALE'}`)
console.log(`path-invoked currency: ${checkoutCurrent ? 'CURRENT' : 'STALE'}`)

process.exit(hooksCurrent && checkoutCurrent ? 0 : 1)
