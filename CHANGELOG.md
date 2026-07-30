# Changelog

All notable changes to this plugin are documented here. This project follows [Semantic Versioning](https://semver.org).

## 0.6.5 - 2026-07-30

### A remote agent can no longer go silently deaf while telling you it is fine

- **The failure this fixes.** You send your agent a command from your phone. Nothing comes back. The Agents page still says Live and available, so you reasonably conclude the connection dropped and reconnect. Nothing had dropped: the poller was healthy and had delivered every message correctly, but the one-shot listener that turns a delivered message into an actual agent wake-up had not been re-armed, so nobody read them. Delivery depended on the agent remembering a bookkeeping step at the end of every turn, and there was no backstop when it forgot.
- **Why it kept coming back.** The original design had one process that both heartbeated and woke the agent, so losing the waker also lost the heartbeat and the chip went Disconnected — loud and impossible to misread. Moving liveness onto a keeper-managed poller fixed "Live drops while the agent works" and left the wake channel with no keeper at all, so the thing still reporting Live was no longer the thing that wakes you.
- **Stop now refuses to end a turn deaf.** While armed, the wait owns a per-connection pidfile, so the Stop hook can prove whether anything is actually listening — and if a turn is about to end with no listener, or with commands sitting unread, it blocks and hands the agent the re-arm command. The guarantee moved from "the agent remembers" to "the hook enforces". Liveness is proved by a live pid, never by a leftover file, so a hard-killed listener cannot masquerade as a healthy one.
- **A blocked stop keeps you "working".** The turn genuinely has not ended, so the indicator stays on rather than reporting a finish that has not happened.
- **A reaped or aged-out listener no longer reads as a dead connection.** The wait used to exit 1 both for "a human ended this" and for "my arm aged out" — and the documented response to exit 1 is *stop*, so an agent following the instructions correctly tore down a perfectly live connection on a 24-hour rollover. Non-terminal cases now exit **3**, meaning "re-arm me, nothing is wrong", and exit 1 is strictly "a human or the server ended this".
- **The arming instructions now say not to pass a timeout**, since supplying a plausible-looking one was a way for an agent to manufacture this failure itself.

Items `8b4ceaa3`, `d655b2a4`.

> Note for maintainers: `devspec-remote-wait.mjs` is in the sync's UNIVERSAL list, so the next `sync-hooks` run would carry exit 3 to the other plugin families — whose exit tables still document only 0/1/2 and would misread it. Propagate the docs with the code. The `mirror-turn.mjs` change relies on Claude Code's Stop-hook decision control and is not portable as-is.

## 0.6.4 - 2026-07-27

### Every plugin's test suite now actually protects it

- **A shared file's tests travel with it.** The sync lists named implementations and their tests side by side, by hand, and the pairing had rotted: `resolve-mcp-auth.mjs` was synced while its test was not, so the Cursor plugin held an older test asserting an export the shared implementation no longer had — **its suite could not even load, on main**. `devspec-remote-poll.test.mjs` and `devspec-remote-wait.test.mjs` were absent from the lists too, so Antigravity had no copy of either. Tests are now derived from the implementation entry, so the pairing cannot rot again.
- **The failure used to be invisible.** A file in *neither* list counted as neither drift nor plugin-owned, so `--check` reported everything in sync while a downstream suite was red. It now reports a missing downstream test as drift, and warns about a canonical test that pairs with no synced implementation.
- **Owning an implementation now owns its test.** A plugin that keeps its own `resolve-mcp-auth.mjs` because its host stores the token elsewhere keeps the test that asserts that, rather than having the canonical one written over it.
- Result across the family: **Cursor red → 151 passing**, Antigravity 62 → 151, Grok Build 69 → 151 (its three owned tests untouched), Codex 38 → 68 (its own bridge poller test preserved).
- `scripts/sync-hooks.mjs` no longer runs a real sync when imported, and its pairing rules have their own tests.

## 0.6.3 - 2026-07-26

### Remote control — the "working" dots no longer die thirty seconds into a five-minute turn

- **Your agent stays "working" for the whole turn.** Arming the wait for the next command used to be treated as "the agent is idle", so it cleared the turn marker the poller had just written. Because agents are told to re-arm the *instant* they wake — precisely so owner mail arriving mid-turn is not dropped — an agent switched its own indicator off seconds into every turn and then worked on with the driver's UI showing nothing.
- **Worse than a cosmetic bug:** with the marker gone, the poller's next tick emitted `report_complete`, so the activity state machine recorded the turn as *finished* while it was still running.
- **Turn end is now owned by the Stop hook alone** (`mirror-turn.mjs stop`), which every plugin in this family registers. A *first* arm (`--from-end`) still clears the marker — that is the connect/reconnect case the original clear was written for, where a seed delivery can leave a turn nobody will ever wake for.
- Whether the dots appeared at all used to depend on *when* in its turn an agent happened to re-arm, which is why this read as intermittent rather than broken.

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
