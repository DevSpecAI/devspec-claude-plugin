---
name: devspec-decisions
description: List architectural decisions recorded in DevSpec
allowed-tools: mcp__devspec__get_decisions
---

# DevSpec Decisions

Show architectural and design decisions recorded for the project.

## Steps

1. Call `get_decisions` with `limit: 20`.

2. If no decisions exist:
   ```
   No decisions recorded yet. Decisions are captured during DevSpec sessions.
   ```

3. Format as a numbered list:

   ```
   Project Decisions ({N} total)

   1. {title}
      {reasoning — first 120 chars}…
      Recorded: {date}

   2. {title}
      {reasoning — first 120 chars}…
      Recorded: {date}
   ```

## Rules

- Do NOT output filler text before or after the list
- Truncate reasoning to 120 characters with `…`
- Order by most recent first (as returned by the endpoint)
- If the user asks for details, show the full reasoning for that specific decision
