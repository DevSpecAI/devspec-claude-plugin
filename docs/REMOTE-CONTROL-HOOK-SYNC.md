# Remote-control hook layer — source of truth & sync policy

The remote-control hook scripts (`hooks/scripts/*.mjs`) power the DevSpec
remote-control feature in **every** coding-agent plugin (Claude Code, Grok Build,
Cursor, Antigravity, Codex). They used to be hand-copied per plugin and drifted —
including hardcoded agent-name fallbacks that made one plugin post under another's
name (Cursor connecting as "Grok Build"; action item `f99bc20b`). This document is
the policy that stops that class of drift.

## Source of truth

**This repo — `claude-code-devspec-autopilot/hooks/scripts/` — is the canonical
source for the shared hook layer.** Change a shared script HERE, then run the sync
to propagate it. Never hand-edit a downstream plugin's copy of a shared file.

```bash
node scripts/sync-hooks.mjs          # write: bring every downstream plugin current
node scripts/sync-hooks.mjs --check  # report drift only, exit 1 if any (CI-friendly)
```

Downstream plugin repos must be checked out as siblings under the same parent as
the `DevSpec Autopilot Plugin` folder (override with `DEVSPEC_PLUGINS_ROOT`).

> Note: `cursor-devspec-plugin/scripts/sync-from-claude.mjs` is a **separate**
> tool that syncs *skills* (`commands/*.md` → `skills/`) with per-tool text
> rewrites. It does not touch hooks. Hooks are owned by `sync-hooks.mjs` here.

## File tiers

| Tier | Files | Synced to |
|------|-------|-----------|
| **Universal** | `mcp-call.mjs`, `devspec-remote-wait.mjs` | all plugins (every family) |
| **Local-poller** | `devspec-remote-poll.mjs`, `mirror-turn.mjs`, `remote-control-state.mjs`, `resolve-mcp-auth.mjs`, `mirror-turn.test.mjs`, `remote-control-state.test.mjs` | local-poller plugins only |
| **Generated** | `agent-identity.mjs` | all plugins — written from config `name` |
| **Bridge-owned** | (for bridge plugins) their own `poll` / `mirror` / `state` / `resolve-mcp-auth` | not synced |

## Plugin families

- **Local-poller** (Grok Build, Cursor, Antigravity — and Claude Code as the
  canonical): a long-lived local poller drives liveness and owner-message
  delivery; `mirror-turn.mjs` mirrors turns and heartbeats. These share the
  canonical implementation verbatim.
- **Bridge** (Codex): remote turns are mediated by an app-server bridge. Its
  `mirror-turn.mjs` / `devspec-remote-poll.mjs` / `remote-control-state.mjs`
  implement a genuinely different model (thread-id bonds, `bridge_remote_turn_active`,
  remote-reply suppression, no local heartbeat). These are **intentionally not
  synced**. When a *shared concern* changes in the canonical (e.g. a security fix
  in message-ownership filtering, or the idle-disconnect ladder), reconcile it
  into the bridge files by hand. `sync-hooks.mjs` prints a reminder for each
  bridge plugin.

## The one per-plugin value: the agent name

Identity is a fixed property of the plugin. It lives ONLY in
`agent-identity.mjs`:

```js
export const AGENT_NAME = 'Cursor'
```

Every shared script imports `AGENT_NAME` and uses it unconditionally — never a
`state.agent_name || '<literal>'` fallback and never an `--agent` default. The
sync generates this file from each plugin's `name` in the config, so even the name
cannot drift. To add or rename a plugin, edit the `PLUGINS` array in
`scripts/sync-hooks.mjs` and re-run — that is the only place to touch.

## Why the shared files no longer need per-tool rewrites

- **Conversation id:** `mirror-turn.mjs` resolves the firing conversation via the
  shared `detectLocalId` (probes whichever conversation-id env var the tool exposes
  — `CLAUDE_CODE_SESSION_ID`, `GROK_SESSION_ID`, `CODEX_THREAD_ID`, `TERM/SHELL_SESSION_ID`,
  …), then the hook-stdin `session_id`. This MUST be tool-agnostic — a Claude-only
  resolver silently fail-closes every other plugin's mirror. **Fallback for tools
  that expose no per-conversation id (Cursor, Antigravity):** `selectBoundState`
  selects the single enabled remote session for THIS agent — safe because "exactly
  one" cannot bleed; two+ concurrent sessions of that agent fail closed rather than
  guess. (Confirming a live single-session mirror for those tools is still worth a
  smoke test.)
- **Auth:** `resolve-mcp-auth.mjs` probes env → project `.mcp.json` → `~/.claude.json`
  → the Claude `CLAUDE_PLUGIN_OPTION_*` userConfig token (last, lowest priority).
  That last source is a no-op on tools that never set it, so the file stays shared.
- **Harness guards:** `mirror-turn.mjs`'s injection guard only filters text that a
  specific harness emits; it is a no-op elsewhere, so it lives in the canonical
  for everyone.

## Adding a new plugin

1. Create the repo with a `hooks/scripts/` dir.
2. Add an entry to `PLUGINS` in `scripts/sync-hooks.mjs` (name, `hooksDir`, family).
3. Run `node scripts/sync-hooks.mjs`.
4. Commit the generated hook layer in the new repo.
