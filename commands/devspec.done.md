---
name: devspec.done
description: Just finished some work? Log it to DevSpec — commits, testing notes, and all
allowed-tools: mcp__devspec__record_completed_work, mcp__supabase__execute_sql, Bash
---

# DevSpec Done

Record work that was completed outside DevSpec's action item workflow. Creates a completed action item retrospectively with implementation notes and linked commits.

## Steps

1. **Detect git state** — run these in parallel:
   - `git log --oneline -10` to get recent commits
   - `git diff --stat HEAD~10..HEAD 2>/dev/null || git diff --stat` to get affected files
   - `git branch --show-current` to get branch name
   - `git log --format="%H %s" -10` to get full SHAs and messages

2. **If no recent commits exist**, ask the user for a title and what they implemented, then skip to step 4.

3. **If recent commits exist**, auto-generate ALL of these fields from the git history. Do NOT ask the user for input — infer everything:
   - `title`: Summarize the work in one line (imperative tense requirement, e.g., "Add user profile page" not "Added user profile page")
   - `description`: 2-3 sentences describing what was needed (imperative/future tense, as if written before the work)
   - `implementation_summary`: What was actually done, decisions made, trade-offs (past tense)
   - `completion_summary`: User-friendly changelog entry (2-4 sentences). Written for end users, not developers
   - `testing_notes`: Numbered step-by-step manual testing instructions in markdown. Include what to click, what page to visit, and expected results. Specific enough for a non-developer tester
   - `usage_notes`: Where users can find this feature in the UI and how to use it. Written for end users
   - `commits`: Array of `{ sha, message }` from detected commits
   - `affected_files`: List of changed files from git diff
   - `branch`: Current branch name
   - `type`: Infer from commits (`fix` → `bug`, `feat` → `feature`, `refactor` → `improvement`, default `task`)
   - `priority`: Infer from scope — single file fix → `low`, multi-file feature → `medium`, critical/breaking → `high`
   - `tags`: Infer 2-4 relevant tags from changed files and commit messages (e.g., `ui`, `api`, `auth`, `layout`, `database`)

4. **Immediately call `record_completed_work`** (do NOT wait for confirmation) with:
   - `title`, `description`, `implementation_summary` (required)
   - `type`, `priority`, `tags`, `commits`, `affected_files`, `branch`

5. Extract the action item ID from the response. Then call **`mcp__supabase__execute_sql`** to set the fields that `record_completed_work` does not support:
   ```sql
   UPDATE action_items
   SET completion_summary = '{completion_summary}',
       testing_notes = '{testing_notes}',
       usage_notes = '{usage_notes}'
   WHERE id = '{action_item_id}';
   ```
   Use proper SQL escaping (double any single quotes in values).

6. **Output a brief summary** — no filler, just the result:
   ```
   ✓ Recorded: {title}
     {id (first 8)} · {type} · {priority} · {tags}
     {N} commits · {N} files · branch: {branch}
   ```

## Rules

- Do NOT ask the user to confirm, review, or edit the draft. Just create it immediately
- Do NOT ask about priority, tags, type, or any other field — infer everything from git history
- The user can edit the action item afterward if anything needs changing
- You MUST use `record_completed_work` — do NOT use `create_action_item`, `update_action_item`, or raw SQL to create the action item
- The only SQL you may run is the follow-up UPDATE for `completion_summary`, `testing_notes`, and `usage_notes`
- Write the title and description as a **requirement** (imperative tense), not as a past-tense summary
- The completion_summary should be written for end users, not developers
- The testing_notes MUST be numbered step-by-step instructions a non-developer can follow
- The usage_notes should describe where to find the feature and how to use it
- ALL fields are required — do not skip any
