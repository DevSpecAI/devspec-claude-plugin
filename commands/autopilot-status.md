---
name: autopilot-status
description: Show the current state of the DevSpec autopilot
allowed-tools: Read, mcp__devspec__get_action_items, mcp__devspec__get_project_summary
---

# Autopilot Status

Show the current autopilot status:

1. Whether the autopilot is running or stopped
2. Current project and target branch
3. Number of queued action items (call `get_action_items` with `agent_status: 'queued'`)
4. Number of items in progress (call `get_action_items` with `agent_status: 'in_progress'`)
5. Last action taken (if any)
6. Autopilot settings summary (poll interval, auto-merge, idle detection)
