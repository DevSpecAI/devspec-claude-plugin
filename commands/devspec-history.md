---
name: devspec-history
description: View the full traceability timeline of a DevSpec action item
allowed-tools: mcp__devspec__get_action_item_history
---

# DevSpec History

Show the complete timeline of an action item: creation, status changes, commits, notes, relationships, and PRs.

## Steps

1. Extract `action_item_id` from user input. If not provided, ask for it.

2. Call `get_action_item_history` with the `action_item_id`.

3. If the item is not found:
   ```
   ✗ Action item not found: {id}
   ```

4. Format as a timeline:
   ```
   ─── {title} ───
   ID: {id} │ Status: {status} │ Type: {type} │ Priority: {priority}

   Timeline:
     {date} Created{" by " + creator if available}
     {date} {activity description}
     {date} {activity description}
     ...

   Commits ({N}):
     {sha (8 chars)} — {message}
     ...

   Implementation Notes ({N}):
     {date} — {content preview (80 chars)}…
     ...

   Subtasks ({N}):
     [{status}] {title} ({id first 8 chars})
     ...

   Related Items ({N}):
     {relationship_type}: {title} ({id first 8 chars})
     ...
   ```

5. Omit empty sections (e.g., if no commits, don't show "Commits (0)").

## Rules

- Do NOT output filler text before or after the timeline
- Format dates as YYYY-MM-DD HH:MM
- Truncate content previews to 80 characters with `…`
- Show most recent activity first in timeline
