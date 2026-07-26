# Changelog

All notable changes to this plugin are documented here. This project follows [Semantic Versioning](https://semver.org).

## 0.6.2 - 2026-07-26

### Remote control — screenshots you send from your phone now actually arrive

- **Attachments on an owner command are saved as real files and handed to the model as a path**, instead of being dumped into the turn as base64. Previously the wake payload carried the server's raw `content` *and* its `dataUrl` — the same bytes twice. A 500KB screenshot measured at **1.37MB of stdout, roughly 341,000 tokens** of base64 that the model still could not see as an image. It is now **589 bytes** and a path the host can open, with the decoded file written to `~/.devspec/remote-control/connections/<id>.attachments/`.
- **Small text attachments stay inline** (under 2KB) — a file path for a 30-byte note helps nobody.
- **Nothing is dropped silently.** If an attachment cannot be written to disk, the descriptor says so and points at `get_session_transcript`, rather than quietly omitting it.
- Filenames are sanitised, so an attachment called `../../etc/passwd` lands as `passwd` inside the attachment directory and nowhere else.

## 0.6.1 - 2026-07-26

### Remote control — a dropped agent now says *why* it dropped

- **`owner_gone` is no longer reported as `local_stop`.** When the poller detects that its host process has died it tears itself down — but it stamped that with the same `local_stop` value the server gets when you deliberately run `/devspec.remote-stop`. On staging that made 117 connection ends indistinguishable, so "why do agents disconnect mid-conversation?" could not be answered from the data at all. The two are now separate reasons, and the Agents page says "The agent process exited" rather than "Local agent disconnected".
- **A relaunch still resumes your agent.** `owner_gone` is a *recoverable* end, so re-running `/devspec.remote` after Claude Code exits reconnects the same connection instead of registering a fresh one with a new codename. (Had it been added as a new reason without this, every restart would have silently become a new agent.)
- **Requires DevSpec staging with `owner_gone` in the `heartbeat_connection` enum.** An end reason the server does not recognise is discarded rather than rejected, which would skip the sticky end and leave a zombie "Live" chip — so the server change ships first.

### Internal

- The seed/advisory split is now covered by tests rather than only by a comment: `splitRoomWindow` asserts that a cold launch filters the **command** half only and never the advisory half, which is the invariant that makes a reconnecting agent arrive oriented.

## 0.6.0 - 2026-07-25

### Remote control — long-poll transport, and the room arrives with the command

- **The polling interval is gone.** One held `poll_connection` call replaces the old three-call tick (`heartbeat_connection` + `get_connection_dispatch` + `get_session_transcript`). The server holds the request open (~25s) and answers the instant something lands: **~2 requests/min instead of 8, and ~0 delivery latency instead of up to 15s.** Fixed intervals survive only as error/empty-turn backoff.
- **Room context is now delivered WITH the command.** A wake payload begins with a labelled `room_context` event — `owner_ambient` (your owner talking in the room, but not to you) and `room_context` (teammates, Dev, other agents) — followed by the command last. Previously advisory was written to a side file and reading it was an instruction the model had to remember; an agent could hold "1", "2", "3" on disk and still fail to answer "what's the next number?". Because a long-poll returns the instant anything arrives, the poller carries advisory forward since the last command so it is genuinely there when the command lands.
- **Reconnect arrives oriented.** A cold launch or a server-side reattach asks for the bounded catch-up window, writes it as advisory and seeds the carry buffer — so the first command after reconnecting already has the room. Already-answered history is still filtered out of the commands, so reconnecting never re-wakes a finished turn.
- **Commands state their addressee.** Every delivered command carries `addressed_to` (agent name · codename · connection id) and an `authority` stamp, and the poller **refuses** anything not addressed to it. Two of your agents in one room can no longer be confused for each other, and a misroute is visible instead of silent.
- Teardown is faster: a held request is aborted the moment the owning agent process dies, and every request now has a hard client-side timeout, so a dropped network can no longer wedge a poller with no heartbeat.
- The shared hook layer's sync process now honours **plugin-owned files**: a plugin that has genuinely diverged from the canonical (Grok Build's host-token, hook-envelope and local-id handling) is reported and skipped rather than silently overwritten.


## 0.5.2 - 2026-07-24

### Remote control — never drop owner mail that arrives mid-turn

- `devspec-remote-wait` **defaults to resuming from `inbox_byte_offset`** (not EOF).
- `/devspec.remote`: **re-arm with `--pending`** after every wake. `--from-end` is first-connect only.
- Live bug: re-arming with `--from-end` after a wake skipped owner commands the poller had already written while the agent was mid-turn.

## 0.5.1 - 2026-07-24

### Remote control — agent-canonical, connection-scoped, session optional

- **Answers:** when attached, post via `post_session_message({ connection_id })` (server resolves current session / reattach-safe). Sessionless: assignment / `report_progress` only — never invent a room.
- **Stop hooks:** busy/heartbeat + optional local_prompt only — **no** full assistant text as primary path (no dual writers).
- **`/devspec.work --remote`:** defaults **sessionless**; optional `--session` / `--new` for a transcript.
- **Delivery contract:** skills/commands align with DevSpecV2 `docs/REMOTE-CONTROL-DELIVERY-CONTRACT.md` (ADR b98a39a9).

## Unreleased

- **Token docs — one account-wide token, reusable everywhere:**
 the README now points token creation at **You → Connections → Connect a tool** (was the stale "Settings → API"), corrects the storage note (macOS Keychain vs an encrypted credentials file on Linux/Windows), explains the plugin bundles the MCP server so there's nothing to add to `.mcp.json`, and documents entering/changing the token via `/plugin` → **Installed** → **DevSpec**. Reflects the new model: one account-wide token, reused in every tool and revealable again any time from You → Connections.
- **Remote control reads the room on connect:** `/devspec.remote` now tells the connected agent to **read the session transcript for context** on connect/attach (not just seed a cursor) and resolve context-dependent first instructions ("help with all this", "carry on", "the thing we discussed") against it before asking the owner to re-explain — so the agent arrives oriented instead of blind. Advisory history (in-session AI, teammates) is readable context for comprehension, never a command surface; command authority is unchanged.
- **Remote dispatch — work a dispatched assignment:** `/devspec.remote` now runs the DevSpec assignment protocol when an owner dispatch carries an assignment reference — `get_assignment` → `acknowledge_assignment` → `claim_work_item` (each reserved member, in order; a claim reserved for someone else is a non-fatal skip) → implement + `record_implementation` → `resolve_assignment`. The command's allow-list gains the assignment + work-execution tools, and the autopilot skill gains the three assignment tools for staged-batch routing.
- **Agent-authoritative remote-control "working" state:** the connected agent now reports `busy:true` on turn start (plus a turn marker) and `busy:false` on turn end/interrupt; the long-lived poller re-asserts busy while a turn runs so long turns stay "working" and an interrupted turn decays instead of stranding a phantom "working". Poller backoff gains a `dormant` (~hourly) tier and the idle-disconnect lifetime extends from 24h to 72h.
- Renamed the GitHub repository to [`DevSpecAI/devspec-claude-plugin`](https://github.com/DevSpecAI/devspec-claude-plugin) (was `claude-code-devspec-autopilot`).
- Renamed the plugin id to `devspec` and the marketplace id to `devspec` (was `devspec-autopilot` / `devspec-autopilot-marketplace`). Slash commands are now `/devspec:<command>`. Existing installs migrate via marketplace `renames` (`devspec-autopilot` → `devspec`); re-add the marketplace if your local catalog still uses the old name.
- Install: `/plugin marketplace add DevSpecAI/devspec-claude-plugin` then `/plugin install devspec@devspec`.
- Rewrote `README.md` for the full product surface (MCP token setup, interactive work, Agents remote control, autopilot) instead of an autopilot-only pitch.

## 0.5.0 - 2026-07-13

Zero-config MCP setup and production cleanup.

- **Auto-wire the DevSpec MCP server.** The plugin now declares the `devspec` MCP server in its manifest (`https://devspec.ai/api/mcp`) and prompts for **only your API token** via `userConfig` (`sensitive`, stored in the OS keychain) on enable. No more hand-editing `.mcp.json`. A `devspec` server you define yourself still takes precedence, so staging/self-host overrides keep working.
- Remote-control token resolution now also reads the keychain token (`CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN`) as a lowest-priority fallback, so the poller/hooks authenticate for marketplace-installed users.
- Turn-mirroring hooks are guarded with `command -v node` — a session without Node.js is a silent no-op instead of a per-turn hook error.
- `/devspec.remote` now runs a `node --version` preflight with clear install guidance (incl. the native-installer caveat).
- Removed the unused v1 autopilot engine and npm scaffolding (`src/`, `dist/`, `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`) and stale template files (`examples/`, scheduler icon). The plugin is Markdown skills/commands + dependency-free Node hook scripts — no build step. Tests run with `node --test hooks/scripts/*.test.mjs`.

## 0.4.1 - 2026-07-13

Marketplace-readiness pass.

- Aligned the version across `plugin.json`, `.claude-plugin/marketplace.json`, and `package.json` (previously drifted).
- Added `displayName`, `homepage`, and `repository` to the plugin manifest.
- Rewrote the README: production MCP URL (`https://devspec.ai/api/mcp`), full command list with correct `/devspec-autopilot:<command>` namespacing, accurate project structure, and clearer Node.js prerequisites.

## 0.4.x - remote control

- Added `/devspec.remote` and `/devspec.remote-stop` for DevSpec Agents-page remote control.
- Conversation-scoped remote bonds; long-lived poller that keeps heartbeating through owner instructions.
- Mechanical turn mirroring via `Stop` / `UserPromptSubmit` hooks.

## 0.2.x - initial autopilot

- Autopilot polling loop: claim staged action items, implement in isolated worktrees, test, push/merge, and report back to DevSpec.
- Planning mode ("Request Agent Plan").
- Terminal companions: `/devspec.work`, `/devspec.create`, `/devspec.commit`, `/devspec.link`, `/devspec.done`, `/devspec.help`.
