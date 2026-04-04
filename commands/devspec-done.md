---
name: devspec-done
description: Record completed ad-hoc work in DevSpec retrospectively
allowed-tools: mcp__devspec__record_completed_work, Bash
---

# DevSpec Done

Record work that was completed outside DevSpec's action item workflow. Creates a completed action item retrospectively with implementation notes and linked commits.

## Steps

1. **Detect git state** — run these in parallel:
   - `git log --oneline -10` to get recent commits
   - `git diff --stat HEAD~10..HEAD 2>/dev/null || git diff --stat` to get affected files
   - `git branch --show-current` to get branch name
   - `git log --format="%H %s" -10` to get full SHAs and messages

2. **If recent commits exist**, auto-generate a draft:
   - `title`: Summarize the work in one line based on commit messages (written as a requirement, e.g., "Add user profile page" not "Added user profile page")
   - `description`: Write 2-3 sentences describing what was needed (imperative/future tense, as if the requirement was written before the work)
   - `implementation_summary`: Summarize what was actually done, decisions made, and trade-offs
   - `commits`: Array of `{ sha, message }` from the detected commits
   - `affected_files`: List of changed files from git diff
   - `branch`: Current branch name
   - `type`: Infer from commits (`fix` → `bug`, `feat` → `feature`, `refactor` → `improvement`, default `task`)

3. **Present the draft** to the user for confirmation:
   ```
   Draft action item from git history:

   Title:    {title}
   Type:     {type}
   Description:
     {description}

   Implementation:
     {implementation_summary}

   Commits:  {N} commits linked
   Files:    {N} files affected
   Branch:   {branch}

   Confirm, edit, or provide type/priority/tags?
   ```

4. **If no recent commits exist**, fall back to manual input:
   ```
   No recent commits detected. Please provide:
   - Title (required)
   - What you implemented (required)
   ```

5. After user confirms or edits, call `record_completed_work` with:
   - `title`, `description`, `implementation_summary` (required)
   - `type`, `priority`, `tags` (optional)
   - `commits`, `affected_files`, `branch` (from git detection)

6. On success, output:
   ```
   ✓ Recorded in DevSpec
     Action Item: {id (first 8 chars)} — {title}
     Impl Note:   {implementation_note_id (first 8 chars)}
     Commits:     {N} linked
   ```

## Rules

- Do NOT output filler text before or after the confirmation
- Write the title and description as a **requirement** (imperative tense), not as a past-tense summary
- The implementation_summary should be past tense — what was actually done
- If the user says "looks good" or "confirm", proceed without changes
- If the user provides edits, apply them to the draft before calling the MCP endpoint
