---
name: devspec.work
description: Pick up a DevSpec action item by name, optionally brainstorm, implement it, push/merge per settings, and mark it done. Supports --unattended for fire-and-forget execution.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, Agent, mcp__devspec__get_project_summary, mcp__devspec__get_action_items, mcp__devspec__search_memories, mcp__devspec__get_action_item_history, mcp__devspec__claim_work_item, mcp__devspec__update_action_item, mcp__devspec__add_implementation_note, mcp__devspec__add_commit_reference, mcp__devspec__complete_work_item, mcp__devspec__generate_commit_message, mcp__supabase__execute_sql
---

# DevSpec Work

Pick up a specific action item, optionally brainstorm on it, implement the changes, push/merge based on project settings, and record completion — all in one flow.

## Steps

### Phase 0 — Load Settings & Detect Mode

1. **Detect unattended mode.** Check the user's input for `--unattended`, `unattended`, or `no interruptions`. Store as a boolean `is_unattended`.

   When `is_unattended` is true, these rules apply for the ENTIRE session:
   - **Never** stop to ask the user anything — no prompts, no confirmations, no "pick one" lists
   - **Never** wait for user input
   - If a decision requires human judgment, fail the item with a documented error rather than guessing
   - If the action item name matches multiple items, auto-select the highest-priority match (or the closest title match)

2. **Load project settings.** Call `get_project_summary` and read the `local_plugin_settings` field from the response. Store for later use. If the field is absent or null, use safe defaults:
   - `auto_push`: false
   - `auto_merge`: false
   - `target_branch`: "" (empty — will fall back to starting branch)
   - `branch_prefix`: "work/action-item-"
   - `custom_instructions`: "" (empty)

   If `auto_merge` is true, treat `auto_push` as true regardless of its stored value.

3. **Record starting branch.** Run `git branch --show-current` and store the result as `starting_branch`. This is the branch the developer was on and will be the merge target if `target_branch` is not set.

### Phase 1 — Resolve

4. **Resolve the action item.** Extract an action item identifier from the user's input (ID, partial ID, or title keywords). Strip any `--unattended` flag from the input before matching.
   - If an ID (or partial ID) is provided, call `get_action_items(status: "all")` and match by ID prefix.
   - If keywords are provided, call `get_action_items(status: "all")` and match by title.
     - **Interactive mode:** If ambiguous (multiple matches), present a short numbered list and ask the user to pick one.
     - **Unattended mode:** If ambiguous, auto-select the highest-priority match. If priorities are equal, pick the closest title match.
   - **Interactive mode:** If nothing is provided, ask the user for an action item name or ID.
   - **Unattended mode:** If nothing is provided, output `✗ No action item specified` and stop.
   - If no match is found, output: `✗ No action item found matching: {input}`
   - **CRITICAL:** Once resolved, store the **complete UUID** (e.g. `f43c187c-23e0-4764-885f-ef3a733d08df`) in working memory as `resolved_action_item_id`. Never truncate, pad, or reconstruct this value — always use the exact string returned by the API in every subsequent tool call.

5. **Load context.** Once resolved, call in parallel:
   - `get_action_item_history(action_item_id)` — prior notes, commits, status changes
   - `search_memories(query: "<action item title>")` — related decisions, conventions, risks

6. **Present the item:**
   ```
   ━━━ Work ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Title:    {title}
   ID:       {first 8 chars of id}  (display only — full UUID stored in working memory)
   Type:     {type}
   Status:   {status}
   Priority: {priority or "not set"}
   Mode:     {unattended or interactive}
   ─────────────────────────────────────────────────────────
   {description or "No description"}
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ```
   If there are `ai_instructions`, show them under an `Instructions:` line. If there are prior implementation notes or related memories, mention them briefly (e.g., "2 prior notes, 1 related decision").

### Phase 2 — Brainstorm (Optional)

7. **Unattended mode:** Skip this entire phase — proceed directly to Phase 3.

8. **Interactive mode — ask once:** `Brainstorm before starting? (y/n)`

9. **If yes**, run the brainstorm loop:
   - Ask up to 5 targeted questions, one at a time, drawn from this taxonomy (pick the most impactful gaps first):

     **Scope & Intent** — What is the core problem? What is out of scope?
     **Approach & Alternatives** — Implementation strategies? Existing patterns to follow?
     **Data & State** — Migrations, new entities, state transitions?
     **Edge Cases & Failure Modes** — Invalid inputs, concurrency, timeouts?
     **Dependencies & Integration** — Other systems, downstream impact?
     **Acceptance & Verification** — How do we know it's done? What does a tester verify?

   - For each question:
     - Provide a suggested answer: `**Suggested:** <proposal> — <1-sentence reasoning>`
     - Ask: `Agree, adjust, or provide your own answer.`
     - Accept on "yes"/"agree"/"suggested", skip on "skip"
   - Stop when 5 questions asked, user signals done, or all high-impact areas are covered
   - Compile a brainstorm summary and save it via `add_implementation_note(action_item_id, content: <summary>)`
   - Output: `✓ Brainstorm saved`

10. **If no**, proceed directly to Phase 3.

### Phase 3 — Implement

11. **Claim the item.** Call `claim_work_item(action_item_id)`. If the claim fails (already claimed by another agent), output `✗ Item already claimed` and stop.

12. **Create a branch** using the `branch_prefix` from loaded settings:
    ```bash
    git checkout -b {branch_prefix}{id_first_8_chars}
    ```
    If `branch_prefix` is empty, fall back to `work/action-item-`.

13. **Implement the changes.** Follow the action item description and any `ai_instructions`. Read existing files before editing. Follow existing code conventions. If the action item has brainstorm notes or prior implementation notes, use them to guide implementation.

    **Custom Instructions:** If `custom_instructions` is set in the loaded settings, you MUST follow those instructions during implementation. These are project-owner-defined rules that apply to every action item — e.g., which tools to use, which files to update, testing requirements, or additional steps to perform alongside the main task. Treat them as mandatory requirements, not suggestions.

    During implementation, whenever you complete a significant milestone (e.g., finished a major component, wired up an integration, completed a migration):
    - Call `add_implementation_note(action_item_id, content: <what was done and why>)` to keep a running log

14. **Test.** After implementation:
    - Run `npm run lint` if available (continue on failure but note it)
    - Run `npm test` if available (continue on failure but note it)
    - Run any test commands mentioned in the action item's `ai_instructions`

15. **Commit.** Stage only the files you changed — never use `git add -A`:
    ```bash
    git diff --name-only
    git add <file1> <file2> ...
    ```
    Then call `generate_commit_message` with:
    - `action_item_id`: the action item ID
    - `summary`: short summary of what the commit does (under 72 chars)
    - `type`: infer from the work (`feat`, `fix`, `refactor`, etc.)

    Use the returned message (which includes the `[devspec:<id>]` tracking tag) to commit:
    ```bash
    git commit -m "{generated_message}"
    ```
    The `[devspec:<id>]` tag in the message is what the deployment webhook uses to track deployments — do NOT construct the message yourself.

16. **Push** (if auto_push is enabled or implied by auto_merge):
    ```bash
    git push -u origin {branch_name}
    ```

17. **Merge** (if auto_merge is enabled):
    Determine the merge target: use `target_branch` from settings if set and non-empty, otherwise use `starting_branch` (the branch recorded in step 3).
    ```bash
    git checkout {merge_target}
    git merge {branch_name} --no-ff --no-edit
    git push origin {merge_target}
    ```
    If merge conflicts arise, fail the item with a descriptive error. Leave the branch pushed so the developer can resolve manually.

### Phase 4 — Done

18. **Report completion.** Call these in order:

    **a)** `add_implementation_note` — final summary of what was changed: which files were modified/created, what the changes do, and any decisions made.

    **b)** `add_commit_reference` — with the commit SHA and message.

    **c)** `complete_work_item` with ALL of these fields (never skip any):
      - `action_item_id`
      - `commit_sha`: the final commit SHA
      - `agent_merged`: true if auto_merge was performed, false otherwise
      - `affected_files`: list of changed files from `git diff --name-only`
      - `completion_note`: technical summary of what was done
      - `completion_summary`: A concise, end-user-friendly changelog-style summary (2-4 sentences). Written for non-developers — explain *what changed* and *why it matters* in plain language. Use markdown for formatting. Example:
        ```
        Added a "Testing" page to projects where testers can review completed work items with deployment status and testing instructions. Project members can now be assigned the new "Tester" role, which grants access to this page. The testing briefs are grouped by date and show deployment status alongside each item.
        ```
      - `testing_notes`: Step-by-step instructions a tester can follow to manually verify the change. Use markdown with numbered steps. Be specific — reference exact URLs, UI elements, and expected outcomes. For non-user-facing changes (refactors, infra), describe how to verify correctness (e.g. "Run `npm run typecheck` and confirm zero errors"). Example:
        ```
        1. Navigate to **Project → Members** and invite a user with the "Tester" role
        2. Log in as that user and verify the **Testing** nav item appears in the project sidebar
        3. Click **Testing** and verify completed action items appear grouped by date
        4. Expand an item and verify testing notes and description are shown
        5. Click "View action item" and confirm it links to the correct detail page
        ```
      - `usage_notes`: Where users can find this feature in the UI (e.g. "Navigate to Settings → Integrations → GitHub"). Set to empty string for non-user-facing work (refactors, infra, invisible bug fixes).
      - `verification_report`: Structured assessment of the change:
        - `verification_type`: `"automated"` if all checks passed, `"human_required"` if tests couldn't cover it, `"partial"` if some checks passed but human review is still needed
        - `automated_checks_passed`: list of checks that passed, e.g. `["typecheck", "unit tests"]`. Include every test command that was run and passed. If a check was skipped (e.g. node_modules unavailable), do not include it.
        - `human_review_needed`: list of things a human should verify and why, e.g. `["Visual layout of the new testing page — no automated visual regression tests", "Role-based access — requires logging in as different roles"]`. Be specific about *what* and *why*.
        - `confidence`: 0.0-1.0 score. 0.9+ = straightforward change with passing tests. 0.7-0.9 = tests pass but change is complex or touches critical paths. Below 0.7 = significant uncertainty.

19. **Update extra fields** via `mcp__supabase__execute_sql`:
    ```sql
    UPDATE action_items
    SET completion_summary = '{completion_summary}',
        testing_notes = '{testing_notes}',
        usage_notes = '{usage_notes}'
    WHERE id = '{action_item_id}';
    ```
    Use proper SQL escaping (double any single quotes in values).

20. **Output the result:**
    ```
    ━━━ Done ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    ✓ {title}
      {id (first 8)} · {type} · {priority}
      {N} files changed · branch: {branch}
      completion, testing notes, and usage notes recorded
      ─────────────────────────────────────────────────────
      {✓ or ✗} Push: {pushed to origin | off}
      {✓ or ✗} Merge: {merged to {branch} | off}
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    ```

## Failure Handling

If any step in Phase 3 or 4 fails:
1. Call `add_implementation_note` documenting what was attempted and why it failed
2. Call `update_action_item` with `agent_status: 'failed'` and `agent_error: <description>`
3. Output: `✗ Failed: {reason}`

## Rules

- Do NOT output filler text between steps — let symbols and structure communicate progress
- Do NOT ask the user to confirm or review the completion fields — infer everything from git and the action item
- In **interactive mode**, the ONLY user interaction is: picking the action item (if ambiguous) and the brainstorm phase
- In **unattended mode**, there is NO user interaction — zero prompts, zero confirmations
- Always read a file before editing it
- Stage specific files only — never `git add -A` or `git add .`
- Write the title and description fields as requirements (imperative tense), not past-tense summaries
- The completion_summary is for end users, not developers
- The testing_notes MUST be numbered step-by-step instructions a non-developer can follow
- ALL completion fields are required — do not skip any
- If the action item is too vague or requires human judgment to proceed, fail it with error "Requires human judgment" rather than guessing
