---
name: devspec.create
description: Create an action item in DevSpec from the terminal
allowed-tools: Bash, mcp__devspec__list_projects, mcp__devspec__create_action_item
---

# DevSpec Create

Create a new action item in DevSpec without leaving the terminal.

## Steps

0. **Resolve the project (account-wide token).** DevSpec MCP tokens are account-wide, so name the project the item belongs to. First, if `.devspec/project.json` exists (check the working directory, then each parent up to and including the git repository root, never at or above your home directory; nearest wins), read its `project_id` — the folder pin, which is how a folder with **no git repo yet** names its project. Then run `git remote get-url origin` and call `list_projects({ git_remote: "<that remote>" })`; use `remote_match.resolved_project_id` as `project_id`. If it is null with multiple `candidate_project_ids`, present them and ask the user which project. If there is no match (or no remote) **but you have a pin**, carry on and pass `pinned_project_id` on the `create_action_item` call instead — only when there is neither a pin nor a matching remote, output `✗ No DevSpec project tracks this repo (<git_remote>), and there is no .devspec/project.json pin.` and stop. Otherwise pass `project_id` on the `create_action_item` call in step 3.

   **A pin goes in `pinned_project_id`, never `project_id`** — `project_id` outranks a verified remote, while the pin is deliberately ranked below one. Send whichever signals you have and let the server arbitrate; never decide precedence yourself. This matters most here: a greenfield project's first action items are usually created before any repo exists.

1. Extract from the user's input:
   - `title`: required — the action item title
   - `description`: optional — detailed description
   - `type`: optional, default `task` (accept: `bug`, `feature`, `improvement`, `task`, `query`)
   - `priority`: optional, default not set (accept: `low`, `medium`, `high`, `critical`)
   - `suggest_human_only`: optional boolean — pass `true` ONLY for plainly off-platform work no agent could do (e.g. "call the lawyer", "buy the domain"). It is a suggestion a human confirms in DevSpec. Everything else needs no flag.

2. If no title is provided, ask the user for one.

3. Call `create_action_item` with the extracted parameters **plus `project_id`** (resolved in step 0).

4. If the call fails with a scope error (read-only token), output:
   ```
   ✗ Read-only token — cannot create action items.
     Generate a read-write token in DevSpec: You → Connections → Connect a tool (Read & write).
   ```

5. On success, output:
   ```
   ✓ Action item created
     ID:       {id (first 8 chars)}
     Title:    {title}
     Type:     {type}
     Priority: {priority or "not set"}
   ```

   If `suggest_human_only: true` was passed, append: `  Human-only: suggested (a human confirms in DevSpec)`

## Rules

- Do NOT output filler text before or after the confirmation
- Keep output compact
- Pass `suggest_human_only: true` only for plainly off-platform work — never for code or platform work, even if the user says "manual" or "no autopilot" (any open item can simply stay unstaged)
