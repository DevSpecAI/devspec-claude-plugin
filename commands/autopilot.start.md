---
name: autopilot.start
description: Start the DevSpec autopilot polling loop to automatically process queued action items
argument-hint: "[--mine | --created-by=<user_id>] [--drain]"
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, Agent, mcp__devspec__get_action_items, mcp__devspec__get_next_work_item, mcp__devspec__claim_work_item, mcp__devspec__update_action_item, mcp__devspec__get_project_summary, mcp__devspec__add_commit_reference, mcp__devspec__add_implementation_note, mcp__devspec__check_queue_status
---

# Start DevSpec Autopilot

You are starting the DevSpec Autopilot. Follow the autopilot skill instructions to enter the polling loop.

## Arguments

Parse `$ARGUMENTS` into two independent session variables:

### `created_by_filter`

- `--mine` → `created_by_filter = "me"` (server resolves to the authenticated caller)
- `--created-by=<user_id>` → `created_by_filter = "<user_id>"` (UUID of a teammate)
- nothing → `created_by_filter = null` (any creator)

This is passed as the `created_by` argument on every `get_next_work_item` call. It filters the queue to items **created by** that user (action_items.user_id), not items assigned to them.

### `drain_on_empty`

- `--drain` → `drain_on_empty = true`
- nothing → `drain_on_empty = false`

When true, the autopilot exits (with the normal stop summary) on the **first idle cycle** instead of entering adaptive idle sleep. Use this to "process everything in the queue and then quit".

## Steps

1. Parse `$ARGUMENTS` per above and store both flags in session state. Flags are independent — any combination is valid (e.g. `--mine --drain`).
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
4. Output the startup banner as defined in the skill's Output Formatting section. When `created_by_filter` is set, include a `created_by: me` (or `created_by: <short_id>`) line. When `drain_on_empty` is set, include a `drain: on` line.
5. Enter the polling loop as defined in the autopilot skill (skills/autopilot/SKILL.md), passing both flags through — the skill uses `created_by_filter` on every `get_next_work_item` call and checks `drain_on_empty` at the Wait step.
6. Follow ALL formatting rules from the skill — use Unicode symbols, compact status lines, and timestamps

When `drain_on_empty` is false (default), the autopilot continues running until you receive `/autopilot.stop` or the session ends. When true, it stops on the first idle cycle.
