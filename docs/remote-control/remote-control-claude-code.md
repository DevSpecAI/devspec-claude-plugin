# Remote control — Claude Code (LLM primer)

**Family:** local-poller.  
**Read first:** `docs/remote-control/remote-control-overview.md` (or the DevSpec overview resource).  
**Plugin repo:** `claude-code-devspec-autopilot` (remote may be `DevSpecAI/devspec-claude-plugin`)

## How a message reaches Claude

1. Owner dispatches to this connection in DevSpec.
2. `devspec-remote-poll.mjs` holds `poll_connection`, writes owner commands to the connection inbox.
3. `devspec-remote-wait.mjs --stream` watches the inbox and prints wake lines.
4. Claude Code **Monitor** (`persistent: true`) turns those lines into model-visible events without exiting.
5. Model acts; when attached, model `post_session_message({ connection_id })` with the direct answer.
6. Stop hook updates busy/heartbeat only — **does not** full-mirror assistant text.

## Why wake is streaming here

Claude Code reaps tracked background tasks at turn end. Exit-to-wake would create an infinite re-arm loop (item `be0a929a`). Prefer `--stream` + persistent Monitor. One-shot wait is fallback only.

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
