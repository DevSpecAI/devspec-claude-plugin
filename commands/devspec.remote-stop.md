---
name: devspec.remote-stop
description: Disconnect DevSpec remote control for THIS session only — Agents offline, stop matching poller, leave other remotes alone.
argument-hint: "[session_id=<uuid>]"
allowed-tools: Bash, mcp__devspec__report_remote_agent_heartbeat, mcp__devspec__post_session_message, mcp__devspec__get_session_transcript
---

# DevSpec Remote Control — Stop / Disconnect

Cleanly disconnect **this** session so the **Agents page** drops its live indicator immediately.

## Multi-session safety (non-negotiable)

Multiple remotes may run on one machine.

- Stop **only** the target `session_id`.
- **Never** kill all `devspec-remote-poll` processes.
- **Never** offline other session UUIDs.

## Steps

1. **Resolve session id** from `$ARGUMENTS`, or `~/.devspec/remote-control/sessions/<uuid>.json`, or legacy `~/.devspec/remote-control.json` → `session_id`. If multiple active sessions and ambiguous, ask the user.

2. **Mark offline (this session only):**
   ```
   report_remote_agent_heartbeat({
     session_id,
     status: "offline",
     end_reason: "local_stop",
     agent_name: "Claude Code"
   })
   ```

3. **Post disconnect** (best-effort, same session):
   ```
   post_session_message(session_id, "🔌 **Local agent disconnected**.", agent_name: "Claude Code")
   ```

4. **Disable state + kill only this poller:**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/remote-control-state.mjs" disable --session '<session_id>'
   ```
   Session-scoped: writes that session's state `enabled: false` and SIGTERMs pollers whose argv includes this UUID only.

5. Print:
   ```
   ✓ DevSpec remote control stopped
     Session:  {first 8}…
     Agents page: offline
     Other remotes on this machine: left running
   ```

## Rules

- Always offline **this** session even if post fails.
- Do not delete the DevSpec session — history remains.
