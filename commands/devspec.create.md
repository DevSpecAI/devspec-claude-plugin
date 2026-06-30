---
name: devspec.create
description: Create an action item in DevSpec from the terminal
allowed-tools: Bash, mcp__devspec__list_projects, mcp__devspec__create_action_item
---

# DevSpec Create

Create a new action item in DevSpec without leaving the terminal.

## Steps

0. **Resolve the project (account-wide token).** DevSpec MCP tokens are account-wide and no longer pin a project, so name the project the item belongs to. Run `git remote get-url origin` and call `list_projects({ git_remote: "<that remote>" })`; use `remote_match.resolved_project_id` as `project_id`. If it is null with multiple `candidate_project_ids`, present them and ask the user which project. If there is no match, output `✗ No DevSpec project tracks this repo (<git_remote>).` and stop. Pass `project_id` on the `create_action_item` call in step 3.

1. Extract from the user's input:
   - `title`: required — the action item title
   - `description`: optional — detailed description
   - `type`: optional, default `task` (accept: `bug`, `feature`, `improvement`, `task`, `query`)
   - `priority`: optional, default not set (accept: `low`, `medium`, `high`, `critical`)
   - `agent_ready`: optional, default `true` — set to `false` if user says "not for autopilot" or "manual"

2. If no title is provided, ask the user for one.

3. Call `create_action_item` with the extracted parameters **plus `project_id`** (resolved in step 0).

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
- If user mentions "manual", "not for agent", or "no autopilot", set `agent_ready: false`
