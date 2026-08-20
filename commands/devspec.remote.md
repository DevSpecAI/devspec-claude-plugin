---
name: devspec.remote
description: Connect this Claude Code conversation to DevSpec as a first-class agent connection — available on the Agents page, attach to a session for a live transcript, driven from phone/web. Not Claude's built-in /remote-control.
argument-hint: "[--session <uuid>] [--new] [--private] [--title=\"label\"] [optional note]"
allowed-tools: Read, Grep, Glob, Bash, Agent, mcp__devspec__list_projects, mcp__devspec__register_connection, mcp__devspec__attach_connection, mcp__devspec__detach_connection, mcp__devspec__heartbeat_connection, mcp__devspec__get_connection_dispatch, mcp__devspec__create_session, mcp__devspec__post_session_message, mcp__devspec__get_session_transcript, mcp__devspec__create_action_item, mcp__devspec__update_action_item, mcp__devspec__get_action_item, mcp__devspec__search_action_items, mcp__devspec__get_memory, mcp__devspec__search_memories, mcp__devspec__record_memory, mcp__devspec__supersede_memory, mcp__devspec__retract_memory, mcp__devspec__get_resources, mcp__devspec__search_resources, mcp__devspec__get_resource, mcp__devspec__create_resource, mcp__devspec__update_resource, mcp__devspec__supersede_resource, mcp__devspec__archive_resource, mcp__devspec__reserve_work_items, mcp__devspec__claim_work_item, mcp__devspec__release_work_item, mcp__devspec__fail_work_item, mcp__devspec__record_implementation, mcp__devspec__report_progress, mcp__devspec__record_criterion_verdicts, mcp__devspec__classify_criterion, mcp__devspec__get_personal_instructions, mcp__devspec__update_personal_instructions, mcp__devspec__get_project_instruction_rules, mcp__devspec__write_project_instruction_rule, mcp__devspec__import_instruction_rules, mcp__devspec__preview_conflict_resolution
---

# DevSpec Remote Control

Register **this** conversation as a DevSpec **connection**: it appears on the Agents page as available capacity, can be driven from phone or web, and — when attached to a session — mirrors its turns into that transcript. A connection is independent of any session: it can be available with no session at all and still receive dispatched work.

This is **DevSpec** remote control, not Claude Code's built-in `/remote-control`.

---

## 1. Connect

One command does the whole deterministic setup — preflight, git remote and folder pin, conversation bond, registration, session attach, state file, poller, and a bounded room seed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/devspec-remote-connect.mjs" \
  --agent "Claude Code" --owner-pid "$PPID" [FLAGS]
```

Map what the user asked for onto flags — that mapping is the only judgement here:

| Invocation | Flags | Result |
|---|---|---|
| bare `/devspec.remote` | *(none)* | Available, **sessionless**. Not a degraded state — it is ready for dispatch. |
| `--session <uuid>` | `--session <uuid>` | Attach to that existing session. |
| `--new` | `--new` | Create a session, then attach. It is an ordinary **shared** session. |
| `--private` | `--private` | Only with `--new`. Alone or with `--session` it does nothing — say so rather than ignoring it. |
| `--name "…"` | `--name "…"` | Choose the codename instead of letting the server mint one. |

Pass `--owner-pid "$PPID"` exactly as written. Never hunt for the pid yourself (item `3cddb3b4`); on Windows `$PPID` is not a real Win32 pid and the script self-resolves the true owner.

**The script decides nothing.** It resolves facts and lets the server arbitrate scope. Do not pre-resolve the project, do not call `list_projects`, and never implement precedence between a git remote and a folder pin.

**Then do exactly three things:**

1. **Print its status block in this terminal.** Terminal only — never post it, or any connect/reconnect/"waiting for your command" chrome, into a session.
2. **Obey the instructions it printed.** Connect prints the four tiers in force (your owner's style and machine rules, the project's principles and execution rules), or says they are unchanged since this conversation last connected. They govern the whole run. Never invent one that is absent, and never disclose another user's.
3. **Arm the wake stream** — section 2. Non-optional.

If it exits non-zero, read the message: it names the failure (auth, no project resolvable, poller). Do not improvise a different connect path.

**A folder with no git remote and no pin** — a greenfield project whose code does not exist yet — is reported in the status block. Offer to write `.devspec/project.json` (`{"project_id": "<uuid>"}`) once the user names the project, at the repo root or the working directory. Never write it silently, put nothing but the id in it, and if a pin already names a **different** project, say which before replacing it.

**Never** attach to a session because it shared a repo, a cwd, or a recently-stopped agent. The bond is this conversation's alone.

---

## 2. The wake stream (required)

Connect prints the exact command. Run it with the **`Monitor`** tool, `persistent: true`, description `owner commands for <codename>`:

```
node ".../devspec-remote-wait.mjs" --connection-id <uuid> --owner-pid <pid> --stream --from-end
```

**Not** `Bash` with `run_in_background`, and never a timeout. A background task wakes you by *exiting*, which ties the listener to the turn; this host reaps background tasks at turn end, so the agent re-armed once per turn for ever (item `be0a929a`). `Monitor` wakes you by printing a line and `persistent: true` scopes it to the session — one arm serves the whole session.

The stream emits actor-labelled `canonical_advisory_context`, complete `canonical_command` objects, explicit `playbook_run` dispatches, typed `canonical_control` host events, and non-executable `wake` summaries. Conversational work comes only from complete canonical commands; a playbook event follows its explicit claim/run protocol. Claude Code cannot safely execute lifecycle controls from this script layer, so its control event is `supported:false`, never chat, and never acknowledged as executed. The stream keeps watching; there is nothing to re-arm between events.

**When the stream ends,** the Monitor surfaces an exit code:

| Exit | Meaning | Do |
|---|---|---|
| **3** | **Not a failure.** The monitor was stopped or an unanchored arm hit its 24h cap. It emits `listener_rollover` first. Your host may report this as the monitor "failing" — trust the event, not the label. | Arm again with `--stream --pending`. Do not re-register or stand down. |
| **1** | Something ended — *maybe* a human, maybe not | Check why, below. |
| **2** | Bad args | Fix the command line. |
| **0** | Only from the one-shot fallback | Act, then re-arm with `--pending`. |

On exit **1**, read `~/.devspec/remote-control/connections/<connection_id>.json`:

- `end_reason: "ui"` / `ended_from_ui: true`, or `/devspec.remote-stop` was run (`local_stop`) → **a person ended you. Stop, stay disconnected.**
- Owner process gone → stop; there is nothing to return to.
- **Anything else, or no reason at all** → the server will not vouch that a human did this, and a redeploy looks exactly like this. Re-run the connect command with the SAME conversation and re-arm. Do not stay dead.

Never infer a UI End from silence — that inference took every agent offline during a redeploy (brief `e691c68a`).

**Re-arming always uses `--pending`,** never `--from-end`: `--pending` drains mail already in the inbox, `--from-end` jumps the cursor to EOF and permanently drops it.

**Stop will refuse to end a turn deaf.** If a turn ends with no armed listener, or with commands unread, the Stop hook blocks and hands you the arm command. A session-scoped stream satisfies this from one arm, so you should never see it.

**Turn end is mechanical.** Stop clears the turn marker, heartbeats, and calls `report_complete`. Do not call it yourself. A spinner that persists after your reply has landed is a bond bug worth reporting, not something to paper over.

---

## 3. Canonical remote ingress (non-negotiable)

The live authority, wake, context, ordering, delivery and attachment policy is the
versioned product resource **`devspec://product/remote-ingress-contract`**. Do not
reconstruct that mutable policy from this command file.

The Monitor emits revalidated complete `canonical_command` objects from the durable
inbox. Act conversationally only on those objects. The top-level dispatch channel is
reserved exclusively for explicit `playbook_run` events; it never carries action-item
assignments. `canonical_advisory_context`, `wake`, poller notifications and all
`notification_preview` fields are non-executable. Canonical attachment metadata
includes a stable `resource_id`; keep that reference with the command.

---

## 4. Answering

**When attached, you must `post_session_message` the direct answer.** Prefer `connection_id` (the server resolves the current room) over a remembered `session_id`. Sessionless: use `report_progress` / the assignment protocol — never invent a chat post.

Body = the answer to the latest command. Lead with it. No preamble, no thinking, no tool play-by-play, no "I'll look into…" narration, no status chrome. As short as correctness allows.

**Attribution:** pass your `connection_id` on every write that produces a session card (`create_action_item`, `surface_session_action_items`). Action-item rows carry no agent identity of their own, so without it the server cannot tell two of your agents apart and renders no name at all (item `b6c447fd`).

Hooks are mechanical only: `UserPromptSubmit` may mirror a prompt bubble; **Stop does not post your answer**. You do.

---

## 5. Working a batch of items

**Nothing is ever sent work.** No dispatch, no routing, no queue to be handed from. When you are asked to work several items — in a command, in the room, by your owner — you take them yourself, and holding them is what stops another agent taking them mid-run:

1. **`reserve_work_items({ action_item_ids: [...], connection_id })`** — in the order you will work them. One reservation per connection at a time.
2. **Read `skipped` and say what it says.** An item another agent already holds comes back with a reason naming the holder, not an error. Silently working four of the five you were given is how an owner ends up believing something is in progress that nobody has.
3. Per item **in order**: `claim_work_item(action_item_id, agent_branch)` — pass your `connection_id` — implement in an isolated worktree, `record_implementation` when done (`report_progress` for long ones, `release_work_item` to hand one back).
4. **Nothing to resolve.** The batch closes itself when its last member is recorded, failed or released.

**How to implement is the product's contract, not this file's.** Read `devspec://product/implementation-contract` — the reserve response names its version, and there is exactly one resource. It is authoritative on worktree isolation, verification, evidence, commits and the boundary at `implemented`. Never restate it from memory here.

**Only the agent holding an item may claim, release or fail it**, and the server enforces that against your `connection_id` — not against your user, because your token is account-wide and cannot tell two of your own agents apart. Pass `connection_id` on those calls. An item held by an agent that died is released with `force` and a reason, which is always allowed and is recorded as a takeover naming who did it.

**There is no batch mode, because there is no mode at all.** Working a batch does not install a different set of rules for its duration, and finishing one does not clear anything. What was true of a batch is true of every run: ask only what is not yours to decide, never assume someone is waiting to answer, and fail the member with a precise reason rather than stalling on a question nobody may read.

**Fail loudly, never by chatting.** A member you cannot do safely → `fail_work_item` with a precise `error` (plus `partial_work_notes`), then continue with the next. A blocked member fails the member, not the batch. Never post a question and wait — nobody may be there.

Settle a `possible_conflict` yourself when the facts are plain: `related` / `not_a_conflict` close nothing, so resolve them with a recorded `basis`. Ask first only for `supersedes` (something closes), a counterpart someone else authored, or a user who has not shown they grasp — at the intent level — what would be reversed. State the consequence, not that a flag exists.

---

## 6. Capture what gets decided

**You** are the capture agent; decisions evaporate if they live only in this transcript. When the conversation settles something durable:

- **A fact, decision, convention, architecture choice or risk → a memory.** `search_memories` first, `get_memory` the closest match and read it in full, then `record_memory` or `supersede_memory`. The search result is a card: it tells you *which* memory, not whether replacing it is right.
- **An instruction someone must follow → a rule, not a memory.** A memory records what the team decided; a rule is what an agent is made to do about it every time. The same conversation often produces both.
  - Team: `write_project_instruction_rule` (`add`/`amend`/`retract`, one at a time). `get_project_instruction_rules` first.
  - The owner's own machine/tooling context: `update_personal_instructions`. This is the right home for anything true of *them across their machines* — it reaches every agent they run, everywhere, unlike a file on one box.
  - A repo `CLAUDE.md` full of team rules: offer `import_instruction_rules`, which categorises it for approval rather than pasting it in.
- Show the exact text and get a clear yes **before** writing, every time.
- **Read the `outcome` and report what it says.** `committed` = live now. `queued_for_review` = **not in effect** until a maintainer accepts it. Saying "done" when it is queued leaves someone believing their team's rules changed when they did not.
- Safety-class rules (branch protection, force-push, secrets) are maintainer-only and need `confirm_safety_change`. Never move a rule in or out of that class in passing.
- Do not rely on post-session extraction for this channel. Mirror a short confirmation into the room so the phone sees knowledge landing.

---

## 7. Stopping

`/devspec.remote-stop` — detaches and marks the connection offline immediately. Simply exiting Claude leaves a stale chip for ~90s until the poller notices its owner is gone.

---

Deeper background — the poller and wait protocol, the delivery contract, failure history and the no-plugin fallback — is in `docs/remote-control/`. It is not needed to run this command.
