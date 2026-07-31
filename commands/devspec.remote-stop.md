---
name: devspec.remote-stop
description: Disconnect DevSpec remote control for THIS conversation only — connection offline, stop matching poller, leave other remotes alone.
argument-hint: "[connection_id=<uuid>]"
allowed-tools: Bash, mcp__devspec__heartbeat_connection, mcp__devspec__detach_connection, mcp__devspec__get_session_transcript
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
   - `heartbeat_connection({ connection_id, status: "offline", end_reason: "local_stop" })` (one path, attached or sessionless), then optionally `detach_connection({ connection_id })`.
   - **Do not** `post_session_message` disconnect chrome — presence updates via the offline heartbeat / Agents page.

3. **Disable state + kill only this poller + mark bond stopped:**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/remote-control-state.mjs" disable \
     --connection-id '<connection_id>' --agent "Claude Code" --local-id "${CLAUDE_CODE_SESSION_ID:-$CLAUDE_SESSION_ID}"
   ```
   Connection-scoped: writes that connection's state `enabled: false`, marks matching local bonds `stopped` (soft-reconnect only for this conversation within ~30m), and SIGTERMs pollers whose argv includes this connection UUID only.

   The **wake stream** needs no separate kill: it re-reads state every tick and exits **1** (terminal) the moment it sees `enabled: false`. Its monitor will therefore end on its own and report that exit — expected here, not a fault. `TaskStop` on the monitor is optional tidying.

4. Print **in this local terminal only** (never into the session transcript):
   ```
   ✓ DevSpec remote control stopped
     Connection: {first 8}…
     Agents page: offline
     Other remotes on this machine: left running
   ```

## Rules

- Always offline **this** connection.
- Do not delete the DevSpec session — history remains.
- Soft-reconnect is bond-scoped (same conversation id), never by cwd/repo.
