---
name: autopilot-start
description: Start the DevSpec autopilot polling loop to automatically process queued action items
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, Agent, mcp__devspec__get_action_items, mcp__devspec__update_action_item, mcp__devspec__get_project_summary, mcp__devspec__add_commit_reference, mcp__devspec__add_implementation_note, mcp__devspec__check_queue_status
---

# Start DevSpec Autopilot

You are starting the DevSpec Autopilot. Follow the autopilot skill instructions to enter the polling loop.

## Steps

1. Call `get_project_summary` to fetch project settings including autopilot configuration
2. If autopilot is not enabled in settings, output a warning and stop:
   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     ◆  DEVSPEC AUTOPILOT  ▸  DISABLED
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     Autopilot is not enabled in project settings.
     Enable it in DevSpec project settings to use this feature.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ```
3. Output the startup banner as defined in the skill's Output Formatting section
4. Enter the polling loop as defined in the autopilot skill (skills/autopilot/SKILL.md)
5. Follow ALL formatting rules from the skill — use Unicode symbols, compact status lines, and timestamps

The autopilot will continue running until you receive `/autopilot:stop` or the session ends.
