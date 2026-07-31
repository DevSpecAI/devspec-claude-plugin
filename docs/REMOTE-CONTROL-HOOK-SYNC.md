# Remote-control hook layer — what is shared, and what is not

**Direction (2026-07-31, owner-set): the plugin families are independent
implementations.** We no longer treat the Claude Code plugin as canonical and port its
scripts outward. That practice produced a recurring cycle — fix one host, port the fix,
break a second host, port *that* fix, introduce a third bug — and the churn cost more
than the duplication it was avoiding.

What is shared lives **on the DevSpec side**:

- the **MCP tool contract** — `register_connection`, `poll_connection`,
  `post_session_message`, the assignment protocol
- the **inbox format** a poller writes and a waker reads — `owner_messages` vs
  `advisory_context`, and the byte-offset cursor
- the **delivery contract** — the agent posts answers; Stop does **not** full-mirror
  assistant text (monorepo `docs/REMOTE-CONTROL-DELIVERY-CONTRACT.md`, ADR `b98a39a9`).
  Nothing here may re-introduce dual-writer full-turn Stop mirroring.
- the **behaviour a connection must exhibit** — appear on the Agents page, accept
  dispatch, wake on an owner command, never act on advisory context, and report
  honestly when it cannot hear
- the **skills** (`commands/*.md`) — what the agent is asked to achieve

What is **not** shared is how a given host achieves it. The wake mechanism, the
turn-lifecycle hooks, the token location and conversation-id resolution are properties
of the **host**. A plugin is free to diverge there — and *should*, rather than contorting
one file to satisfy five hosts.

Identity drift is still a real hazard and still centrally solved: the agent name lives in
one generated file (see below), which is what stopped Cursor from connecting as "Grok
Build" (item `f99bc20b`). Independence applies to mechanism, not to identity.

## What the sync still does

`scripts/sync-hooks.mjs` survives as a narrow tool for the few files that genuinely are
host-independent, plus the generated identity file. **Prefer moving a file to
`HOST_OWNED` over adding per-host branches to a shared one.**

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
| **Universal** | `mcp-call.mjs` | all plugins (every family) |
| **Host-owned** | `devspec-remote-wait.mjs` — the wake channel | nobody; every family keeps its own |
| **Local-poller** | `devspec-remote-poll.mjs`, `mirror-turn.mjs`, `remote-control-state.mjs`, `resolve-mcp-auth.mjs` (each one's test rides along) | local-poller plugins that have not diverged |
| **Generated** | `agent-identity.mjs` | all plugins — written from config `name` |
| **Plugin-owned** (`owns`) | per-plugin escape hatch, e.g. Cursor's `resolve-mcp-auth.mjs` | not synced |
| **Bridge-owned** | (for bridge plugins) their own `poll` / `mirror` / `state` / `resolve-mcp-auth` | not synced |

### Why the wake channel is host-owned

How you wake a model is the most host-specific thing in the whole plugin, and treating it
as universal is what produced item `be0a929a`:

- **Claude Code** reaps tracked background tasks at turn end. Exit-to-wake there ties the
  listener's lifetime to the *turn*: a perfectly compliant agent arms, gets reaped, is
  blocked by the Stop hook, re-arms, gets reaped — one model turn per lap, with no exit.
  Claude Code therefore arms `--stream` under a **persistent monitor**, where the wake is
  a stdout *line* and the arm is session-scoped.
- **Grok Build**'s monitor tool already turns every stdout line into a model-visible
  event — the same shape, arrived at independently.
- **Codex** is an app-server bridge with no local waker at all.

No single file is correct for all three. Syncing one would push Claude Code's default onto
hosts that cannot honour it, which is exactly the port-a-fix-break-another-host cycle the
direction above ends.

## Plugin families

- **Local-poller** (Claude Code, Grok Build, Cursor, Antigravity): a long-lived local
  poller drives liveness and owner-message delivery; `mirror-turn.mjs` handles the turn
  lifecycle and heartbeats. They started from a common implementation and may share it
  where nothing host-specific is involved — but a family diverging is now an expected
  outcome, not a failure to be corrected. Declare it (`owns` / `HOST_OWNED`) instead of
  letting it read as drift.
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

## Why the still-shared files are safe to share

These are the cases where one implementation genuinely serves every host, so sharing costs
nothing. Anything that stops being true here should move to `HOST_OWNED` rather than grow
a per-host branch.

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
