---
name: devspec.work
description: Pick up a DevSpec action item by name, optionally brainstorm, implement it in an isolated worktree, push/merge per settings, and record the implementation. Supports --unattended for fire-and-forget execution.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, Agent, mcp__devspec__get_project_summary, mcp__devspec__get_action_items, mcp__devspec__search_memories, mcp__devspec__get_action_item_history, mcp__devspec__get_session_transcript, mcp__devspec__claim_work_item, mcp__devspec__update_action_item, mcp__devspec__spin_off_action_item, mcp__devspec__add_implementation_note, mcp__devspec__add_commit_reference, mcp__devspec__record_implementation, mcp__devspec__generate_commit_message
---

# DevSpec Work

Pick up a specific action item, optionally brainstorm on it, implement the changes, push/merge based on project settings, and record completion — all in one flow.

## Implementation Quality Standards

These rules apply throughout Phase 3 (Implement). Every commit passes the pre-commit self-critique before staging; violations must be fixed before committing.

### Reuse Before Build (before writing any code)

1. Read project documentation: any `CLAUDE.md`, `README`, `CONTRIBUTING`, or architectural notes at the repo root and in the directory you are about to modify. These are project conventions, not suggestions.
2. Search the codebase for existing implementations of what you are about to build. Grep/glob for similar names, adjacent utilities, shared modules, and the established pattern for the kind of problem you are solving.
3. Identify the canonical location for what you are changing. Projects usually have one established place for configurable values, one for shared utilities, and one for each cross-cutting concern. Edit there rather than creating a new location.
4. If you are about to create a parallel implementation of something the codebase already has — a duplicate utility, a second version of a shared component, a reimplementation of an existing flow — **STOP**. Either extend the existing implementation, or (in unattended mode) fail the item with error `"Requires human judgment: would duplicate <existing thing>, extension blocked by <specific reason>"`. In interactive mode, ask the user before proceeding. Never ship a parallel implementation silently.

### Forbidden Patterns

- **Hardcoded values** (timeouts, limits, retry counts, URLs, version/model strings, provider choices, default parameters, feature flags) that an existing config/settings system already owns. If a config exists for this concern, write the value there and read from it — never inline.
- **Silent error suppression**: no catch/except/rescue blocks that swallow the error without logging and without a clear justification. No "just make the test pass" catches. If you must swallow, log and add a one-line comment explaining why.
- **Type, compiler, or linter escape hatches without justification**: disabling type checks, using unsafe casts, ignoring linter rules, suppressing warnings. Always add a one-line comment explaining why the tool is wrong.
- **Placeholder work**: no `TODO: implement later`, no stub functions that only log, no disabled or feature-flagged paths the action item did not request.
- **Duplicating utilities**: if the project has helpers for common concerns (formatting, validation, API access, parsing, state transitions, etc.), use them. Do not re-implement a helper that already exists.

### Pre-Commit Self-Critique (mandatory before every commit in step 16)

Before staging and running `git commit`, read your staged diff end-to-end with `git diff --staged` and ask honestly:

1. Did I reuse the existing pattern, or did I build a parallel one?
2. Is any value I hardcoded also owned by a config/settings system? If so, does the config drive the runtime default, or did I introduce drift?
3. Did I swallow any errors silently? If yes, is there a log and a comment explaining why?
4. Did I use any type, compiler, or linter escape hatches without explaining why?
5. Did I leave TODOs, stubs, or "for now" paths that were not in the action item?
6. If a reviewer with no context saw this diff, what is the first thing they would flag?

Fix real issues before committing. If a fix would expand scope beyond the action item, add an implementation note explaining the trade-off — do not ship broken code. This pass is **not skippable** for "small" changes.

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
   - **CRITICAL: ALWAYS call the MCP tool to fetch current state.** Even if you worked on this item earlier in this session, your conversation context may be stale — the user may have re-queued the item with new feedback since your last interaction. Never rely on in-session memory for item lifecycle.
   - If an ID (or partial ID) is provided, call `get_action_items(status: "all")` and match by ID prefix.
   - If keywords are provided, call `get_action_items(status: "all")` and match by title.
     - **Interactive mode:** If ambiguous (multiple matches), present a short numbered list and ask the user to pick one.
     - **Unattended mode:** If ambiguous, auto-select the highest-priority match. If priorities are equal, pick the closest title match.
   - **Interactive mode:** If nothing is provided, ask the user for an action item name or ID.
   - **Unattended mode:** If nothing is provided, output `✗ No action item specified` and stop.
   - If no match is found, output: `✗ No action item found matching: {input}`
   - **CRITICAL:** Once resolved, store the **complete UUID** (e.g. `f43c187c-23e0-4764-885f-ef3a733d08df`) in working memory as `resolved_action_item_id`. Never truncate, pad, or reconstruct this value — always use the exact string returned by the API in every subsequent tool call.

5. **Load context.** Once resolved, **you MUST call these MCP tools** — do not skip them even if you worked on this item earlier in the session:
   - `get_action_item_history(action_item_id)` — prior notes, commits, lifecycle changes, **and verification feedback**
   - `search_memories(query: "<action item title>")` — related decisions, conventions, risks

   These calls are mandatory because the item's state may have changed since you last touched it (e.g., user re-queued with new feedback).

   **Understand the intent.** Read the item's spec fields: `intent` (the WHY — the problem and desired outcome), `acceptance_criteria` (your definition of done — the diff must satisfy it), and `ai_instructions` (constraints). If `intent` is missing or too thin to grasp the real goal — common when the item came from a terse conversation — and the item has a `source_session_id`, call `get_session_transcript({ session_id: <source_session_id> })` to recover the originating intent from the conversation that produced it. This is optional and on-demand: skip it when the spec fields already make the goal clear. When the transcript reveals intent or criteria the item is missing, persist it back with `update_action_item({ action_item_id, intent, acceptance_criteria })` so it's captured for next time.

6. **Handle non-queued activities.** After loading the history (from the MCP response, NOT from conversation memory), check the item's current `agent_activity`:

   - **`awaiting_verification`**: Scan the history for verification feedback (entries with type `verification_report`, `verification_failed`, `feedback`, or `comment` that were added *after* the most recent `completed` event). Pay special attention to `verification_report` entries with `change_data.verified === false` — these contain user feedback from the testing page. If feedback exists that indicates something is broken or missing:
     - Present the feedback prominently:
       ```
       ⚠ Verification feedback found:
       {feedback content}
       ```
     - **Interactive mode:** Ask `Address this feedback? (y/n)`
     - **Unattended mode:** Proceed automatically to fix the issues
     - If proceeding, treat the feedback as additional requirements and continue to Phase 3 (skip brainstorm). The item does NOT need to be re-claimed — it is already in progress.
     - If no actionable feedback exists, inform the user the item is awaiting verification with no outstanding issues and stop.

   - **`done`**: Same as `awaiting_verification` — check for post-completion feedback. If none, inform the user and stop.

   - **`in_progress`** (claimed by another agent): Output `✗ Item is currently being worked on by another agent` and stop. If claimed by this agent in a prior session, proceed.

   - **`queued`** or **`ready`**: Proceed normally to Step 7.

7. **Present the item:**
   ```
   ━━━ Work ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Title:    {title}
   ID:       {first 8 chars of id}  (display only — full UUID stored in working memory)
   Type:     {type}
   Lifecycle: {lifecycle}
   Priority: {priority or "not set"}
   Mode:     {unattended or interactive}
   ─────────────────────────────────────────────────────────
   {description or "No description"}
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ```
   If there are `ai_instructions`, show them under an `Instructions:` line. If there are prior implementation notes or related memories, mention them briefly (e.g., "2 prior notes, 1 related decision").

### Phase 2 — Brainstorm (Optional)

8. **Unattended mode:** Skip this entire phase — proceed directly to Phase 3.

9. **Interactive mode — ask once:** `Brainstorm before starting? (y/n)`

10. **If yes**, run the brainstorm loop in **rounds of 5 questions**, drawn from this taxonomy (pick the most impactful gaps first):

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
   - **After each round of 5 questions:**
     - If all high-impact areas are covered and no meaningful questions remain, end the loop automatically: `All key areas covered — wrapping up brainstorm.`
     - Otherwise, ask: `Continue brainstorming? (y/n)`
       - If **yes**: ask another round of up to 5 questions, covering taxonomy areas not yet explored or diving deeper.
       - If **no**: end the loop.
     - This continues indefinitely until the user declines or all areas are exhausted.
   - **Early exit:** If the user signals done at any point ("done", "good", "that's it", "stop"), end the loop immediately.
   - Compile a brainstorm summary and save it via `add_implementation_note(action_item_id, content: <summary>)`. Use markdown formatting — bullet lists, **bold** for key decisions, `code` for file/function names.
   - Output: `✓ Brainstorm saved`

11. **If no**, proceed directly to Phase 3.

### Phase 3 — Implement

12. **Claim the item.** Call `claim_work_item(action_item_id)`. If the claim fails (already claimed by another agent), output `✗ Item already claimed` and stop. If the item was already claimed by this agent (e.g., returning to fix verification feedback), skip this step.

13. **Create an isolated worktree (not a branch-in-place).**
    All implementation work happens inside a git worktree — a sibling directory with its own working tree that shares the main repo's object database. This is what makes concurrent `/devspec:work` sessions safe: the main repo never switches branches and never holds another session's uncommitted changes, so a commit here captures only *this* item's work. (This matches how `/autopilot` already isolates each item.)

    a. **Record the main repo path:** run `pwd` and store as `main_repo`. Every path below is derived from it, and you return here before merging.

    b. **Compute `branch_name`** = `{branch_prefix}{id_first_8_chars}`. If `branch_prefix` is empty, fall back to `work/action-item-`.

    c. **Compute `worktree_path`** as a hidden sibling directory of the main repo (the same convention `/autopilot` uses):
    ```
    <parent_of_main_repo>/.<basename(main_repo)>-worktrees/task-<id_first_8_chars>-<unix_timestamp>
    ```
    The `<unix_timestamp>` suffix guarantees a unique path even across retries or parallel runs.

    d. **Create the worktree:**
    ```bash
    git worktree add "<worktree_path>" -b "<branch_name>"
    ```
    **Returning for verification feedback** (the branch already exists from a prior run): attach a worktree to the existing branch instead of creating it — omit `-b`. If the branch ref is missing locally, fetch it first:
    ```bash
    git fetch origin "<branch_name>"          # only if the local branch ref is missing
    git worktree add "<worktree_path>" "<branch_name>"
    ```
    If `git worktree add` fails (path or branch already exists), go to Failure Handling — do not force-overwrite.

    e. **Link `node_modules` into the worktree** so lint/tests can run without a fresh install (best-effort — if there is no `node_modules` or the link fails, note that dependency-based checks may be skipped and continue; never fall into `npm install`):
    ```bash
    ln -s "<main_repo>/node_modules" "<worktree_path>/node_modules"
    ```

    f. **Change into the worktree.** Every `git` and test command from here through the push (step 17) runs with the worktree as the working directory:
    ```bash
    cd "<worktree_path>"
    ```

14. **Implement the changes.** Follow the action item description and any `ai_instructions`. Read existing files before editing. You are working inside the worktree from step 13 (a full checkout of the branch) — read and edit files there as normal. Follow existing code conventions. If the action item has brainstorm notes or prior implementation notes, use them to guide implementation. If returning to address verification feedback, focus specifically on the issues raised in the feedback.

    **Custom Instructions:** If `custom_instructions` is set in the loaded settings, you MUST follow those instructions during implementation. These are project-owner-defined rules that apply to every action item — e.g., which tools to use, which files to update, testing requirements, or additional steps to perform alongside the main task. Treat them as mandatory requirements, not suggestions.

    During implementation, whenever you complete a significant milestone (e.g., finished a major component, wired up an integration, completed a migration):
    - Call `add_implementation_note(action_item_id, content: <what was done and why>)` to keep a running log. Use markdown formatting — bullet lists, **bold** for key terms, `code` for file/function names. Never write as a single prose paragraph.

15. **Test.** After implementation:
    - Run `npm run lint` if available (continue on failure but note it)
    - Run `npm test` if available (continue on failure but note it)
    - Run any test commands mentioned in the action item's `ai_instructions`

16. **Commit.** Stage only the files you changed — never use `git add -A`:
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

17. **Push** (if auto_push is enabled or implied by auto_merge):
    ```bash
    git push -u origin {branch_name}
    ```

18. **Return to the main repo, merge, and remove the worktree.**

    a. **Return to the main repo.** The worktree has `{branch_name}` checked out, so the merge must run from the main repo (git refuses to check out the same branch in two worktrees):
    ```bash
    cd "<main_repo>"
    ```

    b. **Merge** (only if `auto_merge` is enabled). Determine the merge target: use `target_branch` from settings if set and non-empty, otherwise use `starting_branch` (recorded in step 3). Fetch the target first so a concurrent session's commits are included:
    ```bash
    git fetch origin {merge_target}
    git checkout {merge_target}
    git merge {branch_name} --no-ff --no-edit
    git push origin {merge_target}
    ```
    If merge conflicts arise, run `git merge --abort` and go to Failure Handling — the branch is already pushed, so the developer can resolve it manually.

    c. **Remove the worktree** — MANDATORY on every path, whether or not you merged (the branch and its commits live in the repo independently of the worktree):
    ```bash
    git worktree remove "<worktree_path>" --force
    ```
    Run this from `main_repo`. If removal fails (e.g. a file lock from a just-finished process), wait a moment and retry once; if it still fails, warn but do not block completion (`git worktree prune` can reap it later).

### Phase 4 — Done

19. **Report completion.** Call these in order:

    **a)** `add_implementation_note` — final summary of what was changed: which files were modified/created, what the changes do, and any decisions made. **MUST use markdown formatting** — bullet lists, `**bold**` for key terms, `` `code` `` for file/function names, and blank lines between sections. Never write as a single prose paragraph.

    **b)** `add_commit_reference` — with the commit SHA and message.

    **c)** `record_implementation` with ALL of these fields (never skip any):
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
      - `provider`: always pass `"claude_code"`
      - `local_session_id`: pass `${CLAUDE_SESSION_ID}`. Claude Code replaces this token with the real session UUID, which stamps the item so the developer can later resume *this exact session* with `claude --resume <id>` straight from the DevSpec UI. If the token was NOT replaced — i.e. the value you would send still looks like a placeholder (it contains the text CLAUDE_SESSION_ID) rather than a bare UUID — omit this field entirely rather than sending the placeholder. Do NOT pass `machine_user_id`: the server defaults it to you (the authenticated DevSpec user), which is exactly the developer whose machine ran this session.

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

Runs as a "finally" block — it MUST execute no matter which Phase 3 / Phase 4 step failed. Order matters: abort any in-flight git operation and clean up the worktree so the main repo is left safe, THEN record the failure.

1. **Abort any in-flight git operation and return to the main repo** (best-effort — these fail harmlessly if there is nothing to abort):
   ```bash
   cd "<main_repo>"
   git merge --abort
   git rebase --abort
   ```
2. **Remove the worktree** (MANDATORY, best-effort at the edges). From `main_repo`, run `git worktree remove "<worktree_path>" --force`; wait briefly and retry once if it fails. If the worktree was never created (the failure happened before step 13 added it), skip this silently. The feature branch and any pushed commits survive worktree removal, so the work can still be picked up.
3. Call `add_implementation_note` documenting what was attempted, which step failed, and whether the worktree was cleaned up.
4. Call `update_action_item` with `agent_activity: 'failed'` and `agent_error: <description>`.
5. Output: `✗ Failed: {reason}`

## Rules

- Do NOT output filler text between steps — let symbols and structure communicate progress
- Do NOT ask the user to confirm or review the completion fields — infer everything from git and the action item
- In **interactive mode**, the ONLY user interaction is: picking the action item (if ambiguous) and the brainstorm phase
- In **unattended mode**, there is NO user interaction — zero prompts, zero confirmations
- Always read a file before editing it
- Stage specific files only — never `git add -A` or `git add .`
- Implementation, testing, and the commit/push all happen inside the worktree from step 13; the merge and the worktree removal happen from the main repo. Never run `git checkout -b` in the main repo — that pollutes a shared checkout and collides with other concurrent sessions.
- Write the title and description fields as requirements (imperative tense), not past-tense summaries
- The completion_summary is for end users, not developers
- The testing_notes MUST be numbered step-by-step instructions a non-developer can follow
- ALL completion fields are required — do not skip any
- If the action item is too vague or requires human judgment to proceed, fail it with error "Requires human judgment" rather than guessing
- `record_implementation` lands the item at `implemented`, NOT `done`. NEVER offer to verify or "mark it done", and never call `verify_action_item` — reaching `done` is a separate decision a present human makes. After recording, report the item as implemented (plus its check status) and stop. In `--unattended` mode you never verify under any circumstances.
- **Parking vs. dropping an item.** Beyond shipping, an item can be set aside: `update_action_item(lifecycle: 'deferred')` parks it (consciously "not now" — reversible, resume with `update_action_item(lifecycle: 'open')`). `deferred` counts as resolved, so a deferred child no longer holds its parent brief open (a brief auto-completes once every child is verified, dismissed, OR deferred). It is distinct from `dismissed` (won't-do, terminal) and `blocked` (waiting on a dependency). When a parked child is genuinely SEPARATE future work that shouldn't reopen the original brief later, use `spin_off_action_item({ action_item_id, defer? })` instead — it extracts the child into a standalone follow-up item, detaches it from the brief, records a `derived_from` provenance link, and (by default) parks the new item as deferred. Never invent a `deferred` shortcut on `record_implementation`; these are explicit `update_action_item` / `spin_off_action_item` calls.
