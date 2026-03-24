---
name: autopilot-status
description: Show the current state of the DevSpec autopilot
allowed-tools: Read, mcp__devspec__get_action_items, mcp__devspec__get_project_summary
---

# Autopilot Status

Fetch current state and output in this format:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ◆  DEVSPEC AUTOPILOT  ▸  {RUNNING/STOPPED}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  target: {branch}  ·  interval: {N}s
  push: {on/off}  ·  merge: {on/off}

  Queue:        {N} items ready
  In progress:  {N} items
  Completed:    {N} items (this session)
  Failed:       {N} items (this session)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Data sources:
1. Call `get_project_summary` for settings
2. Call `get_action_items` with `agent_status: 'queued'` for queue count
3. Call `get_action_items` with `agent_status: 'in_progress'` for active count
4. Use tracked session state for completed/failed counts (if autopilot is running)

Make all API calls in parallel.
