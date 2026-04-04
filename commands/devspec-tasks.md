---
name: devspec-tasks
description: List open action items from DevSpec
allowed-tools: mcp__devspec__get_action_items
---

# DevSpec Tasks

Show the user's open action items from DevSpec in a compact terminal-friendly format.

## Steps

1. Parse any filters the user provided after the command (e.g., "high priority bugs", "queued items"). Map to parameters:
   - `status`: default `open` (accept: `open`, `done`, `dismissed`, `all`)
   - `priority`: optional (`low`, `medium`, `high`, `critical`)
   - `type`: optional (`bug`, `feature`, `improvement`, `task`, `query`)
   - `agent_status`: optional (`planning`, `queued`, `in_progress`, `completed`, `failed`, `awaiting_verification`)
   - `limit`: default `20`

2. Call `get_action_items` with the parsed parameters.

3. If the call fails with an authentication error, output:
   ```
   ✗ DevSpec MCP token not configured or invalid.
     Configure your token: Settings > MCP Tokens in DevSpec, then add to Claude Code.
   ```

4. If no items are returned, output:
   ```
   No open action items found.
   ```

5. If items are returned, format as a compact table:

   ```
   DevSpec Action Items ({N} open)
   
   Priority │ Type        │ Title                          │ Agent Status │ ID
   ─────────┼─────────────┼────────────────────────────────┼──────────────┼──────────
   high     │ bug         │ Fix auth token refresh         │ queued       │ a1b2c3d4
   medium   │ feature     │ Add user profile page          │ —            │ e5f6g7h8
   low      │ improvement │ Refactor database queries      │ completed    │ i9j0k1l2
   ```

   - Truncate title to 30 chars with `…` if longer
   - Truncate ID to first 8 characters
   - Show `—` for null agent_status
   - If filters were applied, note them: `Filtered by: priority=high, type=bug`

## Rules

- Do NOT output filler text before or after the table
- Keep output compact — no extra blank lines or verbose descriptions
- If the user asks for details on a specific item, suggest `/devspec:history <id>`
