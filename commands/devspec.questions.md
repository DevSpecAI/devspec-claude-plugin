---
name: devspec.questions
description: List unresolved questions flagged in DevSpec sessions
allowed-tools: mcp__devspec__get_unresolved_questions
---

# DevSpec Questions

Show open questions and unknowns flagged during DevSpec sessions that haven't been resolved.

## Steps

1. Call `get_unresolved_questions` with `limit: 20`.

2. If no unresolved questions exist:
   ```
   ✓ All questions resolved — no open unknowns.
   ```

3. Format as a numbered list:
   ```
   Unresolved Questions ({N} open)

   1. {question content — first 150 chars}…
      Flagged: {date}

   2. {question content — first 150 chars}…
      Flagged: {date}
   ```

## Rules

- Do NOT output filler text before or after the list
- Truncate question content to 150 characters with `…`
- Use the checkmark message for empty state to convey a positive signal
