---
name: devspec.remote-stop
description: Disconnect DevSpec remote control — mark Agents page offline, post disconnected, clear ~/.devspec/remote-control.json. Use when done or before exiting the agent.
argument-hint: "[session_id=<uuid>]"
allowed-tools: Bash, mcp__devspec__report_remote_agent_heartbeat, mcp__devspec__post_session_message, mcp__devspec__get_session_transcript
---

# DevSpec Remote Control — Stop / Disconnect

Cleanly disconnect so the **Agents page** drops the live indicator immediately.

## Steps

1. **Load session id** from `~/.devspec/remote-control.json` → `session_id`, or from `$ARGUMENTS` / user.

2. **Mark offline:**
   ```
   report_remote_agent_heartbeat({
     session_id,
     status: "offline",
     end_reason: "local_stop",
     agent_name: "Claude Code"
   })
   ```

3. **Post disconnect** (best-effort):
   ```
   post_session_message(session_id, "🔌 **Local agent disconnected**.", agent_name: "Claude Code")
   ```

4. **Disable local state:**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/remote-control-state.mjs" disable
   ```
   This stops `devspec-remote-poll` on its next loop.

5. Print:
   ```
   ✓ DevSpec remote control stopped
     Session:  {first 8}…
     Agents page: offline
   ```

## Rules

- Always call `status: "offline"` even if post fails.
- Do not delete the DevSpec session — history remains.
