---
name: autopilot.start
description: Start the DevSpec autopilot polling loop to automatically process queued action items
argument-hint: "[--all | --mine | --assigned-to=<user_id>] [--created-by=<user_id>] [--drain] [--items=<uuid1>,<uuid2>,...]"
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, Agent, mcp__devspec__get_action_items, mcp__devspec__get_next_work_item, mcp__devspec__claim_work_item, mcp__devspec__update_action_item, mcp__devspec__spin_off_action_item, mcp__devspec__get_project_summary, mcp__devspec__add_commit_reference, mcp__devspec__add_implementation_note, mcp__devspec__check_queue_status
---

# Start DevSpec Autopilot

You are starting the DevSpec Autopilot. Follow the autopilot skill instructions to enter the polling loop.

## Arguments

Parse `$ARGUMENTS` into four independent session variables. Flags can be combined freely (e.g. `--all --drain`, `--assigned-to=<uuid> --created-by=<uuid>`, `--items=<uuid1>,<uuid2>`).

### `assigned_to_filter` (NEW DEFAULT — assignee-based ownership)

- `--mine` → `assigned_to_filter = "me"` (explicit; same as default)
- `--assigned-to=<user_id>` → `assigned_to_filter = "<user_id>"` (run on a specific teammate's queue)
- `--all` → clear `assigned_to_filter` (legacy shared-queue behaviour — see precedence below)
- nothing → `assigned_to_filter = "me"` (NEW DEFAULT)

This is passed as the `assigned_to` argument on every `get_next_work_item` call. The server-side semantic (action item ownership v1):
- `assigned_to: "me"` matches items where the caller is in the assignee set **OR** the item has zero assignees (the grab-bag pool).
- `assigned_to: "<uuid>"` matches items where that user is in the assignee set **OR** the item has zero assignees.
- Omitted (i.e. `--all`) → no assignee filter; every item the caller can see is eligible.

### `created_by_filter` (independent, opt-in)

- `--created-by=<user_id>` → `created_by_filter = "<user_id>"` (filter to items authored by that user)
- nothing → `created_by_filter = null` (no creator filter)

`created_by` is layered on top of `assigned_to` — both must match when both are set. It survives the pivot as an explicit opt-in, but is **no longer the default ownership mechanism**.

### `drain_on_empty`

- `--drain` → `drain_on_empty = true`
- nothing → `drain_on_empty = false`

When true, the autopilot exits (with the normal stop summary) on the **first idle cycle** instead of entering adaptive idle sleep. Use this to "process everything in the queue and then quit".

### `item_id_queue` (targeted run)

- `--items=<uuid1>,<uuid2>,...` → `item_id_queue = ["<uuid1>", "<uuid2>", ...]` (items are processed in the given order, then the loop exits)
- nothing → `item_id_queue = []`

Split the value on `,`, trim whitespace around each entry, and validate each UUID against `^[0-9a-f-]{36}$` before storing. If any value fails validation, output `✗ Invalid UUID in --items: <value>` and stop **before** entering the polling loop — do not claim, fetch, or heartbeat.

When `item_id_queue` is non-empty, the session is in **targeted mode**:
- The polling loop pops UUIDs from this queue in order and processes them directly, skipping the regular `get_next_work_item()` call.
- `drain_on_empty = true` is implied automatically — the loop exits cleanly once the last targeted item finishes (success or failure), with no idle sleep.
- Mixing `--items` with `--drain` has no unexpected interaction: the drain flag is already implied, so passing it explicitly is a no-op.

### Flag precedence

Explicit UUID flags (`--assigned-to=<uuid>`, `--created-by=<uuid>`) > `--all` > `--mine` > default. If a caller passes both `--all` and `--assigned-to=<uuid>`, the explicit UUID wins.

### Common recipe: everything you created, regardless of assignee

```
/autopilot.start --all --created-by=<your_user_id>
```

Processes only the items **you authored**, no matter who they are assigned to. Both flags are required: `--created-by` is ANDed on top of the assignee filter, and the default assignee filter is `--mine` (assigned to you OR unassigned). So `--created-by=<uuid>` *alone* skips items you created but assigned to a teammate. `--all` clears the assignee filter, leaving `--created-by` as the only narrowing condition. There is no "queued" flag — the autopilot only ever fetches and claims queued, agent-ready work, so `--created-by` already means "queued items created by that user".

### Force-claim is NOT used by default

Sibling `360b1202` added a `force: true` flag to `claim_work_item` that bypasses the assignee-aware claim guard. The autopilot loop **MUST NOT** pass `force: true` under normal operation. If `claim_work_item` rejects with an `assigned to other users` error, treat it like any other claim rejection: log it, move on to the next item, and let the assignee pick the work up themselves. A future `--force-claim` flag may opt callers into force claiming explicitly; until that ships, the loop never overrides someone else's claim.

## Steps

1. Parse `$ARGUMENTS` per above and store all four flags (`assigned_to_filter`, `created_by_filter`, `drain_on_empty`, `item_id_queue`) in session state. If `--items=` is present, validate every UUID per the rule above and stop with a clear error on the first invalid value — do NOT enter the polling loop. If `item_id_queue` ends up non-empty, also set `drain_on_empty = true` (it is implied). Flags are otherwise independent — any combination is valid (e.g. `--mine --drain`, `--assigned-to=<uuid> --created-by=<uuid>`, `--items=<uuid>`).
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
4. Output the startup banner as defined in the skill's Output Formatting section. Include a `filter:` line that reflects the active assignee-filter state:
   - Default / `--mine`: `filter: assigned to you (+ unassigned)`
   - `--assigned-to=<uuid>`: `filter: assigned to <short_id> (+ unassigned)`
   - `--all`: `filter: shared queue (no filter)`
   When `created_by_filter` is set, also include a separate `created_by: <short_id>` line. When `drain_on_empty` is set, include a `drain: on` line. When `item_id_queue` is non-empty, include a `mode: targeted (N items specified)` line so the operator can see at a glance that the session is processing a fixed list rather than the live queue.
5. Enter the polling loop as defined in the autopilot skill (skills/autopilot/SKILL.md), passing all four flags through — the skill uses `assigned_to_filter` and `created_by_filter` on every `get_next_work_item` call, pops from `item_id_queue` at the Fetch Work step when it is non-empty, and checks `drain_on_empty` at the Wait step.
6. Follow ALL formatting rules from the skill — use Unicode symbols, compact status lines, and timestamps

When `drain_on_empty` is false (default) and `item_id_queue` is empty, the autopilot continues running until you receive `/autopilot.stop` or the session ends. When `drain_on_empty` is true, it stops on the first idle cycle. When `item_id_queue` is non-empty, the loop processes the listed items in order and then exits cleanly via the same drain-then-exit path.
