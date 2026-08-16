# Changelog

All notable changes to this plugin are documented here. This project follows [Semantic Versioning](https://semver.org).

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
