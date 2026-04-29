---
name: autopilot.history
description: Show recent autopilot execution history
allowed-tools: Bash, mcp__devspec__get_action_items
---

# Autopilot History

Fetch completed and failed items, then output a clean formatted list.

## Steps

1. Call `get_action_items` with `agent_activity: 'completed'` and `get_action_items` with `agent_activity: 'failed'` **in parallel**
2. If the completed items response is too large (saved to a file), read the file with the Bash tool
3. Combine all items, sort by most recent first
4. Calculate relative timestamps properly: use the `agent_claimed_at` field (ISO 8601 string). Compute elapsed time using a Bash one-liner if needed:
   ```bash
   node -e "const items = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); items.forEach(i => { const ms = Date.now() - new Date(i.agent_claimed_at).getTime(); const h = Math.floor(ms/3600000); const m = Math.floor((ms%3600000)/60000); console.log(h > 24 ? Math.floor(h/24)+'d ago' : h > 0 ? h+'h ago' : m+'m ago', '|', i.agent_activity === 'completed' ? 'ok' : 'fail', '|', i.agent_branch || 'no-branch', '|', i.title); })"
   ```
   **CRITICAL**: Do NOT use string manipulation or regex to parse dates. Do NOT produce "NaN" timestamps. Always use `Date` constructor on the ISO string.
5. Output the formatted history:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ◆  DEVSPEC AUTOPILOT  ▸  HISTORY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✓ "Fix login timeout handling"
    autopilot/action-item-a1b2c3d4 · merged · 2h ago

  ✓ "Add input validation to /api/upload"
    autopilot/action-item-e5f6g7h8 · merged · 5h ago

  ✗ "Refactor auth middleware"
    autopilot/action-item-i9j0k1l2 · failed: Merge conflict · 1d ago

  ━━ 3 total · 2 completed · 1 failed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Rules

- Use `✓` for completed, `✗` for failed
- Show branch name, merge status (merged/push-only/failed), and relative time
- For failed items, include the `agent_error` message after "failed:"
- Sort by most recent first
- Show aggregate stats at the bottom
- Do NOT output filler text before or after the banner
- Do NOT use multiple intermediate Bash calls to parse data — compute everything in one pass
