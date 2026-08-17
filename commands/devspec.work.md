---
name: devspec.work
description: Pick up a DevSpec action item by name, optionally brainstorm, implement it in an isolated worktree, push/merge per settings, and record the implementation. Supports --remote to open a DevSpec remote-control channel (Agents page).
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, Agent, mcp__devspec__list_projects, mcp__devspec__get_project_summary, mcp__devspec__get_action_items, mcp__devspec__get_memory, mcp__devspec__search_memories, mcp__devspec__record_memory, mcp__devspec__supersede_memory, mcp__devspec__retract_memory, mcp__devspec__get_action_item_history, mcp__devspec__get_session_transcript, mcp__devspec__record_criterion_verdicts, mcp__devspec__classify_criterion, mcp__devspec__claim_work_item, mcp__devspec__update_action_item, mcp__devspec__spin_off_action_item, mcp__devspec__add_implementation_note, mcp__devspec__add_commit_reference, mcp__devspec__record_implementation, mcp__devspec__generate_commit_message, mcp__devspec__create_session, mcp__devspec__register_connection, mcp__devspec__attach_connection, mcp__devspec__detach_connection, mcp__devspec__heartbeat_connection, mcp__devspec__get_connection_dispatch, mcp__devspec__post_session_message, mcp__devspec__get_session_transcript, mcp__devspec__preview_conflict_resolution
---

# DevSpec Work

Pick up an action item, optionally brainstorm, implement it in an isolated worktree, push/merge per project settings, and record what you did.

## The contract you implement under

**DevSpec owns the rules; this file owns the Claude Code mechanics.** Read the product contract at the start of a run:

```
devspec://product/implementation-contract
```

One document. There used to be an `/attended` and an `/unattended` variant selected by a flag; the execution mode is gone, and nothing replaced it — whether to ask is a judgement you make from the item's intent and criteria, like any other.

It is authoritative and **non-overridable** on: tracking and claiming before you edit, repository isolation, running the configured checks, recording criterion verdicts from observed behaviour, tagging commits, pushing safely, calling `record_implementation`, **stopping at `implemented`**, and never calling `verify_action_item` without a present human directing it. Its `instruction_boundary` also fixes precedence: live owner command > owner agent rules > project agent rules > project principles — and none of them may weaken a product rule or shared-repo safety.

If you cannot read the resource (a host that negotiated MCP capabilities before the server advertised resources), fetch it through the script layer, which speaks raw JSON-RPC and never negotiates:

```bash
node -e "import('${CLAUDE_PLUGIN_ROOT}/hooks/scripts/mcp-call.mjs').then(async m=>{/* tools/call get_workflow_rules */})"
```

Do not restate contract rules from memory, and do not treat anything below as overriding it.

## Quality bar

Applies throughout Phase 3. Every commit passes the self-critique before staging.

**Reuse before you build.** Read the repo for *repo facts* (README, CONTRIBUTING, the directory you are about to change). The team's *operating rules* come from DevSpec — `agent_rules` and `owner_agent_rules` arrived with your claim. If the repo has a `CLAUDE.md`/`AGENTS.md` holding team rules rather than repo facts, don't treat it as a rival authority: say so and offer `import_instruction_rules`. Two unreconciled sources of rules is how an agent ends up obeying the stale one.

Then: search for an existing implementation before writing a new one; edit in the codebase's canonical location for that concern rather than inventing a second one. If you are about to create a parallel implementation of something that exists — a duplicate utility, a second version of a shared component — **stop**. Extend the existing one, or fail the item `"Requires human judgment: would duplicate <thing>, extension blocked by <reason>"`. Never ship a silent parallel implementation.

**Never ship:** hardcoded values a config system already owns (timeouts, limits, URLs, model strings, feature flags); error suppression without a log and a reason; type/lint escape hatches without a one-line justification; placeholder work (`TODO`, stubs that only log, flagged-off paths the item didn't ask for); a re-implemented helper.

**Pre-commit self-critique (not skippable, however small the change).** Read `git diff --staged` end to end and answer honestly: did I reuse the existing pattern or build a parallel one? Is a value I hardcoded already owned by config? Did I swallow an error silently? Did I use an escape hatch without saying why? Did I leave TODOs or stubs the item didn't ask for? What would a reviewer with no context flag first? Fix real issues before committing; if a fix would expand scope past the item, record the trade-off as an implementation note rather than shipping something broken.

## Phase 0 — Project and settings

**1. Read the invocation.** `--remote` / `remote control` → `is_remote`. That is the only modifier: it opens a control channel, it does not change what you are allowed to decide.

There is no attended/unattended mode. Two rules cover what it used to: **ask only what is not yours to decide** (never a detail the recorded intent and criteria already settle), and **do not assume someone is waiting to answer**. Before you have claimed anything, an unanswerable question means printing what you need and stopping. After you have claimed, it means `fail_work_item` with a precise reason — never a silent wait.

**2. Resolve the project.** Tokens are account-wide, so every project-scoped call needs a scope. Gather the facts and **let the server arbitrate** — never implement precedence yourself:

- `git remote get-url origin` → pass as `git_remote`.
- The nearest `.devspec/project.json` → pass its id as **`pinned_project_id`**, never as `project_id`. They differ on purpose: `project_id` is an explicit override that outranks a verified remote, while the pin ranks *below* one, so a stale pin copied in with a template self-corrects instead of hijacking the folder. Search the working directory, then each parent up to and including the git root, never at or above your home directory.
- Send whichever you have, or both.

Only if the server reports the repo is tracked by **more than one** project do you call `list_projects({ git_remote })`, show the candidates and ask which one — you cannot pick for someone. Nothing is claimed yet, so with no answer there is simply nothing to work on: print `✗ Requires human judgment: repo tracked by multiple DevSpec projects` and stop. With neither a pin nor a matching remote, print `✗ No DevSpec project tracks this repo, and there is no .devspec/project.json pin.` and stop — or, once the user names the project, offer to write the pin (`{"project_id":"<uuid>"}`, nothing else in it, never silently, and say which project you are replacing if one is already named).

**3. Remote mode (`is_remote`).** Register this run as a connection on the Agents page **before claiming work**. Default is **sessionless** — a chat session is optional shared context, never a prerequisite (delivery contract ADR `b98a39a9`).

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/devspec-remote-connect.mjs" \
  --agent "Claude Code" --owner-pid "$PPID" [--session <uuid> | --new] [--private]
```

Then arm the wake stream with the command it prints, using the **Monitor** tool (`persistent: true`). `/devspec.remote` holds the full rules — authority, attachments, the exit-code table, posting. Progress while implementing: attached → `post_session_message({ connection_id })`; sessionless → `report_progress` / implementation notes only, never invent a room.

**4. Load settings.** `get_project_summary({ project_id })` → the `execution` block: `auto_push`, `auto_merge`, `branch_prefix`, `commit_message_prefix`, `custom_instructions`, `agent_rules`, `test_commands` ({unit, e2e, typecheck}), `protected_paths`; plus top-level `owner_agent_rules`. The instruction texts live on `execution` only — the `autopilot` / `local_plugin_settings` blocks are deprecated mirrors carrying operational values.

**Keep `instruction_tiers_version` and `instruction_tiers_hash` from that response** and pass them to `claim_work_item` (step 10) as `known_instruction_tiers_version` / `known_instruction_tiers_hash`. The tiers ride on the claim response too, so without this a run pays ~4,800 characters for a second identical copy; matching values return `instructions_unchanged: true` instead. If you skipped this call or lost them, send neither and claim returns the tiers in full.

Defaults when absent: `auto_push` true, `auto_merge` true, `branch_prefix` `work/action-item-`, no commit prefix, empty instructions, **no** test commands (skip testing — never assume a JS toolchain), no protected paths. `auto_merge` true implies `auto_push`. An instruction in this run not to push or merge overrides the stored value; with no such instruction, honour it.

Store the `repos` array — `[{ id, full_name, target_branch, default_branch }]` — it is the source of truth for where each repo pushes. Store `database_targets` too if the item touches migrations.

**5. Record `starting_branch`** (`git branch --show-current`) — the final merge-target fallback.

## Phase 1 — Resolve the item

**6. Find it.** Always call the MCP tool for current state even if you touched this item earlier — it may have picked up feedback since. `get_action_items({ project_id, status: "all" })`, match by id prefix or title. Which item was meant is never yours to decide: ambiguous → show the candidates and ask; nothing given → `✗ No action item specified`; no match → `✗ No action item found matching: {input}`. In each case stop rather than guessing — nothing is claimed, so nothing is left dangling.

Store the **complete UUID** returned by the API. Never truncate, pad or reconstruct it.

**7. Load context** (mandatory, not skippable from session memory):
- `get_action_item_history(action_item_id)` — prior notes, commits, lifecycle, and verification feedback.
- `search_memories({ project_id, query: "<title>" })` — related decisions, conventions, risks.

Read `intent` (the why), `acceptance_criteria` (your definition of done — a diff that misses it is not done) and `ai_instructions` (constraints). Don't judge the fields complete and move on; the originating conversation often holds nuance they lost, which you pull after claiming (step 10).

**8. Non-staged activity.** Check `agent_activity` from the MCP response, not memory:
- **`awaiting_verification` / `done`** — scan history for feedback added *after* the last `completed` event (`verification_report` with `change_data.verified === false` is user feedback from the testing page). Show it, then act on it: the feedback IS the instruction, so treat it as extra requirements and go to Phase 3 — no re-claim needed, nothing to ask. No actionable feedback → say so and stop.
- **`in_progress`** by another agent → `✗ Item is currently being worked on by another agent`, stop. Claimed by you in a prior session → proceed.
- **`staged` / `ready`** → proceed.

**9. Present it:**
```
━━━ Work ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Title:     {title}
ID:        {first 8}  (display only — full UUID in working memory)
Type:      {type}
Lifecycle: {lifecycle}
Priority:  {priority or "not set"}
─────────────────────────────────────────────────────────
{description}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
Add an `Instructions:` line for `ai_instructions`, and mention prior notes/memories briefly ("2 prior notes, 1 related decision").

## Phase 2 — Brainstorm (only when asked for)

Run this phase only when the invocation asked for it — the `/devspec.brainstorm` command, or `brainstorm` in the input. A plain work run skips it without asking.

Run **rounds of 5 questions** drawn from: scope & intent · approach & alternatives · data & state · edge cases & failure modes · dependencies & integration · acceptance & verification. Pick the most impactful gaps first.

Each question offers `**Suggested:** <proposal> — <one-sentence reasoning>` then `Agree, adjust, or provide your own answer.` After each round, end automatically if the high-impact areas are covered (`All key areas covered — wrapping up brainstorm.`), otherwise ask `Continue brainstorming? (y/n)`. Stop immediately on "done"/"good"/"that's it"/"stop".

Save with `add_implementation_note(action_item_id, content: <summary>)` in markdown, then `✓ Brainstorm saved`.

## Phase 3 — Implement

**10. Claim.** `claim_work_item(action_item_id)`, echoing the `known_instruction_tiers_version` / `known_instruction_tiers_hash` you kept from step 4. Already claimed by another agent → `✗ Item already claimed`, stop. Already yours (returning for feedback) → skip.

**Read the originating conversation.** The response carries `session_context`. When `transcript_is_authoritative` is true — the item was *born* in that session — call `get_session_transcript({ session_id: session_context.originating_session_id, tail: 40 })` before implementing. Send `tail` (and `known_instruction_tiers_version` / `_hash` if you hold them): an unbounded seed re-pays the whole room, measured at ~26k tokens for a single catch-up. The response's `transcript_window` tells you whether more exists; page deliberately with `after_message_id` if it does. Don't skip this because the fields look complete — that is exactly the nuance it recovers. When `transcript_is_authoritative` is false the item fields are canonical and the transcript is optional background. If it reveals intent or criteria the item lacks, persist them with `update_action_item`.

**11. Isolated worktree** (never a branch-in-place — the main repo must never switch branches or hold another session's changes):

a. `pwd` → `main_repo`. Every path below derives from it, and you return here to merge.
b. `branch_name` = `{branch_prefix}{first 8 of id}` (fallback prefix `work/action-item-`).
c. `worktree_path` = `<parent_of_main_repo>/.<basename(main_repo)>-worktrees/task-<first8>-<unix_timestamp>` — the timestamp keeps retries and parallel runs from colliding.
d. `git worktree add "<worktree_path>" -b "<branch_name>"`. **Returning to an existing branch:** omit `-b`, and `git fetch origin "<branch_name>"` first if the local ref is missing. If the add fails, go to Failure Handling — never force-overwrite.
e. Link deps so checks can run without an install (best-effort; if it fails, note that dependency-based checks may be skipped and continue — never fall into `npm install`): `ln -s "<main_repo>/node_modules" "<worktree_path>/node_modules"`.
f. `cd "<worktree_path>"` — every git and test command through the push runs here.

**12. Implement.** Read files before editing. Follow existing conventions, the item's `ai_instructions`, brainstorm and prior notes. Apply the instruction tiers from step 4: `custom_instructions` (principles — how you build), `agent_rules` + `owner_agent_rules` (execution mechanics — checks before pushing, never `git stash`, commit only your own files, honour the target branch). Personal rules specialize local working style; shared-repo-safety rules always hold. Skip an empty tier.

Log milestones as you go with `add_implementation_note` — markdown, bullets, never one prose paragraph.

**Database migrations.** Never assume which database. `database_targets` from step 4 gives each connected DB with its non-secret `identity` (Supabase: `identity.externalId` is the project ref), `environment`, and the `branch_name` whose migrations target it.
- Pick the target whose `branch_name` matches the branch this repo pushes to (step 14b), or one with `branch_name: null` (all branches).
- Apply it with **your own** tooling pointed at that `identity` — DevSpec never applies migrations and never hands you the credential.
- Never select by `name` (they collide). If the match has `needs_reconnect: true`, a null `identity`, or your tooling can't reach it, **stop** and fail `"Requires human judgment: cannot reach migration target <identity.externalId>"` rather than applying to a default database. Be especially careful when `environment` is `production`.

**13. Check.** Run the configured `test_commands` that are set (unit, e2e, typecheck) plus anything the item's `ai_instructions` names. Continue on failure but note it. No commands configured → skip gracefully and note it; never invent commands or assume a toolchain.

**14. Commit, integrate, push, merge.**

a. Stage only what you changed — `git diff --name-only`, then `git add <file> …`, never `git add -A`. Get the message from `generate_commit_message({ action_item_id, summary, type })` and commit it verbatim: it carries the `[devspec:<id>]` tag DevSpec links commits and deployments by. Do not hand-write it.

b. **Resolve the merge target for the repo you are pushing**, in order: its entry's `target_branch` in the `repos` map (match `full_name` to this repo's origin) → that entry's `default_branch` → `starting_branch`. A multi-repo item pushes each repo to **its own** resolved branch.

c. **Integrate before pushing** (when merging): in the worktree, `git fetch origin {merge_target}` then `git merge origin/{merge_target} --no-edit`. Conflicts here are normal — resolve them yourself, never by discarding the other side; re-run step 13's checks if new commits arrived. Can't resolve confidently → `git merge --abort` and go to Failure Handling. Then `git push -u origin {branch_name}`.

d. **Merge from the main repo** (`cd "<main_repo>"` — git refuses the same branch in two worktrees). Push atomicity is the lock:
```bash
git fetch origin {merge_target}
git checkout {merge_target}
git merge --ff-only origin/{merge_target}
git merge {branch_name} --no-ff --no-edit
git push origin {merge_target}
```
- `--ff-only` fails → the local target has commits the remote lacks. Your own leftovers from a rejected attempt at THIS item → `git reset --hard origin/{merge_target}`. Anything else (the developer's local work) → do not discard; Failure Handling, and say so.
- The `{branch_name}` merge must be clean; conflicts were resolved in (c). If it conflicts, the target moved again → `git merge --abort`, repeat (c) **in the worktree, before removing it**, retry.
- Push rejected (non-fast-forward) → someone landed between fetch and push. Retry, bounded at 3: repeat (c), then this step. After the third, Failure Handling — the branch is pushed, so it can be resolved by hand.

e. **Remove the worktree — mandatory on every path**, merged or not (the branch and commits live in the repo independently). **Drop the `node_modules` link first:** on Windows it is a junction into the main checkout and `--force` recurses through it, wiping the real one (the `isSymbolicLink` guard means only a link is ever removed).
```bash
node -e "const fs=require('fs'),p='<worktree_path>/node_modules';try{if(fs.lstatSync(p).isSymbolicLink()){try{fs.unlinkSync(p)}catch{fs.rmdirSync(p)}}}catch{}"
git worktree remove "<worktree_path>" --force
```
Run from `main_repo`. If it fails (a file lock), wait and retry once; still failing → warn but don't block completion (`git worktree prune` reaps it later).

## Phase 4 — Done

**15. Report,** in order:

a. `add_implementation_note` — final summary: files changed, what they do, decisions made. Markdown with bullets, never one paragraph.

b. `add_commit_reference` — commit SHA and message.

c. `record_implementation` — **every field, none skipped**: `action_item_id`, `commit_sha`, `agent_merged`, `affected_files`, `completion_note` (technical), plus:
- `completion_summary` — 2–4 sentences for a non-developer: what changed and why it matters, plain language.
- `testing_notes` — numbered steps a non-developer can follow, naming exact URLs and UI elements. For invisible work, how to verify correctness ("Run `npm run typecheck` and confirm zero errors").
- `usage_notes` — where to find it in the UI; empty string for non-user-facing work.
- `verification_report` — `verification_type` (`automated` / `human_required` / `partial`), `automated_checks_passed` (every check that ran AND passed; omit skipped ones), `human_review_needed` (specific what and why), `confidence` (0.9+ straightforward and green; 0.7–0.9 complex or critical paths; <0.7 real uncertainty).
- `provider`: `"claude_code"`.
- `local_session_id` — the real UUID from `echo "${CLAUDE_CODE_SESSION_ID:-$CLAUDE_SESSION_ID}"`, so the developer can resume this exact session from the DevSpec UI. Pass the concrete value; **never** the literal `${CLAUDE_SESSION_ID}` text — MCP arguments are not shell-expanded, so a placeholder is stored verbatim and is useless. Empty output → omit the field. Never pass `machine_user_id`; the server defaults it to you.

d. `record_criterion_verdicts` — **after `record_implementation`, never before.** Promotion is recomputed on a verdicts write, so verdicts recorded first are read against the pre-implementation state and the item strands at `implemented` for ever.

Settle every acceptance criterion you can actually check. Evidence is two halves — what you **RAN or QUERIED** and what **CAME BACK** ("ran the suite" → "34 passed, 0 failed"). Reading the code you just wrote is inference, not observation, and settles nothing. Declining a line you could have checked is not the cautious option: it leaves mechanical work for a person. Use `unknown` when nobody has checked it *yet* (stays retryable), and `classify_criterion` when no tool ever could (taste, "does this look right") — never a tick for either, and never `unknown` for a line that genuinely needs a human.

This is reporting an observation, not signing anything off — see the boundary in the Rules below.

e. `record_memory` — **only if** the work taught you something durable about the *project*. `search_memories` first: it returns a card, so `get_memory` the closest match and read it in full, then `supersede_memory`/`retract_memory` the stale one rather than duplicating. Don't record aggressively or capture what the code already says.

**Memory or rule?** A fact or decision, with reasoning someone might revisit → **memory**. An instruction an agent should obey every time → **rule** (`write_project_instruction_rule`). *"We chose Broadcast over postgres_changes because RLS made client CDC undeliverable"* is a memory; *"never add client postgres_changes without documenting it"* is a rule. Filing a rule as a memory means nobody follows it; filing a decision as a rule strips the reasoning that justified it. Read the `outcome`: `queued_for_review` means **not in effect** until a maintainer accepts — never report it as done.

**16. Output:**
```
━━━ Done ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ {title}
  {id first 8} · {type} · {priority}
  {N} files changed · branch: {branch}
  completion, testing notes, and usage notes recorded
  ─────────────────────────────────────────────────────
  {✓ or ✗} Push: {pushed to origin | off}
  {✓ or ✗} Merge: {merged to {branch} | off}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Failure Handling

A "finally" block — it runs whichever Phase 3/4 step failed. Order matters: leave the main repo safe first, then record.

1. From `main_repo`: `git merge --abort`, `git rebase --abort` (harmless if there is nothing to abort).
2. **Remove the worktree** — drop the `node_modules` link first, exactly as in step 14e. Retry once after a brief wait. Never created (failed before step 11) → skip silently. The branch and pushed commits survive, so the work can be picked up.
3. `add_implementation_note` — what was attempted, which step failed, whether the worktree was cleaned up.
4. `update_action_item` with `agent_activity: 'failed'` and `agent_error: <description>`.
5. `✗ Failed: {reason}`

## Rules

- No filler between steps — let the structure carry it.
- Never ask the user to confirm or review completion fields; infer them from git and the item.
- The only thing you interrupt for in a work run is which item was meant. Everything else comes from the item, the instruction tiers and the contract.
- Always read a file before editing it. Stage specific files only.
- Implementation, checks and push happen in the worktree; merge and removal happen from `main_repo`. Never `git checkout -b` in the main repo — it pollutes a shared checkout and collides with concurrent sessions.
- Write titles and descriptions as requirements (imperative), not past-tense summaries.
- Too vague to do without guessing → fail `"Requires human judgment: …"`.
- **`record_implementation` lands the item at `implemented`. You never write `done`.** But `done` is not a human-only door: the server computes promotion, so an item reaches it either because its acceptance criteria are all settled with recorded evidence, or because a human verified it. Recording an honest verdict is therefore part of your job, not an overstep — what you must never do is call `verify_action_item` without a present human directing it. The authority boundary is the contract's (`core.stop-at-implemented`, `core.preserve-human-verification-authority`, `core.record-observations`); read it there rather than trusting a summary here. Report the item as implemented plus its check status, and stop.
- **Parking vs dropping.** `update_action_item(lifecycle: 'deferred')` parks it — reversible, and it counts as resolved so a deferred child stops holding its parent brief open. Distinct from `dismissed` (won't-do, terminal) and `blocked` (waiting on a dependency). When the parked work is genuinely *separate* future work that shouldn't reopen the brief, use `spin_off_action_item({ action_item_id, defer? })` — it extracts a standalone follow-up, detaches it from the brief, records a `derived_from` link and parks it. There is no `deferred` shortcut on `record_implementation`.
