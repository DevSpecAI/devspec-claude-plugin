---
name: devspec.remote-stop
description: Disconnect DevSpec remote control — mark Agents page offline, post disconnected, clear ~/.devspec/remote-control.json. Use when done or before exiting the agent.
argument-hint: "[session_id=<uuid>]"
allowed-tools: Bash, mcp__devspec__report_remote_agent_heartbeat, mcp__devspec__post_session_message, mcp__devspec__get_session_transcript
---

# DevSpec Remote Control — Stop / Disconnect

Cleanly disconnect this local agent from DevSpec remote control so the **Agents page** drops the live indicator immediately (instead of waiting for heartbeat expiry).

## Steps

1. **Load session id.** Prefer `~/.devspec/remote-control.json` → `session_id`. If missing, ask the user for the session UUID (from the Agents page or control session URL).

2. **Mark offline on DevSpec.** Call:
   `report_remote_agent_heartbeat` with:
   - `session_id`: the UUID
   - `status`: `"offline"`
   - `agent_name`: "Claude Code"
   This clears `remote_agent_last_seen_at` so the Agents page shows **disconnected** right away.

3. **Post a disconnect line** (best-effort):
   `post_session_message(session_id, "🔌 **Local agent disconnected**.", agent_name: "Claude Code")`

4. **Disable local state.** Write/update `~/.devspec/remote-control.json` with `enabled: false` (or delete the file). Stop any background poll/sleep loop.

5. **Print:**
   ```
   ✓ DevSpec remote control stopped
     Session:  {{first 8 chars}}…
     Agents page: offline
   ```

## Rules

- Always call `status: "offline"` even if the post fails — clearing live state is the point.
- Do not delete the DevSpec session — history stays for later review.
- Distinct from Claude's built-in `/remote-control`.

