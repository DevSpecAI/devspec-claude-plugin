---
name: autopilot.status
description: Show the current state of the DevSpec autopilot
allowed-tools: mcp__devspec__get_action_items, mcp__devspec__get_project_summary
---

# Autopilot Status

Fetch current state and output a compact status panel. Make all API calls in parallel.

## Steps

1. Call `get_project_summary` for settings, `get_action_items` with `agent_ready: true, agent_status: 'queued'` for queue count, and `get_action_items` with `agent_status: 'in_progress'` for active count — **all in parallel**
2. Output:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ◆  DEVSPEC AUTOPILOT  ▸  {ONLINE/OFFLINE}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  interval: {N}s  ·  push: {on/off}  ·  merge: {on/off}

  queued:       {N} items
  in progress:  {N} items
  completed:    {N} items (this session)
  failed:       {N} items (this session)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Rules

- Use `on`/`off` for booleans
- Use tracked session state for completed/failed counts (if autopilot is running)
- Do NOT output filler text before or after the banner
