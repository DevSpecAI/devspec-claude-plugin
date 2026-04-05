---
name: devspec.conventions
description: List coding conventions and standards from DevSpec
allowed-tools: mcp__devspec__get_conventions
---

# DevSpec Conventions

Show coding conventions and standards recorded for the project.

## Steps

1. Call `get_conventions` with `limit: 20`.

2. If no conventions exist:
   ```
   No conventions recorded yet. Conventions are captured during DevSpec sessions.
   ```

3. Format as a numbered list:

   ```
   Project Conventions ({N} total)

   1. {description — first 150 chars}…
      Recorded: {date}

   2. {description — first 150 chars}…
      Recorded: {date}
   ```

## Rules

- Do NOT output filler text before or after the list
- Truncate descriptions to 150 characters with `…`
- Order by most recent first
