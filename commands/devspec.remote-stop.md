---
name: devspec.remote-stop
description: Disconnect DevSpec remote control for THIS conversation only — connection offline, stop matching poller, leave other remotes alone.
argument-hint: "[connection_id=<uuid>]"
allowed-tools: Bash, mcp__devspec__heartbeat_connection, mcp__devspec__report_remote_agent_heartbeat, mcp__devspec__detach_connection, mcp__devspec__post_session_message, mcp__devspec__get_session_transcript
---

# DevSpec Remote Control — Stop / Disconnect

Cleanly disconnect **this** conversation's connection so the **Agents page** drops its live indicator immediately.

## Multi-connection safety (non-negotiable)

Multiple remotes may run on one machine.

- Stop **only** the target `connection_id`.
- **Never** kill all `devspec-remote-poll` processes.
- **Never** offline other connections.

## Steps

1. **Resolve connection id** from `$ARGUMENTS`, or this conversation's state via
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/remote-control-state.mjs" resolve-local \
     --agent "Claude Code" --local-id "${CLAUDE_CODE_SESSION_ID:-$CLAUDE_SESSION_ID}"
   ```
   (use its `connection_id`), or `~/.devspec/remote-control/connections/<uuid>.json`, or legacy `~/.devspec/remote-control.json`. If ambiguous, ask the user. Note its `session_id` (may be null = sessionless).

2. **Mark the connection offline (this connection only):**
   - If attached (`session_id` present): `report_remote_agent_heartbeat({ session_id, status: "offline", end_reason: "local_stop", agent_name: "Claude Code" })` (the bond-aware dual-write also ends the connection row), then optionally `detach_connection({ connection_id })`.
   - If sessionless: `heartbeat_connection({ connection_id, status: "offline", end_reason: "local_stop" })`.

3. **Post disconnect** (best-effort, only when attached):
   ```
   post_session_message(session_id, "🔌 **Local agent disconnected**.", agent_name: "Claude Code")
   ```

4. **Disable state + kill only this poller + mark bond stopped:**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/remote-control-state.mjs" disable \
     --connection-id '<connection_id>' --agent "Claude Code" --local-id "${CLAUDE_CODE_SESSION_ID:-$CLAUDE_SESSION_ID}"
   ```
   Connection-scoped: writes that connection's state `enabled: false`, marks matching local bonds `stopped` (soft-reconnect only for this conversation within ~30m), and SIGTERMs pollers whose argv includes this connection UUID only.

5. Print:
   ```
   ✓ DevSpec remote control stopped
     Connection: {first 8}…
     Agents page: offline
     Other remotes on this machine: left running
   ```

## Rules

- Always offline **this** connection even if the post fails.
- Do not delete the DevSpec session — history remains.
- Soft-reconnect is bond-scoped (same conversation id), never by cwd/repo.
