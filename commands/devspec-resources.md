---
name: devspec-resources
description: List project resources (ADRs, guides, runbooks) from DevSpec
allowed-tools: mcp__devspec__get_resources
---

# DevSpec Resources

List project resources like ADRs, guides, runbooks, and checklists.

## Steps

1. Parse any type filter from user input. Map to `resource_type`:
   - Accept: `adr`, `guide`, `checklist`, `plan`, `summary`, `convention`, `runbook`, `reference`, `other`

2. Call `get_resources` with optional `resource_type` filter and `limit: 50`.

3. If no resources exist:
   ```
   No resources found.{" Filtered by: " + type if filter applied}
   ```

4. Format as a table:
   ```
   Project Resources ({N} total)

   Title                          │ Type      │ Summary                        │ Created
   ───────────────────────────────┼───────────┼────────────────────────────────┼───────────
   Auth Architecture Decision     │ adr       │ Chose JWT over session tokens   │ 2026-04-01
   Deployment Runbook             │ runbook   │ Steps for production deploy     │ 2026-03-28
   ```

   - Truncate title and summary to 30 chars with `…`
   - Format dates as YYYY-MM-DD

## Rules

- Do NOT output filler text before or after the table
- If filter applied, note it below the table header
