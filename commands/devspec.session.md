---
name: devspec.session
description: List recent DevSpec sessions or load a session transcript
allowed-tools: mcp__devspec__get_recent_sessions, mcp__devspec__get_session_transcript
---

# DevSpec Session

Dual-mode command: list recent sessions, or load a specific session's transcript into the conversation.

## Steps

### Mode 1: List Sessions (no session ID provided)

1. Call `get_recent_sessions` with `limit: 10`.

2. If no sessions exist:
   ```
   No sessions recorded yet.
   ```

3. Format as a table:
   ```
   Recent Sessions ({N} total)

   Title                          │ Date       │ Status   │ ID
   ───────────────────────────────┼────────────┼──────────┼──────────────────
   Auth architecture discussion   │ 2026-04-03 │ active   │ abc12345-...
   Sprint planning Q2             │ 2026-04-01 │ archived │ def67890-...
   ```

4. After the table:
   ```
   To load a session: /devspec:session <session-id>
   ```

### Mode 2: Load Transcript (session ID provided)

1. Call `get_session_transcript` with the provided `session_id`.

2. If the session is not found, output:
   ```
   ✗ Session not found. Run /devspec:session to list available sessions.
   ```

3. On success, present the transcript as structured context:
   ```
   ─── Session: {title} ({date}) ───

   {role}: {content}

   {role}: {content}

   ─── End of transcript ({N} messages) ───
   ```

4. After loading, confirm:
   ```
   ✓ Session loaded into context. I can now reference this conversation.
   ```

## Rules

- Do NOT output filler text before or after the output
- Truncate session titles to 30 chars in list mode
- In transcript mode, show all messages — do not truncate
- Format dates as YYYY-MM-DD
