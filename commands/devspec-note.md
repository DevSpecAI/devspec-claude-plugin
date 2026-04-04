---
name: devspec-note
description: Add an implementation note to a DevSpec action item
allowed-tools: mcp__devspec__add_implementation_note
---

# DevSpec Note

Add a follow-up implementation note to the project, optionally linked to an action item.

## Steps

1. Extract from user input:
   - `content`: required — the note content (markdown supported)
   - `action_item_id`: optional — link to a specific action item
   - `references`: optional — structured references like file paths, URLs, or commit SHAs

2. If no content is provided, ask the user what they want to note.

3. If the user mentions files, URLs, or commits, structure them as references:
   - `{ type: "file", value: "path/to/file.ts" }`
   - `{ type: "url", value: "https://..." }`
   - `{ type: "commit", value: "abc1234" }`

4. Call `add_implementation_note` with the parameters.

5. If scope error (read-only token):
   ```
   ✗ Read-only token — cannot add notes.
     Generate a read-write token in DevSpec: Settings > MCP Tokens.
   ```

6. On success:
   ```
   ✓ Note added
     Note ID: {id (first 8 chars)}
     Linked:  {action_item_id (first 8 chars) or "project-level"}
   ```

## Rules

- Do NOT output filler text before or after the confirmation
- Support markdown in note content
