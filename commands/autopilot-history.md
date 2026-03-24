---
name: autopilot-history
description: Show recent autopilot execution history
allowed-tools: Read, mcp__devspec__get_action_items
---

# Autopilot History

Fetch completed and failed items, then output in this format:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ◆  DEVSPEC AUTOPILOT  ▸  HISTORY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✓ "Fix login timeout handling"
    fix/action-item-a1b2c3d4 · merged · 2h ago

  ✓ "Add input validation to /api/upload"
    fix/action-item-e5f6g7h8 · merged · 5h ago

  ✗ "Refactor auth middleware"
    fix/action-item-i9j0k1l2 · failed: Merge conflict on staging · 1d ago

  ━━ 3 total · 2 completed · 1 failed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Data sources:
1. Call `get_action_items` with `agent_status: 'completed'` and `agent_status: 'failed'` in parallel
2. Use `✓` for completed, `✗` for failed
3. Show branch name, merge status, and relative time
4. For failed items, include the `agent_error` message
5. Show aggregate stats at the bottom
6. Sort by most recent first
