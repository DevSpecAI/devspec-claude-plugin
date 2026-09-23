# Remote control — Claude Code (LLM primer)

**Family:** local-poller.  
**Read first:** `docs/remote-control/remote-control-overview.md` (or the DevSpec overview resource).  
**Plugin repo:** `claude-code-devspec-autopilot` (remote may be `DevSpecAI/devspec-claude-plugin`)

## Connect at startup — the default path (item `b7ef1fe2`, 0.29.0)

Claude Code starts the DevSpec listener itself. `plugin.json` declares it as a **plugin monitor** (`experimental.monitors`, name `devspec-remote`), and Claude Code launches plugin monitors at session start, with no model turn, and keeps them for the lifetime of the session. `hooks/scripts/devspec-remote-listen.mjs`:

1. resolves the conversation id (`CLAUDE_CODE_SESSION_ID`) and the owning Claude Code pid (`CLAUDE_PID`, trusted only if it is an ancestor; otherwise the ancestry is walked to `claude`);
2. reads the plugin settings — from the session environment the SessionStart hook writes, or from the private `~/.devspec/remote-control/startup/<session>.json` that `remote-session-lifecycle.mjs session-start` files, whichever arrives first. Plugin monitors are not given `CLAUDE_PLUGIN_OPTION_*` by Claude Code;
3. runs `connect({ startup: true })` — see "Startup scope" below — which registers, writes state and starts the poller;
4. files the tier texts in `<connection>.tiers.json` for the first command (`instruction-tiers.mjs`), writes `<connection>.listener.json`, and
5. runs `devspec-remote-wait.mjs --stream` as a child whose stdout **is** the monitor's stdout.

**Stdout is the model's ear.** Every stdout line of a plugin monitor starts a turn. The listener itself never writes to stdout; its log is `~/.devspec/remote-control/listen/<conversation>.log`. When it has nothing to do (an unlinked folder, the setting switched off, the server unreachable after retries, the connection ended from the UI) it goes **dormant**: alive, silent, exiting only when Claude Code does. An ended monitor is announced to the model, so exiting would itself be a wake about nothing.

**One reader per inbox.** The listener arms nothing if `<connection>.wait.pid` is already live, and `/devspec.remote` in a session whose listener holds the wake prints `wake: ALREADY ARMED` instead of the arm command. The Stop hook's deaf-turn check is unchanged: the listener's wait child owns the same pidfile.

**Startup scope.** A registration nobody typed must only join a project its folder names. Connect sends `folder_scope_only: true`; the server then skips "your only accessible project" (it resolves from git remote or pin only) and echoes `folder_scope_only: true`. With no echo — a server predating the flag — the plugin heartbeats the connection offline and stands down. A folder with neither a remote nor a pin never reaches the server.

**Model side.** Nothing is loaded until a command arrives. The monitor's description names the `devspec-remote-command` skill, which holds the handling protocol both wake paths share (it used to be sections 3–9 of the command). Its first step, once per conversation, is `remote-control-state.mjs orient`: the connection id, the room, and the filed tiers (then "unchanged" for the rest of that conversation).

**`/clear` and `/resume`.** Measured on 2.1.280: both give the conversation a new id and run SessionEnd then SessionStart, and a plugin monitor survives both (so does `/reload-plugins`, which does not restart it). So `disable-local` keeps a connection whose startup listener is alive when SessionEnd's `reason` is `clear` or `resume`, and `remote-session-lifecycle.mjs session-start` moves the bond to the new conversation (`rebondConnectionToConversation`), so the turn hooks can still find it. A real exit disables as before.

**Setting.** `connect_at_startup` (userConfig boolean, default on). Off → dormant; `/devspec.remote` still works.

**Limits.** Plugin monitors run only in interactive CLI sessions (not `-p`, not the SDK) and are skipped where the Monitor tool is unavailable. They are an experimental plugin component, so the manifest schema may change. A monitor line is still capped at 500 characters, so the full body and sender style are read from the inbox record, exactly as on the manual path.

## Channels (research preview) — status

Claude Code channels (`https://code.claude.com/docs/en/channels-reference`) are the other way to push into a running session: a stdio MCP server declaring `capabilities.experimental['claude/channel']` emits `notifications/claude/channel`, which arrives as `<channel source=…>` with the full content (no 500-character cap) and meta attributes. A channel can also relay permission prompts to a trusted sender. What we measured on 2026-09-23 (Claude Code 2.1.280):

- A channel server receives `CLAUDE_CODE_SESSION_ID` in its environment, but the MCP `initialize` handshake is **identical** with and without the channel flag: the server cannot tell whether it was registered as a channel. Claude Code drops undeliverable channel events silently.
- **claude.ai Team and Enterprise orgs have channels off until an Owner enables them** (claude.ai → Admin settings → Claude Code → Channels, or `channelsEnabled` in managed settings). DevSpec's own org is on Team and had them off: the startup notice read "Channels are not enabled for your org". Pro/Max without an org skip this check; Console API-key auth is allowed by default.
- Custom channels are not on the approved allowlist during the preview, so they only load with `claude --dangerously-load-development-channels plugin:devspec@devspec`, which shows a full-screen warning dialog on every launch. The allowlist is Anthropic-curated (the channel plugins in `claude-plugins-official`); the community marketplace submission form does not add a plugin to it. Routes off the dev flag: an official-marketplace listing through an Anthropic partner contact (see item `ec3da732`), or, per organisation, an admin adding `{ "marketplace": "devspec", "plugin": "devspec" }` to `allowedChannelPlugins` (Team/Enterprise), after which `--channels plugin:devspec@devspec` works without the warning.
- Not available on Amazon Bedrock, Google Cloud's Agent Platform or Microsoft Foundry; requires claude.ai or Console authentication. A channel server that negotiates MCP protocol `2026-07-28` is not registered.

Because the plugin monitor already delivers zero-turn connect and zero-cost idle to every interactive user today, with no flag, dialog or admin step, it is the default. A channel transport can feed the same listener core once channels are generally available, adding full-length delivery and permission relay.

## How a message reaches Claude

1. DevSpec emits negotiated canonical ingress for this connection.
2. `devspec-remote-poll.mjs` holds `poll_connection`, negotiates delegated project scope plus active-plan projection v1, validates canonical ingress at the network boundary, and writes the complete envelope to the connection inbox. Explicit top-level `automation_run` dispatches remain a separately validated/deduped channel; assignments do not.
3. `devspec-remote-wait.mjs --stream` revalidates inbox records and prints active plans as advisory room awareness, typed advisory context, complete canonical owner-message events (including the verbatim server instruction only for delegated commands), explicit automations, or separate non-chat host controls.
4. Claude Code turns those lines into model-visible events without exiting — through the **plugin monitor** the listener runs under (default), or, on the manual path, through the **Monitor** tool — `persistent: true` where the host serves that schema, otherwise the largest `timeout_ms` it allows, re-armed at each expiry; notification/preview summaries are non-authoritative.
5. Model acts; canonical conversation answers go through `post_session_message({ connection_id })`. A sessionless connection has no conversation answer path, and action-item progress is not a substitute.
6. Stop hook updates busy/heartbeat only — **does not** full-mirror assistant text.

Action-item work is never delivered by connection availability or dispatch. Only when a canonical conversation explicitly requests named action-item work does Claude call `reserve_work_items` and then `claim_work_item` in order. The served `devspec://product/implementation-contract` governs the lifecycle. Explicit owner-scoped `automation_run` records remain separate and use only their automation claim/report path.

## Directed-question answers (item `54b63e47`)

An answer to a question this agent asked is its own lane, not a command. The poller
negotiates `interaction_event_version: 1` **only** when the connection holds the
capability the claim, the continuation and the ACK all require, so a host that cannot
finish the loop never takes a lease on someone's answer.

One answer, in order: claim on the poll → `report_pickup` with the event identity opens
the exact source-less attempt → the durable `interaction_answer` inbox record (in this
host, the inbox IS the application: the wait reads it and that is how the model wakes)
→ ACK on the next poll. Dedupe is by `event_id` from newline-terminated records, so a
redelivery after a crash is acknowledged, never re-applied. A start outcome that is not
startable persists nothing and acknowledges nothing.

While that attempt is open, only the exact writer may touch it: generic pickup/complete
are suppressed and keepalive is translated to the exact form. The model's reply goes
through `devspec-question.mjs respond`, which stores it and completes the attempt in one
request; the Stop hook is the fallback and completes exactly — but only once the wait's
cursor proves the answer actually reached the model.

Authority is the served `devspec://product/interaction-event-contract`. Sibling
connections and fresh replacement rows fail closed; detach/reattach and same-row revival
resume.

## Why wake is streaming here

Claude Code reaps tracked background tasks at turn end. Exit-to-wake would create an infinite re-arm loop (item `be0a929a`). Always `--stream` under **Monitor**, never a background task.

The host serves one of two Monitor schemas, and the difference is silent. With a `persistent` property, one arm lasts the session. Without it the arm is capped (currently 30 minutes) and `persistent: true` is accepted and discarded, so it must be armed with the largest `timeout_ms` available and re-armed with `--stream --pending` at each expiry. An anchored `--stream` arm sets no deadline of its own (0.7.2), so a bounded expiry produces no `listener_rollover` — only the host's notice. The SIGTERM handler still releases the pidfile and exits `EXIT_REARM`, so the Stop keeper sees no listener and hands back the arm. The one-shot wait is for hosts with no Monitor at all; it is **not** a fallback here.

## Connect is mechanical (item `5a393e4c`)

`hooks/scripts/devspec-remote-connect.mjs` performs the entire deterministic setup in one call. The command file used to walk the model through it step by step; measured on a cold Claude session, that ritual cost **34.5k tokens of messages** against an 87.7k total footprint, and none of the steps needed judgement.

What the script does, in order:

1. Node preflight; resolve cwd, `git remote get-url origin`, and the nearest `.devspec/project.json` pin.
2. Resolve the conversation id and the local bond (`already_live` / `reconnect` / `register`).
3. Resolve MCP auth, then `register_connection` **over raw JSON-RPC** (`mcp-call.mjs`), negotiating the hidden connection capability used by `manage_plan`.
4. `attach_connection`, or `create_session` + attach for `--new`.
5. `writeConnectionState(...)` — state file, conversation bond, dead-poller reap, poller start.
6. A **bounded** `get_session_transcript` seed when attached.
7. Print the status block, the tier texts, and the exact wake-stream arm command.

Design rules for anyone editing it:

- **It decides nothing.** It sends `git_remote` and/or `pinned_project_id` as facts and lets the server's `resolveProjectScope` arbitrate. Precedence is never implemented client-side — that is what lets a stale pin copied in with a template self-correct instead of hijacking a folder.
- **No `list_projects` round-trip.** The router resolves the project from `git_remote` directly, so the extra call and its response were pure cost.
- **Raw JSON-RPC, not host MCP tools.** Claude Code negotiates MCP capabilities **once per session**, so a server that starts advertising resources is invisible to every already-running session. The script layer never negotiates, so it can always reach the server even when the host cannot. Keep connect on `mcp-call.mjs` for that reason, not merely for tidiness.
- **One private state boundary.** `private-state.mjs` is the only reader/writer for remote-control JSON that can carry the bearer or hidden capability; every consumer (connect/state, plan, poll, wait, turn mirror, commit observation) goes through it, and it repairs older file modes before reading. `writeConnectionState` remains the one connection-state assembler. Model-facing diagnostics use `remote-control-state.mjs status|read`, which emits only the redacted view and direct reconnect disposition; both remote commands must use resolver/status/list and never tell the model to open the raw file.
- **Plans are not pump verbs.** `devspec-plan.mjs describe|use` injects that capability mechanically and exposes only the server-advertised `manage_plan`. It must never become an alternate poll/heartbeat/dispatch client.
- **Keep the pump architecture.** `devspec-remote-poll.mjs` → durable JSONL inbox → `devspec-remote-wait.mjs` → Monitor, including byte-offset resume semantics. The byte-offset cursor is what makes a re-arm after a bounded expiry lossless.
- Keep three clocks distinct: `cursor_v2` advances the live stream, `window.next_cursor` is persisted/drained only as `catch_up_cursor`, and `dispatch_cursor` advances only after every offered automation is durable.
- Remote-ingress policy, including delegated project scope, is authoritative at `devspec://product/remote-ingress-contract`; validate and surface the server instruction verbatim rather than restating mutable wording here.
- Action-item work acquisition and execution are authoritative at `devspec://product/implementation-contract`; teach only the conversation-requested reserve-then-claim order here.

### Conditional tiers and bounded reads

The server shipped both capabilities in item `e98b2859`; this plugin was an "old caller" on both until `5a393e4c`.

- `register_connection` now echoes the `known_instruction_tiers_version` / `_hash` retained in the connection state file, so a reconnecting conversation receives `instructions_unchanged` rather than the full four tier texts again. The hash is only *overwritten* when the server actually re-sends tiers — an `instructions_unchanged` reply carries none, and must not clear what is stored.
- The orientation seed sends `tail` (default 40) and echoes the fingerprint it was just handed, so the same tiers are not sent twice inside a single connect. It always reports `transcript_window` (matched / returned / has_more) — bounded, but never a silent truncation. An unbounded seed was measured at ~26k tokens for one catch-up read.

## Fallback when the connect script is missing

Only if `devspec-remote-connect.mjs` is absent. Do not invent a third path — fix the plugin instead.

1. `register_connection({ local_id, agent_name, git_remote, connection_capability_version: 1 })`, retaining the hidden MCP result `_meta` capability outside model context, then `attach_connection` if a session was named.
2. `remote-control-state.mjs write --connection-id … --owner-pid "$PPID"` to write state and start the poller.
3. If even the poller script is gone, restore/fix the plugin rather than inventing a second ingress path. The negotiated wire and execution rules live at `devspec://product/remote-ingress-contract`.
4. `status: "not_found"` / `"ended"` → check `end_reason` before standing down. Only `ui` or `local_stop` means a person ended you.

## Host specifics

| Topic | Claude Code |
|---|---|
| Invoke remote | `/devspec:devspec.remote` (bare / `--session` / `--new`) |
| Bond id | `CLAUDE_CODE_SESSION_ID` / `CLAUDE_SESSION_ID` |
| Token | Plugin MCP / `CLAUDE_PLUGIN_OPTION_*` style resolution via shared auth helpers |
| Agent name | `AGENT_NAME = 'Claude Code'` in `hooks/scripts/agent-identity.mjs` |
| Identity file | Pinned by this repo’s `agent-identity.test.mjs`; never hardcode another host’s name |

## Plugin independence (read this before editing scripts)

This repo owns 100% of its scripts. No file crosses a repo boundary — no sync list, no `owns` tier, and **Claude Code is not the canonical source for the other plugins**. Sync tooling was deleted on 2026-08-03 because porting Claude's fixes outward kept breaking hosts that were working. If another plugin needs a fix that landed here, it gets applied there by hand, in that repo. See `docs/PLUGIN-INDEPENDENCE.md`.

## What not to change lightly

- Replacing stream wait with one-shot “like Cursor” without a Monitor will deafen the agent after every turn.
- Teaching Stop to post full answers reintroduces dual-writer races.
- Posting connect chrome into the session violates the delivery contract.

## Failure modes seen in the wild

- Listener not armed → Agents page shows Live but nothing hears (Stop should block ending deaf).
- Bonding on shell session id → multiple chats collide; Working stuck.
- Porting Claude wait defaults into hosts without Monitor → breakage elsewhere.

## Key files

- `commands/devspec.remote.md`, `commands/devspec.remote-stop.md`
- `hooks/scripts/devspec-remote-poll.mjs`
- `hooks/scripts/devspec-remote-wait.mjs` (implements `--stream`)
- `hooks/scripts/remote-control-state.mjs`, `mirror-turn.mjs`
- `hooks/scripts/interaction-events.mjs` (directed-question host policy), `devspec-question.mjs` (ask + reply bridge)
- `docs/PLUGIN-INDEPENDENCE.md` (the convention: each plugin owns its scripts; no cross-repo sync, in any form)
