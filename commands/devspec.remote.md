---
name: devspec.remote
description: Connect this Claude Code conversation to DevSpec as a first-class agent connection — available on the Agents page, attach to a session for a live transcript, driven from phone/web. Not Claude's built-in /remote-control.
argument-hint: "[--session <uuid>] [--new] [--private] [--title=\"label\"] [optional note]"
allowed-tools: Read, Grep, Glob, Bash, Agent, mcp__plugin_devspec_devspec__list_projects, mcp__devspec__list_projects, mcp__plugin_devspec_devspec__register_connection, mcp__devspec__register_connection, mcp__plugin_devspec_devspec__attach_connection, mcp__devspec__attach_connection, mcp__plugin_devspec_devspec__detach_connection, mcp__devspec__detach_connection, mcp__plugin_devspec_devspec__heartbeat_connection, mcp__devspec__heartbeat_connection, mcp__plugin_devspec_devspec__create_session, mcp__devspec__create_session, mcp__plugin_devspec_devspec__post_session_message, mcp__devspec__post_session_message, mcp__plugin_devspec_devspec__get_session_transcript, mcp__devspec__get_session_transcript, mcp__plugin_devspec_devspec__search_sessions, mcp__devspec__search_sessions, mcp__plugin_devspec_devspec__create_action_item, mcp__devspec__create_action_item, mcp__plugin_devspec_devspec__update_action_item, mcp__devspec__update_action_item, mcp__plugin_devspec_devspec__get_action_item, mcp__devspec__get_action_item, mcp__plugin_devspec_devspec__search_action_items, mcp__devspec__search_action_items, mcp__plugin_devspec_devspec__get_memory, mcp__devspec__get_memory, mcp__plugin_devspec_devspec__search_memories, mcp__devspec__search_memories, mcp__plugin_devspec_devspec__record_memory, mcp__devspec__record_memory, mcp__plugin_devspec_devspec__supersede_memory, mcp__devspec__supersede_memory, mcp__plugin_devspec_devspec__retract_memory, mcp__devspec__retract_memory, mcp__plugin_devspec_devspec__get_resources, mcp__devspec__get_resources, mcp__plugin_devspec_devspec__search_resources, mcp__devspec__search_resources, mcp__plugin_devspec_devspec__get_resource, mcp__devspec__get_resource, mcp__plugin_devspec_devspec__create_resource, mcp__devspec__create_resource, mcp__plugin_devspec_devspec__update_resource, mcp__devspec__update_resource, mcp__plugin_devspec_devspec__supersede_resource, mcp__devspec__supersede_resource, mcp__plugin_devspec_devspec__archive_resource, mcp__devspec__archive_resource, mcp__plugin_devspec_devspec__claim_automation_run, mcp__devspec__claim_automation_run, mcp__plugin_devspec_devspec__record_automation_run, mcp__devspec__record_automation_run, mcp__plugin_devspec_devspec__reserve_work_items, mcp__devspec__reserve_work_items, mcp__plugin_devspec_devspec__claim_work_item, mcp__devspec__claim_work_item, mcp__plugin_devspec_devspec__release_work_item, mcp__devspec__release_work_item, mcp__plugin_devspec_devspec__fail_work_item, mcp__devspec__fail_work_item, mcp__plugin_devspec_devspec__record_implementation, mcp__devspec__record_implementation, mcp__plugin_devspec_devspec__report_progress, mcp__devspec__report_progress, mcp__plugin_devspec_devspec__record_criterion_verdicts, mcp__devspec__record_criterion_verdicts, mcp__plugin_devspec_devspec__classify_criterion, mcp__devspec__classify_criterion, mcp__plugin_devspec_devspec__get_personal_instructions, mcp__devspec__get_personal_instructions, mcp__plugin_devspec_devspec__update_personal_instructions, mcp__devspec__update_personal_instructions, mcp__plugin_devspec_devspec__get_project_instruction_rules, mcp__devspec__get_project_instruction_rules, mcp__plugin_devspec_devspec__write_project_instruction_rule, mcp__devspec__write_project_instruction_rule, mcp__plugin_devspec_devspec__import_instruction_rules, mcp__devspec__import_instruction_rules, mcp__plugin_devspec_devspec__preview_conflict_resolution, mcp__devspec__preview_conflict_resolution, mcp__plugin_devspec_devspec__manage_plan, mcp__devspec__manage_plan, mcp__plugin_devspec_devspec__manage_poll, mcp__devspec__manage_poll, mcp__plugin_devspec_devspec__update_memory, mcp__devspec__update_memory, mcp__plugin_devspec_devspec__get_review_queue, mcp__devspec__get_review_queue, mcp__plugin_devspec_devspec__resolve_memory_flag, mcp__devspec__resolve_memory_flag, mcp__plugin_devspec_devspec__resolve_resource_flag, mcp__devspec__resolve_resource_flag, mcp__plugin_devspec_devspec__resolve_action_item_decision_flag, mcp__devspec__resolve_action_item_decision_flag, mcp__plugin_devspec_devspec__resolve_action_item_conflict, mcp__devspec__resolve_action_item_conflict, mcp__plugin_devspec_devspec__manage_knowledge_links, mcp__devspec__manage_knowledge_links, mcp__plugin_devspec_devspec__get_action_item_history, mcp__devspec__get_action_item_history, mcp__plugin_devspec_devspec__manage_discussion_point, mcp__devspec__manage_discussion_point
---

# DevSpec Remote Control

Register **this** conversation as a DevSpec **connection**: it appears on the Agents page as available capacity and — when attached to a session — can be driven from phone or web through that canonical conversation. A connection is independent of any session: sessionless means available without a chat transcript, not waiting for action-item work.

This is **DevSpec** remote control, not Claude Code's built-in `/remote-control`.

---

## 1. Connect

One command does the whole deterministic setup — preflight, git remote and folder pin, conversation bond, registration, session attach, state file and poller. The poller fills a local transcript of the whole room; the status block prints where it is:

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/devspec-remote-connect.mjs" \
  --agent "Claude Code" --owner-pid "$PPID" [FLAGS]
```

Map what the user asked for onto flags — that mapping is the only judgement here:

| Invocation | Flags | Result |
|---|---|---|
| bare `/devspec.remote` | *(none)* | Available, **sessionless**. No chat transcript; attach it to a session for a canonical conversation. Explicit automation runs remain a separate typed channel. |
| `--session <uuid>` | `--session <uuid>` | Attach to that existing session. |
| `--new` | `--new` | Create a session, then attach. It is an ordinary **shared** session. |
| `--private` | `--private` | Only with `--new`. Alone or with `--session` it does nothing — say so rather than ignoring it. |
| `--name "…"` | `--name "…"` | Choose the codename instead of letting the server mint one. |

Pass `--owner-pid "$PPID"` exactly as written. Never hunt for the pid yourself (item `3cddb3b4`); on Windows `$PPID` is not a real Win32 pid and the script self-resolves the true owner.

**The script decides nothing.** It resolves facts and lets the server arbitrate scope. Do not pre-resolve the project, do not call `list_projects`, and never implement precedence between a git remote and a folder pin.

**Then do exactly three things:**

1. **Print its status block in this terminal.** Terminal only — never post it, or any connect/reconnect/"waiting for your command" chrome, into a session. If the block includes a `warning:` about more than one DevSpec key, relay that text to the user **verbatim** (fingerprints only — never print a raw token).
2. **Obey the instructions it printed.** Connect prints the tiers in force at connect (your owner's machine rules, the project's principles and execution rules), or says they are unchanged since this conversation last connected. They govern the whole run. Never invent one that is absent, and never disclose another user's.

   **Response style is not one of them.** It belongs to whoever SENT the command you are answering, not to whoever owns this connection, and it arrives with that command as `sender_response_style` (see the `devspec-remote-command` skill). Apply it to the prose of your reply to that person. It is not an instruction about what work to do, what you may access, or whose authority you act under, and it never overrides the project's rules or your owner's machine rules. Which tier is delivered where is the served contract's decision, not this command's — read `devspec://product/remote-ingress-contract` rather than trusting this paragraph if the two ever disagree.
3. **Arm the wake stream** — section 2. Non-optional, with one exception: when the status block says `wake: ALREADY ARMED`, the DevSpec listener Claude Code started with this session already holds it. Do not arm a second reader; it would race the first for the same inbox.

If it exits non-zero, read the message: it names the failure (auth, no project resolvable, poller). Do not improvise a different connect path.

**A folder with no git remote and no pin** — a greenfield project whose code does not exist yet — is reported in the status block. Offer to write `.devspec/project.json` (`{"project_id": "<uuid>"}`) once the user names the project, at the repo root or the working directory. Never write it silently, put nothing but the id in it, and if a pin already names a **different** project, say which before replacing it. Then run connect again. The listener Claude Code started with this session may connect the newly pinned folder by itself within a few seconds; if the status block then says `wake: ALREADY ARMED`, it holds the wake and you arm nothing.

**Never** attach to a session because it shared a repo, a cwd, or a recently-stopped agent. The bond is this conversation's alone.

---

## 2. The wake stream (required)

Connect prints the exact command. Run it with the **`Monitor`** tool, description `canonical commands for <codename>`:

```
node ".../devspec-remote-wait.mjs" --connection-id <uuid> --owner-pid <pid> --stream --from-end
```

**Never** `Bash` with `run_in_background` — on either path below. A background task wakes you by *exiting*, which ties the listener to the turn; this host reaps background tasks at turn end, so the agent re-armed once per turn for ever (item `be0a929a`). `Monitor` wakes you by printing a line instead, so nothing has to die.

**Two `Monitor` schemas exist and the host chooses one per session — read the one you were served.**

| Its schema | Arm with | Re-arm |
|---|---|---|
| has a **`persistent`** property | `persistent: true` | never — one arm lasts the session |
| has **no** `persistent` (its `timeout_ms` says deadlines are capped and you can re-arm at expiry) | the **largest** `timeout_ms` it allows | at every expiry notice, with `--stream --pending` |

On the second, `persistent: true` is **accepted and silently discarded** — no error, and the arm still dies at `timeout_ms`. The schema is what tells you which arm you are holding; passing the flag never is.

The stream emits complete canonical commands as `owner_message` objects (the room itself is in the local transcript, not on the stream), explicit `automation_run` dispatches, typed `canonical_control` host events, and non-executable `wake` summaries. Conversational work comes only from complete canonical owner messages; an automation event follows its explicit claim/run protocol. Claude Code cannot safely execute lifecycle controls from this script layer, so its control event is `supported:false`, never chat, and never acknowledged as executed. The stream keeps watching; there is nothing to re-arm between events.

**When the stream ends,** the Monitor surfaces an exit code:

| Exit | Meaning | Do |
|---|---|---|
| **3** | **Not a failure.** The monitor was stopped, a bounded monitor hit its `timeout_ms`, or an arm that could not anchor to an owner pid hit its 24h cap. Only the last emits `listener_rollover` first — a bounded expiry arrives as the host's own notice with nothing ahead of it. Your host may call any of these "failing"; none of them is. | Arm again with `--stream --pending`. Do not re-register or stand down. |
| **1** | Something ended — *maybe* a human, maybe not | Check why, below. |
| **2** | Bad args | Fix the command line. |
| **0** | Only from the one-shot fallback | Act, then re-arm with `--pending`. |

On exit **1**, never read the raw state file. Ask the redacted status command and obey its `reconnect.instruction`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/remote-control-state.mjs" status \
  --connection-id '<connection_id>'
```

It alone translates a human UI/local stop or dead owner into `stand_down`; every unproven/recoverable server end says `reconnect`. The command prints presence booleans only—never the bearer or hidden plan capability.

Never infer a UI End from silence — that inference took every agent offline during a redeploy (brief `e691c68a`).

**Re-arming always uses `--pending`,** never `--from-end`: `--pending` drains mail already in the inbox, `--from-end` jumps the cursor to EOF and permanently drops it.

**Stop will refuse to end a turn deaf.** If a turn ends with no armed listener, or with commands unread, the Stop hook blocks and hands you the arm command. A `persistent` arm satisfies this for the whole session; a bounded one satisfies it until it expires, so meeting this block after an expiry notice is expected — re-arm, and never reach for a background task.

**Turn end is mechanical.** Stop clears the turn marker, heartbeats, and calls `report_complete`. Do not call it yourself. A spinner that persists after your reply has landed is a bond bug worth reporting, not something to paper over.

---

## 3. Handling what arrives

Everything the wake stream delivers — owner commands, advisory context, room awareness, automation runs, question answers, control events — is handled the same way whether it came from this stream or from the DevSpec listener Claude Code starts with the session. That protocol lives in one place, the **`devspec-remote-command`** skill: canonical ingress and who a command is from, the sender's response style, shared progress plans, asking one person a question, answering with `post_session_message`, working action items when asked, capturing decisions, and finding an earlier conversation. Read it before you act on the first command.

The status block already gave you this connection's `connection_id` and printed the tiers, so the skill's first step (`orient`) has nothing new to tell you in this conversation.


## 4. Stopping

`/devspec.remote-stop` — detaches and marks the connection offline immediately. Simply exiting Claude leaves a stale chip for ~90s until the poller notices its owner is gone.

---

Deeper background — the poller and wait protocol, the delivery contract, failure history and the no-plugin fallback — is in `docs/remote-control/`. It is not needed to run this command.
