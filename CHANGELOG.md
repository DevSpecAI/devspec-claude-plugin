# Changelog

All notable changes to this plugin are documented here. This project follows [Semantic Versioning](https://semver.org).

## 0.15.3 - 2026-08-18

### A claim covers the repository, so a worktree keeps it

Claim evidence was keyed on `git rev-parse --show-toplevel`, and a linked
worktree answers that with *itself*. So the claim vanished the moment the session
moved into one — which is precisely what the implementation contract asks agents
to do, and what `Agent(isolation: "worktree")` does to a delegated subagent.

Observed, with a claim held by the parent:

    ordinary subagent    -> ALLOWED
    worktree-isolated    -> DENIED (cwd .claude/worktrees/agent-<id>)

The isolated subagent could not write, and could not rescue itself either: the
item was already claimed by its parent, so its own `claim_work_item` would have
needed `force`. Delegating implementation to a subagent is a normal way to work,
and it silently lost the claim.

Evidence is now keyed on `git rev-parse --path-format=absolute --git-common-dir`,
which is the same path from the main checkout and from every linked worktree. One
repository, one identity. `EnterWorktree` mid-task keeps working for the same
reason. Session scoping is untouched — another session still cannot see your
claim — and a directory that is not a repository still falls back to itself.

**One-time effect when you upgrade:** the evidence key changes, so a claim you
are holding right now stops being recognised and needs claiming once more. There
is no dual-key compatibility path, deliberately.

Ordinary subagents were already fine and stay fine: the hook payload carries the
parent's `session_id`, not an agent-scoped one, so a delegated agent inherits the
claim it is working under. That is now covered by a test rather than assumed.

## 0.15.2 - 2026-08-18

### The guard works on Windows, and stops gating writes it has no interest in

**Windows was blocked outright.** `readEvidence` required `(mode & 0o077) === 0`
on both the state directory and the evidence file. Node synthesises permission
bits on Windows — directories report `0o777`, and `chmod` only toggles the
read-only attribute — so those checks were permanently true there and no claim
was ever readable: every mutation denied, for ever, exactly like 0.15.0 but
scoped to one platform. Restrictive modes are still set everywhere as a best
effort; they are only *asserted* where the platform can express them.

**Windows paths survive tokenisation.** Inside double quotes a backslash escaped
every character, so `"C:\Users\x\hooks\scripts\devspec-remote-connect.mjs"`
became `C:Usersxhooksscriptsdevspec-remote-connect.mjs` and resolved to nothing.
POSIX escapes only `$`, a backtick, `"`, `\` and a newline inside double quotes,
which is now what happens — a tokenizer that disagrees with the shell about a
word is the bug, not the safeguard. `\` + CRLF is a line continuation like `\` +
LF, so the documented multi-line connect invocation survives Windows line
endings, and `node.exe` is accepted alongside `node`.

**Your agent memory and scratchpad are no longer gated.** With no claim the guard
denied every write regardless of target, so an agent could not keep a note or
write its own memory — and the timing was the sharp end: the moment a lesson is
worth writing down is right after `record_implementation`, which is precisely
what clears the claim evidence. Writes inside `~/.claude/projects/*/memory/` and
a session scratchpad are now outside the gate, because nothing written there can
reach a commit.

That allowance is deliberately narrow. `~/.claude` is **not** permitted broadly —
`settings.json`, `CLAUDE.md` and `plugins/` live there and a write to any of them
could remove this hook. The temp directory is **not** permitted broadly — the
claim evidence lives under it, and an agent able to write there could mint its
own claim. Both exclusions are tests. Targets are canonicalised before the
comparison, so a symlink out of the memory directory into a repository resolves
and is denied, and containment holds on case-insensitive filesystems.

Real Windows and macOS execution was not performed for this release: platform
behaviour is injected and covered by simulation, and the path rules use `path`
APIs throughout rather than hand-rolled separators.

## 0.15.1 - 2026-08-18

### The claim guard could never unlock, and blocked the plugin's own commands

0.15.0 shipped a gate that no claim could open. Four fixes, all in
`hooks/scripts/claim-guard.mjs`:

- **A real claim is now observed.** `claim_work_item` answers with the claimed
  row spread beside the server's own flag — `{ ...claimed, claim_success: true,
  work_claim_ref }` — so the item is named by `id`. The guard demanded exactly one
  uuid in the whole payload and an `action_item_id` key, and a real response
  carries neither: it also contains `project_id`, `parent_action_item_id` and an
  id per acceptance criterion. No claim was ever recorded, so every `Write`,
  `Edit`, `NotebookEdit` and non-allowlisted `Bash` call was denied permanently,
  in every session. The suite passed because its fixtures were hand-written to a
  shape no server sends; they are now captured from real responses.
- **Evidence clears again.** Only `release_work_item` returns `success: true`.
  `record_implementation` and `fail_work_item` return the updated row, so
  requiring a success flag left a finished claim authorising mutation until it
  aged out.
- **`/devspec.remote` and `/devspec.remote-stop` work without a claim.** Both are
  `node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/…"` invocations, and `node` is not a
  read-only program, so both were denied — a deadlock, because remote control is
  how an agent becomes reachable for work in the first place. The allowance is
  keyed on script identity (resolved into this guard's own directory, one of five
  named control-plane scripts), never on the `node` program: `node -e`, `-p`,
  `--require`, `--input-type`, a same-named script elsewhere and backtick or
  `$(…)` arguments are all still denied.
- **Quoting is understood.** One tokenizer now parses the command, so a path
  containing a space survives: `git -C "/DevSpec Autopilot Plugin/repo" log`
  previously arrived as the verb `b/c`-style fragment and was denied, which is
  every plugin checkout on a normal machine. `<`, `>` and backticks inside quotes
  are literal text rather than a whole-command veto, and each segment of a
  compound is judged on its own — so `git add … && git commit -m "… [devspec:id]"`
  is possible again instead of being refused as "chained".

Unquoted redirection, subshells, command substitution, pipes into writers,
env-prefix attacks, `find -delete`, `git branch -D` and untagged commit
production are all still denied, with regressions for each.

## 0.15.0 - 2026-08-18

### A successful claim is required before mutation

- Session start points Claude Code to the canonical implementation contract at
  `devspec://product/implementation-contract` rather than embedding a lifecycle
  copy in the plugin.
- `Write`, `Edit`, `NotebookEdit`, and mutating `Bash` calls are denied until
  this session has observed the server's successful `claim_work_item` result.
  Conservative read-only shell compounds remain available before claim, and a
  project-level claim may cover file targets in several repositories. Successful
  matching record, fail, or release results clear the evidence.
- Direct commit-producing git commands are gated mechanically. Passing the guard
  never auto-approves a tool: Claude's ordinary permissions still apply.
  Arbitrary claimed Bash remains possible, so opaque scripts and configured git
  aliases are outside the command-text gate and remain an explicit residual.

## 0.14.0 - 2026-08-17

### Nine commands removed — two remain

`/devspec.work`, `.create`, `.commit`, `.link`, `.help`, `.done`, `.brainstorm`,
`.session-brainstorm` and `.verify-connection` are deleted. `/devspec.remote` and
`/devspec.remote-stop` stay.

**Why these two survive and the others do not.** Connecting runs a deterministic
script — resolve the project, pin the folder, register the connection, arm the
poller, write state — that a model improvises badly and that can be tested. That
is what earns a command. The other nine were a page of prose each, telling a
model to call one MCP tool it could already see.

**Nothing was lost.** What those commands actually taught now lives in the tool
schemas themselves, server-side, where it is written once and reaches every host
the moment it changes — instead of being copied into six repositories with no
way to notice when one drifts. `create_action_item` already coached intent and
acceptance criteria; `record_completed_work` already covered imperative titles
and who testing notes are written for.

**What you do instead:** say it.

    Work on DevSpec action item 4f2a
    Work these in order: 4f2a, 9c1b, 2e7d
    Log a DevSpec item for the login bug
    Write the commit message for 4f2a

DevSpec's web app copy buttons emit exactly these lines, so "copy" and "type it
yourself" produce the same thing. A sentence also works in a host with no plugin
at all, which a slash command never could.

**`--plan` note for Cursor users:** `devspec.brainstorm` was the only route to
Cursor's plan mode from DevSpec, so that goes with it. If you want plan mode it
should come back as a deliberate feature, not as a leftover.

**The README's "Stage for Autopilot" section is also gone.** It described work
being handed to an idle session — a dispatch model deleted some time ago
(`13958ab4`). Nothing is ever sent work now: an agent reserves what it was asked
to do.

## 0.13.0 - 2026-08-17

### An agent reserves its work — nothing is dispatched to it any more

`get_assignment`, `acknowledge_assignment` and `resolve_assignment` are gone from the server, along with `get_next_work_item`. There was nothing left for them to do: the dispatch model that sent work to an agent was deleted, so there is no batch to receive, no receipt to give, and nothing to close.

What replaces them is one verb. **`reserve_work_items({ action_item_ids, connection_id })`** — the ordered set you are about to work, held so no other agent takes it mid-run — then `claim_work_item` per item as you reach it. The batch closes itself when its last member is recorded, failed or released.

**`/devspec.work id1,id2,id3` now reserves the set up front.** The app has emitted one command carrying several ids since 0.12; until now the agent claimed them one at a time with nothing holding the rest, so a second agent could take id3 while the first was still on id1.

**Read `skipped`.** An item another agent already holds comes back with a reason naming the holder rather than failing the call — and reporting the batch as yours anyway is how an owner ends up believing work is in progress that nobody has.

### Only the agent holding an item can release or fail it

`release_work_item` and `fail_work_item` had no ownership check at all, and `claim_work_item`'s compared USERS — which cannot tell two of your own agents apart, because a DevSpec token is account-wide. On 2026-08-16 a sibling connection released work another agent was actively on, leaving the item unclaimed while the reservation still said claimed.

All three now check the reservation against the `connection_id` you pass, server-side. Pass it. A stale hold — an agent that died mid-run — is still always releasable with `force` and a reason, and is recorded as a takeover naming who did it, rather than reading like the holder handing work back.

## 0.12.0 - 2026-08-17

### `--unattended` is gone, and nothing replaced it

The work command took a flag that installed a mode for the whole run: never ask, never wait, auto-pick when a name is ambiguous. It read like a safety feature and was really a licence to guess, and on this host it was not even true — a run marked unattended still narrates its whole result into the terminal, so the operator sits watching a live terminal anyway. The mode existed in the protocol and not in reality.

It is deleted: the flag, the `Mode:` line in the item header, the per-step "interactive asks / unattended does X" forks, and the two mode-specific contract resources (`devspec://product/implementation-contract/attended` and `…/unattended`) which are now one document at `devspec://product/implementation-contract`.

Nothing takes its place — no timeout, no patience window, no ask-policy setting. Two rules already cover it. **Ask only what is not yours to decide**, never a detail the recorded intent and acceptance criteria already settle. And **do not assume someone is waiting to answer**: before you have claimed anything, an unanswerable question means saying what you need and stopping; after you have claimed, it means failing the item with a precise reason. Neither depends on whether a human happens to be watching, which is the thing the mode was pretending to know.

The brainstorm phase no longer asks whether you want it — it runs when the invocation asked for it, and a plain work run skips it silently.

## 0.11.2 - 2026-08-16

### Connect reports the session you are actually on

Re-running connect on a conversation that was already attached printed `Session: none — available`. The connection was still in its room — the state file and the poller both had it — but the status block was reading the session *this invocation had attached*, and a bare re-run attaches nothing. So it reported a room-less connection that was in a room.

That is not a cosmetic difference. An agent that believes it is sessionless answers with `report_progress` instead of `post_session_message`, which means its reply goes somewhere the person driving it cannot see. The same bug also skipped the orientation seed, so a re-connecting agent got no room context at all.

Connect now reports what was persisted rather than what this run happened to do.

## 0.11.1 - 2026-08-16

### Reconnecting no longer throws away the mail that arrived while you were gone

0.11.0's connect printed its wake-stream command with `--from-end` every time. That flag does not merely start reading at the end of the inbox — the wait script *writes* the new offset — so an agent that reconnected and ran the printed command exactly as given permanently discarded any owner message the poller had already written while it was disconnected. The command file said to use `--pending` when arming an existing connection; the script it told you to run contradicted it.

Connect now prints `--from-end` only for a connection created moments earlier, which cannot have an inbox yet, and `--pending` for everything else — a soft reconnect, an already-live conversation re-running connect, or a connection being attached to a session. When it prints `--pending` it says why, so the difference is visible rather than mysterious.

Found by using it: the first reconnect through the new path printed the wrong flag.

## 0.11.0 - 2026-08-16

### Connecting stopped being a ceremony

Connecting used to be something the model *performed*: check node, read the git remote, resolve the conversation id, look up the bond, list the projects, register, attach, write state, start the poller. Nine steps, each a tool call with a result and a line of narration — and not one of them needed judgement. Measured on a cold session, that ritual and the command file describing it accounted for **34.5k tokens** of an 87.7k connect footprint.

- **One command now does all of it.** `hooks/scripts/devspec-remote-connect.mjs` resolves the facts, registers, attaches if you asked for a session, writes state, starts the poller, seeds the room, and prints both the status block and the exact wake-stream command to run next. `/devspec.remote` went from 39,061 to 14,889 bytes; `/devspec.work` from 45,643 to 24,278.
- **It decides nothing.** It sends the git remote and the folder pin up as facts and lets the server arbitrate scope — which is what lets a stale pin copied in with a template correct itself instead of hijacking a folder. The `list_projects` round-trip is gone entirely: the server resolves the project from the remote.
- **Reconnecting no longer re-reads what you already know.** The connection state now retains the instruction-tier fingerprint, so a reconnecting conversation is told the tiers are unchanged instead of being handed all four again. Orientation reads are bounded and echo that fingerprint, so the same texts are never sent twice inside one connect — and the seed always reports how much of the room it saw, so a bound is never a silent truncation.
- **`/devspec.work` points at the product contract** (`devspec://product/implementation-contract/{attended,unattended}`) instead of restating its rules. DevSpec owns what an implementation must do; the command file owns only the Claude Code mechanics for doing it here.
- The long-form background — the poller and wait protocol, the failure history, the no-plugin fallback — moved to `docs/remote-control/`, where it is available when someone is debugging and absent when they are not.

Nothing about the pump changed: `devspec-remote-poll.mjs` and `devspec-remote-wait.mjs` are untouched. Item `5a393e4c`.

## 0.10.0 - 2026-08-14

### A session an agent opened is just a session

- **`--new` no longer creates a private session.** It creates an ordinary shared one, visible to the project like any other. Privacy was never asked for — it was inherited from the entry point, so opening a channel from a terminal quietly produced a room your team could not see, and it stayed that way until somebody noticed.
- **`--private` is the new opt-in.** `/devspec:devspec.remote --new --private` creates the session private, for the times you actually want that. On its own or with `--session` it does nothing, and the command says so rather than ignoring it silently. Access is still one dial away in the session's People panel afterwards, as it always was.
- **The "Remote" badge is gone from the sessions list** (server side). How a session was opened is not a property worth labelling on every row; who is attached is already shown by the connection strip and the Agents page. The "Remote control" type filter still exists for anyone who wants to narrow to them.
- **The "Private" badge now means what it says.** It was only ever drawn on remote-control rows, so a private ordinary session looked identical to a shared one. It now shows for any private session, whatever its type.

Nothing about private sessions is removed — only the assumption that an agent wanted one. Item `32801088`; server side in DevSpecV2.

## 0.9.0 - 2026-08-14

### A folder with no repo can say which project it belongs to

- **Reads `.devspec/project.json`.** A folder with no git remote — a project you started in DevSpec before the code existed — can now name its project with a one-line pin file: `{ "project_id": "<uuid>" }`. Every command that resolves a project reads it: `/devspec.work`, `/devspec.create`, `/devspec.done`, `/devspec.brainstorm`, `/devspec.remote`, `/devspec.verify-connection`.
- **"No DevSpec project tracks this repo" is no longer a dead end.** That hard stop now fires only when there is neither a pin nor a matching remote. Before this, planning a project in DevSpec and having an agent write the code was impossible for anyone with more than one project: every call failed at resolution.
- **The pin is passed as `pinned_project_id`, never as `project_id`.** They are not interchangeable. `project_id` is an explicit override that outranks a verified git remote; the pin is only a local assertion, and the server deliberately ranks it BELOW a remote it can verify. Commands send whichever signals they have and let the server arbitrate — precedence is never decided locally.
- **A real remote always wins.** So a pin that arrives by copying a template or forking quietly stops mattering the moment the folder has its own repo, instead of hijacking it. And because the pin holds no file paths, moving or renaming the folder never breaks it.

Item `6faa4044`; server side `ceda04b7`. Also bumps `marketplace.json`, which was left at 0.8.0 by the previous release.

## 0.8.1 - 2026-08-14

### A quiet connection stays up while the host process is alive

- **Removed the 72h idle-disconnect.** The poller no longer stamps `idle_timeout` and exits after three quiet days. A connection lives as long as its Claude Code process, unless you End it or run `/devspec:devspec.remote-stop`. Item `addbfdbf`.

## 0.8.0 - 2026-08-11

### The `/autopilot.*` commands are gone — staged work now arrives at any idle connection

**Migration:** if you used `/devspec:autopilot.start` (or `--drain` / `--all` / `--items` / the other queue flags), there is nothing to relearn and nothing to install: stage the items in DevSpec (**Stage for Autopilot** / approve a plan) and keep an ordinary `/devspec:devspec.remote` session idle. DevSpec hands the batch to it. `/devspec:autopilot.status` / `.stop` / `.history` have no local loop left to report on — the Agents page is the status, `/devspec:devspec.remote-stop` is the stop, and run history is the assignment and item record.

- **The plugin no longer chooses its own work.** The old loop pulled a global queue with `get_next_work_item` and decided locally what to take; the server now routes a staged batch to a connection and the plugin only ever works what it was handed. The filter flags existed only to steer that self-selection, so they die with it rather than being silently reinterpreted.
- **Unattended is a mode, not a command.** The only real difference between an interactive agent and an unattended one was ever the instruction set — "read the room" versus "work the batch, fail loudly, don't chat". That second set is exactly what a dispatched assignment needs, so it now lives in one place: the dispatch-protocol section of `/devspec:devspec.remote` (step 8a), which states explicitly that batch rules override conversational rules for the duration of the batch. No replacement command, skill or `--unattended`-on-remote flag is created.
- **`fail_work_item` joins the remote allow-list** so a batch member that can't be done safely fails loudly and the batch continues, instead of stalling on a question nobody is there to answer.
- The same deletion lands across the Cursor, OpenCode, Grok, Antigravity and Codex plugins under the same item, so the concept doesn't survive in one tool after leaving another.

Item `3f2f390c`.

## 0.7.4 - 2026-08-07

### A screenshot can no longer go missing between the inbox and the agent

- **The 0.6.2 fix only covered half the path, and the other half lost a screenshot six days later.** Attachments were decoded to disk when the wait script *printed a stream event*; the inbox line kept the raw payload, deliberately, as "the durable record". But a long owner command is **truncated** in the host's notification, so the only way to read the whole thing is to open `inbox.jsonl` — precisely the path the fix did not cover. The obvious reader there is `console.log(m.content)`, and the attachment vanishes with nothing said to anybody. That is what happened on 2 Aug, on a build that already had the fix.
- **Decoding now happens when the inbox is WRITTEN, not when it is read.** The record is self-describing: every attachment in it is a descriptor naming a real file on disk. A reader that prints only `content` can no longer silently lose one, because there is no longer a payload hiding behind it. This also keeps the poller's own `.poll.log` free of base64 — 1.37MB per command for a 500KB screenshot.
- **The advisory tiers get the same treatment.** `owner_ambient` and `room_context` are room messages like any other and can carry a teammate's screenshot. They are still never acted on, but an agent reading the room can now open what the room was looking at.
- **Materialisation is idempotent, which is load-bearing rather than tidy.** The wait script still runs it over everything it reads. Without a pass-through for its own descriptors it would look for a payload, find none, and drop the attachment — a worse bug than the one being fixed. It is asserted directly in the tests, and it is also what keeps inbox lines written by an **older** poller working, since a running poller keeps the code it started with until the agent is relaunched.
- **The command doc now says attachments exist at all.** It never did — so the only record of the trap was one agent's private memory on one machine. It now states that a `delivery: "file"` path is part of the instruction, and that an ad-hoc inbox reader must print `attachments` alongside `content`.

Item `b237de43` (the write half of `99165e12`). Claude Code plugin only — the other families are independent and are not being synced.

## 0.7.3 - 2026-08-04

### Memory search returns a card now, so the plugin has to be able to read the body

DevSpec's `search_memories` (and `get_decisions` / `get_conventions`) changed today: they return a **card** — title, one-line summary, id, state — instead of full memory bodies, because a 15-result search was returning over 600,000 characters. The full text now comes from a new `get_memory` tool.

- **Five commands could have found a memory and never read it.** `devspec.brainstorm`, `devspec.remote`, `devspec.session-brainstorm`, `devspec.work` and the `autopilot` skill all allow-list `search_memories`, and an `allowed-tools:` list is a hard gate — a tool absent from it cannot be called. `get_memory` did not exist when those lists were written, so without this release those commands get cards and have no way to reach the body. Nothing errors; the agent just quietly has less to reason with.
- **The instruction it broke was the safety-relevant one.** Four of those commands say "`search_memories` FIRST and `supersede_memory` the stale match instead of duplicating". Yesterday that judgement was made against full bodies. On cards alone, an agent would overwrite an entry in the team's shared decision record having read only its one-line summary. Each of those now says to `get_memory` the match and read it in full first — a card is enough to choose WHICH memory you mean, not enough to justify replacing it.
- **The autopilot loop needed more than a tool name.** Its memory step is marked *MANDATORY — never skip* and tells the agent to treat what comes back as **hard constraints**. A constraint is exactly the thing you cannot safely obey from a summary: the summary states the decision, the body carries the qualifications and exceptions. That step now says to `get_memory` any card that looks like it binds the work — an unattended loop obeying a constraint without its exceptions is how it confidently does the wrong thing.

Nothing else needs reinstalling for the DevSpec-side change: MCP tool definitions come from the server, so a reconnect picks up the renamed `body` parameter and the now-required `title` on `record_memory`. **This release is required only because `allowed-tools:` lists ship inside the plugin.**

Item `93a851b5`.

## 0.7.2 - 2026-08-02

### A connected agent no longer wakes itself up once a day for nothing

- **Measured, not theorised.** The 24h cap fired on schedule two days running against a healthy owner-anchored stream. Each firing spent a model turn on a wake that carried no owner mail and a re-arm that changed nothing — and the host reported the non-zero exit as a failure on top of that. `be0a929a`'s own intent named this cost before it happened: *"in a metered product that is real money spent on zero work."*
- **The cap was buying nothing there.** A deadline is a zombie backstop, not a policy. An owner-anchored arm already exits the moment the owning agent process goes, which is exactly the contract the poller has always run on with **no** time cap — it was at 2d+ uptime while this was written. So an anchored `--stream` arm now has no deadline at all.
- **An arm that cannot anchor still keeps the cap**, because for that one the clock is the only remaining guarantee that it cannot outlive its owner. That is the case `remote-control-state.mjs` already refuses to start a *poller* in, and it must not be given up here either.
- **The one-shot fallback keeps its cap unconditionally.** That asymmetry is deliberate: a one-shot arm is expected to be short-lived, so its 24h rollover is a rare edge case rather than a daily event, and exit-3-at-24h is a contract `d655b2a4` established on purpose.

Item `be0a929a`.

## 0.7.1 - 2026-08-01

### A 24-hour rollover no longer looks like a crash

- **Observed in real use, one day after 0.7.0 shipped.** The wake stream hit its 24h cap exactly as designed, emitted its `listener_rollover` notice and exited 3 (non-terminal, "re-arm me"). The host then reported that as **"script failed (exit 3)"** — so a routine rollover reads, at a glance, like something broke. This is the same misreading `d655b2a4` was filed for, in new clothing: a non-terminal end that looks like an ending, which historically provokes the harmful reflex of re-registering a perfectly live connection.
- **The rollover notice now says so explicitly** — that the host may label the exit a failure, that it is not one, and that nothing is lost because re-arming resumes from the same cursor. The exit table says the same, and to trust the event over the host's summary label. The truth goes where the agent actually reads it, rather than relying on it to interpret an exit code correctly.
- No behaviour change: the cap, the exit code and the cursor are all unchanged.

Also confirms 0.7.0 in the field: that stream ran a **full 24 hours** as a persistent monitor before its own cap ended it, across an entirely idle period, and the re-arm drained a cursor exactly level with the inbox — nothing skipped, nothing replayed.

Item `be0a929a`.

## 0.7.0 - 2026-07-31

### The wake channel is armed once per session, not once per turn

- **The failure this fixes.** 0.6.5's Stop hook correctly refuses to let an agent end a turn with nothing listening. But the listener it asked for was a *background task*, and Claude Code reaps background tasks at turn end. So: the agent armed correctly, the Stop hook saw a live listener and passed, the host then reaped it, the reap started a new turn with nothing armed, the Stop hook blocked, the agent re-armed — round and round, **one model turn per lap, with no way out**. Reproduced five times consecutively. No amount of agent diligence touched it, because the agent was already doing everything right; the failure was in *who owned the process*.
- **The wake no longer depends on something dying.** The listener used to wake the model by *exiting*, which is exactly what tied its lifetime to the turn. It can now run in `--stream` mode: it prints one line per owner command and keeps watching. Armed once with a persistent monitor, it lasts the whole session, so there is no re-arm to lose to a reaper — and nothing to forget.
- **The Stop hook was not weakened to achieve this.** It still blocks a turn ending with no listener, on exactly the same condition as before. A session-long listener simply satisfies it on every turn from a single arm. What changed is the way *out* of the block, which used to name the reapable arm.
- **"Live" and "will actually wake up" stop being different promises** on this host: the listener's lifetime is now the session's lifetime. 0.6.6's honest **Not reading** signal stays exactly as it is, for any host that cannot hold a stream.
- **No command is lost in the switch.** The inbox cursor is unchanged, and now advances only *after* a command has been handed over — so an interrupted delivery repeats rather than vanishes.
- The one-shot behaviour remains available for hosts with no persistent monitor; drop `--stream` and it exits on the first command as before.

Item `be0a929a` (related: `8b4ceaa3`, `d655b2a4`).

### Maintainers: plugin families are independent implementations now

- **We no longer treat this plugin as canonical and port its scripts outward.** That practice produced a repeating cycle — fix one host, port the fix, break a second host, port *that* fix, introduce a third bug. What is shared is the DevSpec side: the MCP tool contract, the inbox format, the delivery contract, the skills, and the behaviour a connection must exhibit. **How** a host meets that contract is allowed to differ.
- **`devspec-remote-wait.mjs` is now `HOST_OWNED` and is never synced.** How you wake a model is the most host-specific thing in the plugin: Claude Code needs a session-scoped stream, Grok Build's monitor already turns every stdout line into an event, and Codex is a bridge with no local waker at all. This also retires the 0.6.5 maintainer warning below — the exit-3 change can no longer be carried into families whose exit tables would misread it.
- `sync-hooks.mjs` declares host-owned files on every run, so "owned by policy" can never again look identical to "somebody forgot to list it".
- Fixed: `marketplace.json` had drifted to 0.5.1 while `plugin.json` was 0.6.6, despite being documented as lockstep. Both are 0.7.0.

## 0.6.6 - 2026-07-30

### DevSpec can now tell you an agent has stopped listening

- **"Live" used to mean "the process is up", which is not the same as "work sent here will be read."** 0.6.5 stopped an agent going deaf in the first place; this reports the state honestly if it ever happens anyway. The poller now checks whether a wake listener actually holds the pidfile, counts any owner commands sitting unconsumed in the inbox, and sends both on the heartbeat it already makes. DevSpec shows such an agent as **Not reading** rather than Live, and stops offering it as available to dispatch to.
- **Armed is proved by a live pid, never by a leftover file** — a hard-killed listener leaves its pidfile behind, and trusting that would report exactly the lie this is meant to catch.
- **It will not cry wolf.** A missing pidfile only counts as evidence once this connection has armed a pidfile-writing wait at least once. Waits armed before that shipped never wrote one, so "no file" from them means "older build", not "deaf" — otherwise every healthy pre-upgrade agent would light up as Not reading at the very moment you were deciding whether to trust the new badge.

Items `8b4ceaa3`, `d655b2a4`.

## 0.6.5 - 2026-07-30

### A remote agent can no longer go silently deaf while telling you it is fine

- **The failure this fixes.** You send your agent a command from your phone. Nothing comes back. The Agents page still says Live and available, so you reasonably conclude the connection dropped and reconnect. Nothing had dropped: the poller was healthy and had delivered every message correctly, but the one-shot listener that turns a delivered message into an actual agent wake-up had not been re-armed, so nobody read them. Delivery depended on the agent remembering a bookkeeping step at the end of every turn, and there was no backstop when it forgot.
- **Why it kept coming back.** The original design had one process that both heartbeated and woke the agent, so losing the waker also lost the heartbeat and the chip went Disconnected — loud and impossible to misread. Moving liveness onto a keeper-managed poller fixed "Live drops while the agent works" and left the wake channel with no keeper at all, so the thing still reporting Live was no longer the thing that wakes you.
- **Stop now refuses to end a turn deaf.** While armed, the wait owns a per-connection pidfile, so the Stop hook can prove whether anything is actually listening — and if a turn is about to end with no listener, or with commands sitting unread, it blocks and hands the agent the re-arm command. The guarantee moved from "the agent remembers" to "the hook enforces". Liveness is proved by a live pid, never by a leftover file, so a hard-killed listener cannot masquerade as a healthy one.
- **A blocked stop keeps you "working".** The turn genuinely has not ended, so the indicator stays on rather than reporting a finish that has not happened.
- **A reaped or aged-out listener no longer reads as a dead connection.** The wait used to exit 1 both for "a human ended this" and for "my arm aged out" — and the documented response to exit 1 is *stop*, so an agent following the instructions correctly tore down a perfectly live connection on a 24-hour rollover. Non-terminal cases now exit **3**, meaning "re-arm me, nothing is wrong", and exit 1 is strictly "a human or the server ended this".
- **The arming instructions now say not to pass a timeout**, since supplying a plausible-looking one was a way for an agent to manufacture this failure itself.

Items `8b4ceaa3`, `d655b2a4`.

> Note for maintainers: `devspec-remote-wait.mjs` is in the sync's UNIVERSAL list, so the next `sync-hooks` run would carry exit 3 to the other plugin families — whose exit tables still document only 0/1/2 and would misread it. Propagate the docs with the code. The `mirror-turn.mjs` change relies on Claude Code's Stop-hook decision control and is not portable as-is.
>
> **Resolved in 0.7.0:** the wake channel is `HOST_OWNED` and no longer synced anywhere, so this hazard is gone rather than merely noted. This warning is the reason the tier was wrong — it describes a file that could not safely be shared, sitting in the list of files that are shared.

## 0.6.4 - 2026-07-27

### Every plugin's test suite now actually protects it

- **A shared file's tests travel with it.** The sync lists named implementations and their tests side by side, by hand, and the pairing had rotted: `resolve-mcp-auth.mjs` was synced while its test was not, so the Cursor plugin held an older test asserting an export the shared implementation no longer had — **its suite could not even load, on main**. `devspec-remote-poll.test.mjs` and `devspec-remote-wait.test.mjs` were absent from the lists too, so Antigravity had no copy of either. Tests are now derived from the implementation entry, so the pairing cannot rot again.
- **The failure used to be invisible.** A file in *neither* list counted as neither drift nor plugin-owned, so `--check` reported everything in sync while a downstream suite was red. It now reports a missing downstream test as drift, and warns about a canonical test that pairs with no synced implementation.
- **Owning an implementation now owns its test.** A plugin that keeps its own `resolve-mcp-auth.mjs` because its host stores the token elsewhere keeps the test that asserts that, rather than having the canonical one written over it.
- Result across the family: **Cursor red → 151 passing**, Antigravity 62 → 151, Grok Build 69 → 151 (its three owned tests untouched), Codex 38 → 68 (its own bridge poller test preserved).
- `scripts/sync-hooks.mjs` no longer runs a real sync when imported, and its pairing rules have their own tests.

## 0.6.3 - 2026-07-26

### Remote control — the "working" dots no longer die thirty seconds into a five-minute turn

- **Your agent stays "working" for the whole turn.** Arming the wait for the next command used to be treated as "the agent is idle", so it cleared the turn marker the poller had just written. Because agents are told to re-arm the *instant* they wake — precisely so owner mail arriving mid-turn is not dropped — an agent switched its own indicator off seconds into every turn and then worked on with the driver's UI showing nothing.
- **Worse than a cosmetic bug:** with the marker gone, the poller's next tick emitted `report_complete`, so the activity state machine recorded the turn as *finished* while it was still running.
- **Turn end is now owned by the Stop hook alone** (`mirror-turn.mjs stop`), which every plugin in this family registers. A *first* arm (`--from-end`) still clears the marker — that is the connect/reconnect case the original clear was written for, where a seed delivery can leave a turn nobody will ever wake for.
- Whether the dots appeared at all used to depend on *when* in its turn an agent happened to re-arm, which is why this read as intermittent rather than broken.

## 0.6.2 - 2026-07-26

### Remote control — screenshots you send from your phone now actually arrive

- **Attachments on an owner command are saved as real files and handed to the model as a path**, instead of being dumped into the turn as base64. Previously the wake payload carried the server's raw `content` *and* its `dataUrl` — the same bytes twice. A 500KB screenshot measured at **1.37MB of stdout, roughly 341,000 tokens** of base64 that the model still could not see as an image. It is now **589 bytes** and a path the host can open, with the decoded file written to `~/.devspec/remote-control/connections/<id>.attachments/`.
- **Small text attachments stay inline** (under 2KB) — a file path for a 30-byte note helps nobody.
- **Nothing is dropped silently.** If an attachment cannot be written to disk, the descriptor says so and points at `get_session_transcript`, rather than quietly omitting it.
- Filenames are sanitised, so an attachment called `../../etc/passwd` lands as `passwd` inside the attachment directory and nowhere else.

## 0.6.1 - 2026-07-26

### Remote control — a dropped agent now says *why* it dropped

- **`owner_gone` is no longer reported as `local_stop`.** When the poller detects that its host process has died it tears itself down — but it stamped that with the same `local_stop` value the server gets when you deliberately run `/devspec.remote-stop`. On staging that made 117 connection ends indistinguishable, so "why do agents disconnect mid-conversation?" could not be answered from the data at all. The two are now separate reasons, and the Agents page says "The agent process exited" rather than "Local agent disconnected".
- **A relaunch still resumes your agent.** `owner_gone` is a *recoverable* end, so re-running `/devspec.remote` after Claude Code exits reconnects the same connection instead of registering a fresh one with a new codename. (Had it been added as a new reason without this, every restart would have silently become a new agent.)
- **Requires DevSpec staging with `owner_gone` in the `heartbeat_connection` enum.** An end reason the server does not recognise is discarded rather than rejected, which would skip the sticky end and leave a zombie "Live" chip — so the server change ships first.

### Internal

- The seed/advisory split is now covered by tests rather than only by a comment: `splitRoomWindow` asserts that a cold launch filters the **command** half only and never the advisory half, which is the invariant that makes a reconnecting agent arrive oriented.

## 0.6.0 - 2026-07-25

### Remote control — long-poll transport, and the room arrives with the command

- **The polling interval is gone.** One held `poll_connection` call replaces the old three-call tick (`heartbeat_connection` + `get_connection_dispatch` + `get_session_transcript`). The server holds the request open (~25s) and answers the instant something lands: **~2 requests/min instead of 8, and ~0 delivery latency instead of up to 15s.** Fixed intervals survive only as error/empty-turn backoff.
- **Room context is now delivered WITH the command.** A wake payload begins with a labelled `room_context` event — `owner_ambient` (your owner talking in the room, but not to you) and `room_context` (teammates, Dev, other agents) — followed by the command last. Previously advisory was written to a side file and reading it was an instruction the model had to remember; an agent could hold "1", "2", "3" on disk and still fail to answer "what's the next number?". Because a long-poll returns the instant anything arrives, the poller carries advisory forward since the last command so it is genuinely there when the command lands.
- **Reconnect arrives oriented.** A cold launch or a server-side reattach asks for the bounded catch-up window, writes it as advisory and seeds the carry buffer — so the first command after reconnecting already has the room. Already-answered history is still filtered out of the commands, so reconnecting never re-wakes a finished turn.
- **Commands state their addressee.** Every delivered command carries `addressed_to` (agent name · codename · connection id) and an `authority` stamp, and the poller **refuses** anything not addressed to it. Two of your agents in one room can no longer be confused for each other, and a misroute is visible instead of silent.
- Teardown is faster: a held request is aborted the moment the owning agent process dies, and every request now has a hard client-side timeout, so a dropped network can no longer wedge a poller with no heartbeat.
- The shared hook layer's sync process now honours **plugin-owned files**: a plugin that has genuinely diverged from the canonical (Grok Build's host-token, hook-envelope and local-id handling) is reported and skipped rather than silently overwritten.


## 0.5.2 - 2026-07-24

### Remote control — never drop owner mail that arrives mid-turn

- `devspec-remote-wait` **defaults to resuming from `inbox_byte_offset`** (not EOF).
- `/devspec.remote`: **re-arm with `--pending`** after every wake. `--from-end` is first-connect only.
- Live bug: re-arming with `--from-end` after a wake skipped owner commands the poller had already written while the agent was mid-turn.

## 0.5.1 - 2026-07-24

### Remote control — agent-canonical, connection-scoped, session optional

- **Answers:** when attached, post via `post_session_message({ connection_id })` (server resolves current session / reattach-safe). Sessionless: assignment / `report_progress` only — never invent a room.
- **Stop hooks:** busy/heartbeat + optional local_prompt only — **no** full assistant text as primary path (no dual writers).
- **`/devspec.work --remote`:** defaults **sessionless**; optional `--session` / `--new` for a transcript.
- **Delivery contract:** skills/commands align with DevSpecV2 `docs/REMOTE-CONTROL-DELIVERY-CONTRACT.md` (ADR b98a39a9).

### Repo + plugin rename, token docs, and remote-control groundwork

- **Token docs — one account-wide token, reusable everywhere:**
 the README now points token creation at **You → Connections → Connect a tool** (was the stale "Settings → API"), corrects the storage note (macOS Keychain vs an encrypted credentials file on Linux/Windows), explains the plugin bundles the MCP server so there's nothing to add to `.mcp.json`, and documents entering/changing the token via `/plugin` → **Installed** → **DevSpec**. Reflects the new model: one account-wide token, reused in every tool and revealable again any time from You → Connections.
- **Remote control reads the room on connect:** `/devspec.remote` now tells the connected agent to **read the session transcript for context** on connect/attach (not just seed a cursor) and resolve context-dependent first instructions ("help with all this", "carry on", "the thing we discussed") against it before asking the owner to re-explain — so the agent arrives oriented instead of blind. Advisory history (in-session AI, teammates) is readable context for comprehension, never a command surface; command authority is unchanged.
- **Remote dispatch — work a dispatched assignment:** `/devspec.remote` now runs the DevSpec assignment protocol when an owner dispatch carries an assignment reference — `get_assignment` → `acknowledge_assignment` → `claim_work_item` (each reserved member, in order; a claim reserved for someone else is a non-fatal skip) → implement + `record_implementation` → `resolve_assignment`. The command's allow-list gains the assignment + work-execution tools, and the autopilot skill gains the three assignment tools for staged-batch routing.
- **Agent-authoritative remote-control "working" state:** the connected agent now reports `busy:true` on turn start (plus a turn marker) and `busy:false` on turn end/interrupt; the long-lived poller re-asserts busy while a turn runs so long turns stay "working" and an interrupted turn decays instead of stranding a phantom "working". Poller backoff gains a `dormant` (~hourly) tier and the idle-disconnect lifetime extends from 24h to 72h.
- Renamed the GitHub repository to [`DevSpecAI/devspec-claude-plugin`](https://github.com/DevSpecAI/devspec-claude-plugin) (was `claude-code-devspec-autopilot`).
- Renamed the plugin id to `devspec` and the marketplace id to `devspec` (was `devspec-autopilot` / `devspec-autopilot-marketplace`). Slash commands are now `/devspec:<command>`. Existing installs migrate via marketplace `renames` (`devspec-autopilot` → `devspec`); re-add the marketplace if your local catalog still uses the old name.
- Install: `/plugin marketplace add DevSpecAI/devspec-claude-plugin` then `/plugin install devspec@devspec`.
- Rewrote `README.md` for the full product surface (MCP token setup, interactive work, Agents remote control, autopilot) instead of an autopilot-only pitch.

## 0.5.0 - 2026-07-13

Zero-config MCP setup and production cleanup.

- **Auto-wire the DevSpec MCP server.** The plugin now declares the `devspec` MCP server in its manifest (`https://devspec.ai/api/mcp`) and prompts for **only your API token** via `userConfig` (`sensitive`, stored in the OS keychain) on enable. No more hand-editing `.mcp.json`. A `devspec` server you define yourself still takes precedence, so staging/self-host overrides keep working.
- Remote-control token resolution now also reads the keychain token (`CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN`) as a lowest-priority fallback, so the poller/hooks authenticate for marketplace-installed users.
- Turn-mirroring hooks are guarded with `command -v node` — a session without Node.js is a silent no-op instead of a per-turn hook error.
- `/devspec.remote` now runs a `node --version` preflight with clear install guidance (incl. the native-installer caveat).
- Removed the unused v1 autopilot engine and npm scaffolding (`src/`, `dist/`, `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`) and stale template files (`examples/`, scheduler icon). The plugin is Markdown skills/commands + dependency-free Node hook scripts — no build step. Tests run with `node --test hooks/scripts/*.test.mjs`.

## 0.4.1 - 2026-07-13

Marketplace-readiness pass.

- Aligned the version across `plugin.json`, `.claude-plugin/marketplace.json`, and `package.json` (previously drifted).
- Added `displayName`, `homepage`, and `repository` to the plugin manifest.
- Rewrote the README: production MCP URL (`https://devspec.ai/api/mcp`), full command list with correct `/devspec-autopilot:<command>` namespacing, accurate project structure, and clearer Node.js prerequisites.

## 0.4.x - remote control

- Added `/devspec.remote` and `/devspec.remote-stop` for DevSpec Agents-page remote control.
- Conversation-scoped remote bonds; long-lived poller that keeps heartbeating through owner instructions.
- Mechanical turn mirroring via `Stop` / `UserPromptSubmit` hooks.

## 0.2.x - initial autopilot

- Autopilot polling loop: claim staged action items, implement in isolated worktrees, test, push/merge, and report back to DevSpec.
- Planning mode ("Request Agent Plan").
- Terminal companions: `/devspec.work`, `/devspec.create`, `/devspec.commit`, `/devspec.link`, `/devspec.done`, `/devspec.help`.
