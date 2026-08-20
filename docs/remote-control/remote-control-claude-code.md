# Remote control — Claude Code (LLM primer)

**Family:** local-poller.  
**Read first:** `docs/remote-control/remote-control-overview.md` (or the DevSpec overview resource).  
**Plugin repo:** `claude-code-devspec-autopilot` (remote may be `DevSpecAI/devspec-claude-plugin`)

## How a message reaches Claude

1. DevSpec emits negotiated canonical ingress for this connection.
2. `devspec-remote-poll.mjs` holds `poll_connection`, validates v1 at the network boundary, and writes the complete envelope to the connection inbox.
3. `devspec-remote-wait.mjs --stream` watches the inbox and prints typed advisory context plus complete canonical command events.
4. Claude Code **Monitor** (`persistent: true`) turns those lines into model-visible events without exiting; notification/preview summaries are non-authoritative.
5. Model acts; when attached, model `post_session_message({ connection_id })` with the direct answer.
6. Stop hook updates busy/heartbeat only — **does not** full-mirror assistant text.

## Why wake is streaming here

Claude Code reaps tracked background tasks at turn end. Exit-to-wake would create an infinite re-arm loop (item `be0a929a`). Prefer `--stream` + persistent Monitor. One-shot wait is fallback only.

## Connect is mechanical (item `5a393e4c`)

`hooks/scripts/devspec-remote-connect.mjs` performs the entire deterministic setup in one call. The command file used to walk the model through it step by step; measured on a cold Claude session, that ritual cost **34.5k tokens of messages** against an 87.7k total footprint, and none of the steps needed judgement.

What the script does, in order:

1. Node preflight; resolve cwd, `git remote get-url origin`, and the nearest `.devspec/project.json` pin.
2. Resolve the conversation id and the local bond (`already_live` / `reconnect` / `register`).
3. Resolve MCP auth, then `register_connection` **over raw JSON-RPC** (`mcp-call.mjs`).
4. `attach_connection`, or `create_session` + attach for `--new`.
5. `writeConnectionState(...)` — state file, conversation bond, dead-poller reap, poller start.
6. A **bounded** `get_session_transcript` seed when attached.
7. Print the status block, the tier texts, and the exact wake-stream arm command.

Design rules for anyone editing it:

- **It decides nothing.** It sends `git_remote` and/or `pinned_project_id` as facts and lets the server's `resolveProjectScope` arbitrate. Precedence is never implemented client-side — that is what lets a stale pin copied in with a template self-correct instead of hijacking a folder.
- **No `list_projects` round-trip.** The router resolves the project from `git_remote` directly, so the extra call and its response were pure cost.
- **Raw JSON-RPC, not host MCP tools.** Claude Code negotiates MCP capabilities **once per session**, so a server that starts advertising resources is invisible to every already-running session. The script layer never negotiates, so it can always reach the server even when the host cannot. Keep connect on `mcp-call.mjs` for that reason, not merely for tidiness.
- **One writer.** `writeConnectionState` is shared with `remote-control-state.mjs write`. Do not grow a second state-writing path.
- **Keep the pump architecture.** `devspec-remote-poll.mjs` → durable JSONL inbox → `devspec-remote-wait.mjs` → persistent Monitor, including byte-offset resume semantics.
- Remote-ingress policy is authoritative at `devspec://product/remote-ingress-contract`; do not restate mutable versions here.

### Conditional tiers and bounded reads

The server shipped both capabilities in item `e98b2859`; this plugin was an "old caller" on both until `5a393e4c`.

- `register_connection` now echoes the `known_instruction_tiers_version` / `_hash` retained in the connection state file, so a reconnecting conversation receives `instructions_unchanged` rather than the full four tier texts again. The hash is only *overwritten* when the server actually re-sends tiers — an `instructions_unchanged` reply carries none, and must not clear what is stored.
- The orientation seed sends `tail` (default 40) and echoes the fingerprint it was just handed, so the same tiers are not sent twice inside a single connect. It always reports `transcript_window` (matched / returned / has_more) — bounded, but never a silent truncation. An unbounded seed was measured at ~26k tokens for one catch-up read.

## Fallback when the connect script is missing

Only if `devspec-remote-connect.mjs` is absent. Do not invent a third path — fix the plugin instead.

1. `register_connection({ local_id, agent_name, git_remote })`, then `attach_connection` if a session was named.
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
- `docs/PLUGIN-INDEPENDENCE.md` (the convention: each plugin owns its scripts; no cross-repo sync, in any form)
