---
name: devspec-create
description: Create an action item in DevSpec from the terminal
allowed-tools: mcp__devspec__create_action_item
---

# DevSpec Create

Create a new action item in DevSpec without leaving the terminal.

## Steps

1. Extract from the user's input:
   - `title`: required — the action item title
   - `description`: optional — detailed description
   - `type`: optional, default `task` (accept: `bug`, `feature`, `improvement`, `task`, `query`)
   - `priority`: optional, default not set (accept: `low`, `medium`, `high`, `critical`)
   - `agent_ready`: optional, default `false` — set to `true` if user says "for autopilot" or "agent-ready"

2. If no title is provided, ask the user for one.

3. Call `create_action_item` with the extracted parameters.

4. If the call fails with a scope error (read-only token), output:
   ```
   ✗ Read-only token — cannot create action items.
     Generate a read-write token in DevSpec: Settings > MCP Tokens.
   ```

5. On success, output:
   ```
   ✓ Action item created
     ID:       {id (first 8 chars)}
     Title:    {title}
     Type:     {type}
     Priority: {priority or "not set"}
     Agent:    {ready/not ready}
   ```

## Rules

- Do NOT output filler text before or after the confirmation
- Keep output compact
- If user mentions "autopilot", "agent", or "queue it", set `agent_ready: true`
