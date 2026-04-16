---
name: autopilot.start
description: Start the DevSpec autopilot polling loop to automatically process queued action items
argument-hint: "[--mine | --assigned=<user_id>]"
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, Agent, mcp__devspec__get_action_items, mcp__devspec__get_next_work_item, mcp__devspec__claim_work_item, mcp__devspec__update_action_item, mcp__devspec__get_project_summary, mcp__devspec__add_commit_reference, mcp__devspec__add_implementation_note, mcp__devspec__check_queue_status
---

# Start DevSpec Autopilot

You are starting the DevSpec Autopilot. Follow the autopilot skill instructions to enter the polling loop.

## Arguments

Parse `$ARGUMENTS` for an optional assignment scope. The result is a session variable `assigned_to_filter`:

- `--mine` → `assigned_to_filter = "me"` (server resolves to the authenticated caller)
- `--assigned=<user_id>` → `assigned_to_filter = "<user_id>"` (UUID of a teammate)
- nothing → `assigned_to_filter = null` (default pool: open_assignment + unassigned + mine)

The autopilot skill reads this variable and passes it as the `assigned_to` argument on every `get_next_work_item` call for the session.

## Steps

1. Parse `$ARGUMENTS` per above and store `assigned_to_filter` in session state
2. Call `get_project_summary` to fetch project settings including autopilot configuration
3. If autopilot is not enabled in settings, output a warning and stop:
   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     ◆  DEVSPEC AUTOPILOT  ▸  DISABLED
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     Autopilot is not enabled in project settings.
     Enable it in DevSpec project settings to use this feature.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ```
4. Output the startup banner as defined in the skill's Output Formatting section. When `assigned_to_filter` is set, include an `assigned: me` (or `assigned: <short_id>`) line.
5. Enter the polling loop as defined in the autopilot skill (skills/autopilot/SKILL.md), passing `assigned_to_filter` through to every `get_next_work_item` call
6. Follow ALL formatting rules from the skill — use Unicode symbols, compact status lines, and timestamps

The autopilot will continue running until you receive `/autopilot:stop` or the session ends.
