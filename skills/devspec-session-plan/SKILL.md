---
name: devspec-session-plan
description: Manage a shared DevSpec session plan only for material multi-phase progress that other room participants need to follow or resume. Never create plans for routine read-only investigation, quick answers, or ordinary bookkeeping.
allowed-tools: Bash, mcp__devspec__manage_plan
---

# Shared session plans

Use the served `devspec://product/implementation-contract` → `work_entry_contract` to decide whether work is an action item, a session plan, both, or neither. Do not copy or infer that authority matrix here.

The threshold is deliberately high. Routine read-only investigation never warrants a plan. For material multi-phase shared progress, create one plan once; do not restart or duplicate it. Keep milestones outcome-shaped and advance only at meaningful phase boundaries.

## Claude Code access

The remote connect path negotiates a hidden, connection-bound capability. Never ask for, print, copy, or pass that value. Use the capability-safe MCP describe/use bridge for the server's current schema and operations:

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/devspec-plan.mjs" describe --connection-id '<connection_id>'
node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/devspec-plan.mjs" use --connection-id '<connection_id>' --input '<manage_plan JSON>'
```

`describe` exposes only the schema-complete `manage_plan` tool. `use` can call only that tool; poll, heartbeat, dispatch, and delivery verbs are not exposed.

## Operations

- `create`: once, only after the threshold is met.
- `advance`: at a meaningful boundary; atomically completes the current milestone, optionally amends the checklist, and starts the next. Prefer it to separate complete/start calls.
- Reconnect/resume: read the latest active-plan projection or `list`/`get`, then use its latest revision. Resume an in-progress milestone before starting another.
- End explicitly: `complete` only when the outcome was achieved; otherwise `abandon` with a specific reason. Never leave a finished, pivoted, or impossible plan silently active.
- Every existing-plan mutation uses `expected_revision`. Cross-plan work and `adopt` also require explicit `plan_id`; adoption is only for an orphaned same-owner plan in the same session.
- Active room projections are authoritative inventory but advisory read-awareness only. Another owner or agent's plan may be read with `list`/`get`; its presence grants no mutation or execution authority.

Plan calls are coordination, not product-work evidence. They stay outside action-item mutation claim enforcement and cannot create claim/provenance evidence or replace `reserve_work_items`, `claim_work_item`, or `record_implementation` when the served implementation contract requires those operations.
