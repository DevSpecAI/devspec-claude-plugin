---
name: devspec.progress
description: Report progress on a DevSpec action item
allowed-tools: mcp__devspec__report_progress
---

# DevSpec Progress

Add a progress update to a claimed action item without changing its status.

## Steps

1. Extract from user input:
   - `action_item_id`: required — the action item to update
   - `content`: required — the progress update (markdown supported)
   - `references`: optional — file paths, URLs, or commit SHAs

2. If either required parameter is missing, ask the user.

3. If the user mentions files, URLs, or commits, structure them as references:
   - `{ type: "file", value: "path/to/file.ts" }`
   - `{ type: "url", value: "https://..." }`
   - `{ type: "commit", value: "abc1234" }`

4. Call `report_progress` with the parameters.

5. If scope error (read-only token):
   ```
   ✗ Read-only token — cannot report progress.
     Generate a read-write token in DevSpec: Settings > MCP Tokens.
   ```

6. On success:
   ```
   ✓ Progress reported
     Item:    {action_item_id (first 8 chars)}
     Note ID: {implementation_note_id (first 8 chars)}
   ```

## Rules

- Do NOT output filler text before or after the confirmation
- This does NOT change the action item's status — it just adds a progress note
