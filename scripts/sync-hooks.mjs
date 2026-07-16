#!/usr/bin/env node
/**
 * sync-hooks.mjs — propagate the shared remote-control hook layer from the
 * canonical Claude Code plugin to every downstream DevSpec plugin.
 *
 * WHY THIS EXISTS
 * ---------------
 * The `hooks/scripts/*.mjs` layer used to be hand-copied per plugin and drifted
 * badly — including hardcoded agent-name fallbacks that made one plugin post
 * under another's name (see action item f99bc20b). This script makes the Claude
 * Code plugin the single source of truth and copies the shared files verbatim,
 * so a fix lands in one place and propagates everywhere instead of drifting.
 *
 * THE MODEL (see docs/REMOTE-CONTROL-HOOK-SYNC.md for the full policy)
 * -------------------------------------------------------------------
 * Files fall into tiers:
 *
 *   UNIVERSAL   — pure transport/wait, identical for every tool. Synced to ALL
 *                 plugins (local-poller AND bridge).
 *   LOCAL_POLLER— the local-poller remote-control implementation. Synced to the
 *                 pure-local plugins (Grok Build, Cursor, Antigravity). NOT sent
 *                 to bridge-family plugins, which own a different implementation.
 *   GENERATED   — agent-identity.mjs. The ONE per-plugin value (the name). This
 *                 script writes it from the config `name`; it is never hand-kept.
 *   BRIDGE-OWNED— for bridge-family plugins (Codex), the poll/mirror/state/auth
 *                 files are a genuinely different (app-server-bridge) design and
 *                 are left untouched. The script prints a reminder so a maintainer
 *                 reconciles shared-concern changes into them by hand.
 *
 * Adaptations that USED to force divergence are gone:
 *   - agent name  → externalised to agent-identity.mjs (GENERATED here)
 *   - conv-id env → the canonical scripts already probe every tool's env var
 *   - Claude-only token source (CLAUDE_PLUGIN_OPTION_*) in resolve-mcp-auth is a
 *     harmless no-op where that env var is never set, so the file stays shared.
 *
 * USAGE
 *   node scripts/sync-hooks.mjs            # write: bring every plugin current
 *   node scripts/sync-hooks.mjs --check    # report drift, write nothing, exit 1 if any
 *   node scripts/sync-hooks.mjs --dry-run  # alias for --check
 *
 * The downstream plugin repos must be checked out as siblings under the same
 * parent directory as this repo's "DevSpec Autopilot Plugin" folder. Override
 * the parent with DEVSPEC_PLUGINS_ROOT if your layout differs.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLAUDE_ROOT = path.join(__dirname, '..') // .../claude-code-devspec-autopilot
const CANONICAL_HOOKS = path.join(CLAUDE_ROOT, 'hooks', 'scripts')

// Parent directory that holds all plugin repos. Default layout:
//   <root>/DevSpec Autopilot Plugin/claude-code-devspec-autopilot   (this repo)
//   <root>/devspec_grok_build_extension
//   <root>/Cursor plugin/cursor-devspec-plugin
//   <root>/Antigravity extension/antigravity-devspec-autopilot-extension
//   <root>/DevSpec_Codex_Plugin
const PLUGINS_ROOT =
  process.env.DEVSPEC_PLUGINS_ROOT || path.join(CLAUDE_ROOT, '..', '..')

// Files that are identical for every tool (transport + wait).
const UNIVERSAL = ['mcp-call.mjs', 'devspec-remote-wait.mjs']

// The local-poller remote-control implementation + its tests.
const LOCAL_POLLER = [
  'devspec-remote-poll.mjs',
  'mirror-turn.mjs',
  'remote-control-state.mjs',
  'resolve-mcp-auth.mjs',
  'mirror-turn.test.mjs',
  'remote-control-state.test.mjs',
]

// Downstream plugins. `hooksDir` is relative to PLUGINS_ROOT. Add a new plugin
// here — nothing else — and it joins the sync. `family: 'bridge'` means the
// plugin owns its poll/mirror/state/auth (Codex's app-server bridge model).
const PLUGINS = [
  {
    name: 'Grok Build',
    hooksDir: path.join('devspec_grok_build_extension', 'hooks', 'scripts'),
    family: 'local-poller',
  },
  {
    name: 'Cursor',
    hooksDir: path.join('Cursor plugin', 'cursor-devspec-plugin', 'hooks', 'scripts'),
    family: 'local-poller',
  },
  {
    name: 'Antigravity',
    hooksDir: path.join(
      'Antigravity extension',
      'antigravity-devspec-autopilot-extension',
      'hooks',
      'scripts',
    ),
    family: 'local-poller',
  },
  {
    name: 'Codex',
    hooksDir: path.join('DevSpec_Codex_Plugin', 'plugins', 'devspec-autopilot', 'hooks', 'scripts'),
    family: 'bridge',
  },
]

/**
 * The GENERATED per-plugin identity file. The name is the ONLY per-plugin value.
 * Kept byte-identical to the canonical template so re-running the sync is a
 * no-op once a plugin is current.
 */
function agentIdentitySource(name) {
  return `/**
 * Single source of truth for THIS plugin's agent identity.
 *
 * The agent name is a fixed property of the plugin — not runtime state, not an
 * LLM-passed arg, not a copied fallback. Every script (poller, mirror-turn,
 * remote-control-state) imports AGENT_NAME and uses it as THE identity, so a
 * plugin can never mislabel itself (e.g. as "Grok Build") no matter what's in a
 * stale/foreign state file or whether \`--agent\` was passed. One line to set per
 * plugin; impossible to drift.
 */
export const AGENT_NAME = '${name}'
`
}

const CHECK = process.argv.includes('--check') || process.argv.includes('--dry-run')

let drift = 0
let wrote = 0
const log = (m) => process.stdout.write(m + '\n')

/** Compare desired content to what's on disk; write it unless in --check mode. */
function apply(destFile, desired, label) {
  const current = fs.existsSync(destFile) ? fs.readFileSync(destFile, 'utf8') : null
  if (current === desired) return // already current — nothing to do
  drift++
  if (CHECK) {
    log(`    DRIFT  ${label}${current === null ? ' (missing)' : ''}`)
    return
  }
  fs.mkdirSync(path.dirname(destFile), { recursive: true })
  fs.writeFileSync(destFile, desired, 'utf8')
  wrote++
  log(`    ${current === null ? 'create' : 'update'} ${label}`)
}

function readCanonical(name) {
  return fs.readFileSync(path.join(CANONICAL_HOOKS, name), 'utf8')
}

function main() {
  if (!fs.existsSync(CANONICAL_HOOKS)) {
    console.error(`✗ Canonical hooks dir not found: ${CANONICAL_HOOKS}`)
    process.exit(2)
  }
  log(
    `${CHECK ? 'Checking' : 'Syncing'} shared hook layer from canonical:\n  ${CANONICAL_HOOKS}\n`,
  )

  for (const plugin of PLUGINS) {
    const destDir = path.join(PLUGINS_ROOT, plugin.hooksDir)
    // Only require the repo to exist; the hooks/scripts dir is created on write.
    const repoRoot = destDir.split(path.sep + 'hooks' + path.sep)[0]
    log(`▸ ${plugin.name}  (${plugin.family})`)
    if (!fs.existsSync(repoRoot)) {
      log(`    SKIP — repo not found at ${repoRoot}`)
      continue
    }

    // GENERATED: the one per-plugin file.
    apply(path.join(destDir, 'agent-identity.mjs'), agentIdentitySource(plugin.name), 'agent-identity.mjs')

    // UNIVERSAL: every plugin, every family.
    for (const f of UNIVERSAL) apply(path.join(destDir, f), readCanonical(f), f)

    if (plugin.family === 'local-poller') {
      for (const f of LOCAL_POLLER) apply(path.join(destDir, f), readCanonical(f), f)
    } else if (plugin.family === 'bridge') {
      log(
        '    bridge-owned: poll / mirror / state / resolve-mcp-auth left untouched\n' +
          '      → reconcile shared-concern changes into them by hand (see docs/REMOTE-CONTROL-HOOK-SYNC.md)',
      )
    }
    log('')
  }

  if (CHECK) {
    if (drift > 0) {
      log(`✗ ${drift} file(s) out of sync. Run \`node scripts/sync-hooks.mjs\` to fix.`)
      process.exit(1)
    }
    log('✓ All downstream hook layers are in sync with the canonical.')
    process.exit(0)
  }

  log(wrote > 0 ? `✓ Done — wrote ${wrote} file(s).` : '✓ Done — everything already current.')
}

main()
