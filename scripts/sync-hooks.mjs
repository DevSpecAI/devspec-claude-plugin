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
 * TESTS ARE NOT A TIER — they follow their implementation (item b97a3521). The lists
 * name implementations only; `X.test.mjs` is synced wherever `X.mjs` is, and is
 * plugin-owned wherever `X.mjs` is. Never hand-add a test entry to a list or to an
 * `owns` array: the hand-maintained pairing is exactly what rotted and left Cursor's
 * suite unable to load on main while `--check` reported everything in sync.
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
// List IMPLEMENTATIONS ONLY — a file's canonical test travels with it automatically
// (see withDerivedTests). Never hand-add a `.test.mjs` entry here.
const UNIVERSAL = ['mcp-call.mjs', 'devspec-remote-wait.mjs']

// The local-poller remote-control implementation. Implementations only — see above.
const LOCAL_POLLER = [
  'devspec-remote-poll.mjs',
  'mirror-turn.mjs',
  'remote-control-state.mjs',
  'resolve-mcp-auth.mjs',
]

/**
 * A synced implementation carries its canonical test file with it (item b97a3521).
 *
 * These lists used to name implementations and tests side by side, by hand, and the
 * pairing silently rotted: `resolve-mcp-auth.mjs` was synced while
 * `resolve-mcp-auth.test.mjs` was not, so Cursor kept an older test asserting an
 * export the shared implementation no longer had — its suite could not even load,
 * on main, for days. `devspec-remote-poll.test.mjs` and `devspec-remote-wait.test.mjs`
 * were missing from the lists too, so Antigravity had no copy of either.
 *
 * The failure was invisible from here: a file in NEITHER list is neither drift nor
 * plugin-owned, so `--check` reported everything in sync while a downstream suite
 * was red. Deriving the test from the implementation removes the hand-pairing
 * entirely, so the next shared file added cannot repeat it.
 */
export function withDerivedTests(files, dir = CANONICAL_HOOKS) {
  const out = []
  for (const f of files) {
    out.push(f)
    // A test has no test of its own. Defensive rather than theoretical: if someone
    // re-adds a `.test.mjs` entry to a list by hand — the very habit that caused
    // this bug — deriving from it would ask for `x.test.test.mjs`.
    if (f.endsWith('.test.mjs')) continue
    const test = f.replace(/\.mjs$/, '.test.mjs')
    if (test !== f && fs.existsSync(path.join(dir, test))) out.push(test)
  }
  return out
}

/**
 * Ownership is declared on the IMPLEMENTATION and covers its test implicitly.
 *
 * A plugin that owns `resolve-mcp-auth.mjs` because its host keeps the token
 * somewhere else necessarily owns the test that asserts that behaviour — syncing the
 * canonical test over it would assert the wrong contract against a divergent
 * implementation. Grok Build is the live case: it owns three implementations, and its
 * three tests must stay its own. This is why `owns` lists implementations only.
 */
export function ownsFile(owns, f) {
  const owned = owns instanceof Set ? owns : new Set(owns ?? [])
  return (
    owned.has(f) ||
    (f.endsWith('.test.mjs') && owned.has(f.replace(/\.test\.mjs$/, '.mjs')))
  )
}

/**
 * Every canonical test file must pair with an implementation that is actually
 * synced, or it reaches nobody. Reported rather than silently ignored — a test with
 * no synced impl is the same blind spot as an impl with no synced test.
 */
function orphanCanonicalTests() {
  const synced = new Set([...UNIVERSAL, ...LOCAL_POLLER])
  return fs
    .readdirSync(CANONICAL_HOOKS)
    .filter((f) => f.endsWith('.test.mjs'))
    .filter((f) => !synced.has(f.replace(/\.test\.mjs$/, '.mjs')))
}

// Downstream plugins. `hooksDir` is relative to PLUGINS_ROOT. Add a new plugin
// here — nothing else — and it joins the sync. `family: 'bridge'` means the
// plugin owns its poll/mirror/state/auth (Codex's app-server bridge model).
//
// `owns` is a per-plugin escape hatch for a file the plugin has genuinely diverged
// on, as opposed to merely fallen behind. It is NOT a licence to fork casually — a
// file listed here stops receiving canonical fixes forever, so it must be a file
// whose behaviour is a property of the HOST, not of DevSpec. Listed files are
// reported as plugin-owned instead of counting as drift, and are never written.
const PLUGINS = [
  {
    name: 'Grok Build',
    hooksDir: path.join('devspec_grok_build_extension', 'hooks', 'scripts'),
    family: 'local-poller',
    // Grok Build's host contract really is different, and the blanket sync would
    // have silently destroyed all three (verified 25 Jul, item 27058153):
    //   resolve-mcp-auth  — the token lives in Grok's own config file, not in a
    //                       CLAUDE_PLUGIN_OPTION_* env var.
    //   mirror-turn       — Grok hook stdin is camelCase (sessionId,
    //                       lastAssistantMessage) and its monitor tool turns every
    //                       stdout line into a model-visible event to filter.
    //   remote-control-state — GROK_SESSION_ID local-id detection plus Grok-only
    //                       --force / --force-restart poller controls.
    // Implementations only — each one's test is owned implicitly (see isOwned).
    owns: ['resolve-mcp-auth.mjs', 'mirror-turn.mjs', 'remote-control-state.mjs'],
  },
  {
    name: 'Cursor',
    hooksDir: path.join('Cursor plugin', 'cursor-devspec-plugin', 'hooks', 'scripts'),
    family: 'local-poller',
    // Cursor keeps the DevSpec token in its OWN host config —
    // ~/.cursor/mcp.json, written by the extension's "DevSpec: Set MCP token" —
    // not in a CLAUDE_PLUGIN_OPTION_* env. The canonical resolver reads neither,
    // so a blanket sync leaves remote control unable to authenticate. Cursor owns
    // a tool-aware resolver (reads ~/.cursor/mcp.json); its test travels with it.
    owns: ['resolve-mcp-auth.mjs'],
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
    // Antigravity keeps the token in ~/.gemini/antigravity-cli/mcp_config.json
    // (serverUrl + headers.Authorization), not a CLAUDE_PLUGIN_OPTION_* env — same
    // class as Grok/Cursor. Owns a tool-aware resolver; its test travels with it.
    owns: ['resolve-mcp-auth.mjs'],
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

    const owned = new Set(plugin.owns ?? [])
    const isOwned = (f) => ownsFile(owned, f)

    /** Skip a file this plugin owns, saying so out loud rather than silently. */
    const applyUnlessOwned = (f) => {
      if (isOwned(f)) {
        log(`    plugin-owned ${f} — left untouched`)
        return
      }
      apply(path.join(destDir, f), readCanonical(f), f)
    }

    // GENERATED: the one per-plugin file.
    apply(path.join(destDir, 'agent-identity.mjs'), agentIdentitySource(plugin.name), 'agent-identity.mjs')

    // UNIVERSAL: every plugin, every family. Tests ride along with their impl.
    for (const f of withDerivedTests(UNIVERSAL)) applyUnlessOwned(f)

    if (plugin.family === 'local-poller') {
      for (const f of withDerivedTests(LOCAL_POLLER)) applyUnlessOwned(f)
    } else if (plugin.family === 'bridge') {
      log(
        '    bridge-owned: poll / mirror / state / resolve-mcp-auth (and their tests)\n' +
          '      left untouched — a bridge test asserts the bridge design, not the shared one\n' +
          '      → reconcile shared-concern changes into them by hand (see docs/REMOTE-CONTROL-HOOK-SYNC.md)',
      )
    }
    log('')
  }

  // A canonical test that pairs with no synced implementation reaches nobody. Say so
  // rather than letting it sit outside every list unnoticed — that silence is the
  // whole defect behind b97a3521.
  const orphans = orphanCanonicalTests()
  if (orphans.length > 0) {
    log(
      `⚠ ${orphans.length} canonical test file(s) pair with no synced implementation, so no\n` +
        `  downstream plugin runs them: ${orphans.join(', ')}\n` +
        '  Either add the implementation to UNIVERSAL/LOCAL_POLLER, or delete the test.\n',
    )
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

// Run the CLI only when executed directly. Without this guard, importing the module
// to test its pairing logic would perform a REAL sync across every plugin repo —
// the same footgun already removed from devspec-remote-wait.mjs.
const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) main()
