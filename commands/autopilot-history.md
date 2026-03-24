---
name: autopilot-history
description: Show recent autopilot execution history
allowed-tools: Read, mcp__devspec__get_action_items
---

# Autopilot History

Show recent autopilot execution history:

1. Query action items with `agent_status` of 'completed' or 'failed' to show recent autopilot activity
2. Display a table with: action item title, status (completed/failed), branch name, timestamp, and any error messages
3. Show aggregate stats: total runs, success count, failure count
