# Development

Maintainer notes for the DevSpec Claude Code plugin (`devspec`). End users don't need any of this — see `README.md`.

## What the plugin actually is

Markdown skills/commands + a manifest + a handful of Node hook scripts. **There is no build step and no bundled binary.**

- `.claude-plugin/plugin.json` — manifest (name, version, `userConfig`, `mcpServers`, component paths). This is the source of truth for the version.
- `commands/*.md`, `skills/*/SKILL.md` — the slash commands and skills.
- `hooks/scripts/*.mjs` — the remote-control poller and turn-mirroring hooks. **They import only Node built-ins** — no npm dependencies, so nothing to install.

Keep it that way: don't reintroduce a `package.json`/build pipeline or npm dependencies in the hook scripts.

The one exception to "Node scripts" is `hooks/terminal-status.ts`, the terminal's DevSpec status line (item `c6dcb524`). It is a Claude Code **function-hooks** module, named under `modules` in `hooks/hooks.json` beside the command hooks. Claude Code compiles and runs it itself, in an environment with no Node, so there is still no build step. Everything it says comes from `hooks/scripts/terminal-status.mjs`, which is deliberately pure (no Node built-ins), so the module and `node --test` share one copy of the paths, the reading and the copy. The module only reads this conversation's existing state files and calls `$.ui.status` / `$.ui.toast`. It never writes state and never calls the model. Two exceptions, because a plugin gets a single module (and a module hooks `session.start` once, and the plugin API is followed only within the file holding the hook, so it hands closures, never `$`, to other files):
- It registers `hooks/terminal-wait.ts`, which clears a terminal wait when a permission prompt is denied (no command hook fires on a denial). It does so by running `hooks/scripts/terminal-wait.mjs clear`, and only when a wait is on record.
- It registers `hooks/devspec-control.ts`, which carries out the owner's Stop from DevSpec with `$.turn.abort` and acknowledges it through `hooks/scripts/devspec-control.mjs` (see `hooks/scripts/control-relay.mjs`). The room title it shows is stored by the poller (`hooks/scripts/session-title.mjs`).
- It registers `hooks/devspec-telemetry.ts`, which tells DevSpec which model the main loop is running, at what effort, the context fill and the last turn's usage (item `2382364d`). It writes `<connection>.telemetry.json` on each turn's first model request (`turn.step`) and at the turn's end (`turn.complete`), and sends it at once as `agent_stats` on `heartbeat_connection` through `hooks/scripts/devspec-telemetry.mjs` (see `hooks/scripts/agent-telemetry.mjs`). Straight away rather than on the poller's next poll, because a turn's first act is often a claim, which freezes the model DevSpec holds at that moment. Its `turn.complete` hook carries the matcher `{ isAborted: false }`: the engine refuses a second unmatched hook on one event, and an interrupted turn has no usage to settle anyway.
- It registers `hooks/local-prompt.ts`, which hands every prompt in a DevSpec conversation to `hooks/scripts/mirror-turn.mjs user_prompt` before the prompt enters, together with Claude Code's own stamp of where it came from (`e.origin`). The script opens the owner's turn and shows the prompt in the room only for a prompt a person sent. No command hook can do this: on 2.1.291 the UserPromptSubmit payload of a `/loop` firing is the same as the prompt that was typed to start it (item `dd1a8325`).

The function-hooks API is marked early access by Anthropic and can change between Claude Code releases. Failures are contained. With the module present, the command hooks still ran on every build measured: 2.1.132, 2.1.193, 2.1.246, 2.1.278 and 2.1.289. Builds that predate the API ignore the `modules` key. 2.1.246, whose API differs, refuses the module and runs everything else. A hook that throws is skipped. In each of these cases the terminal shows nothing, which is how it was before.

## Background work and the delegation group

Claude can end its turn to wait on work it started in the background. That work is a subagent, a background command or a workflow. Two things depend on knowing what is still running, and both read the same records. The records are kept per turn in `<connection>.turn-owned.jsonl`: one append-only line per launch and per end, keyed by the turn marker's `startedAt` so a new command never inherits an earlier one's work.

- **Presence and the command's lifetime** (item `beb0e005`). Stop keeps the turn open while anything this turn launched is still in Claude Code's own `background_tasks` list (`backgroundHoldDecision`).
- **How long a turn counts as live** (item `9e8dda57`, `hooks/scripts/turn-liveness.mjs`). There is no fixed hour. A Stop that holds the command marks the turn `held`, and a held turn is live until the next Stop rewrites or clears it. A running turn is live while Claude Code keeps showing signs of life: every tool call, including a subagent's, records one in `<connection>.turn-activity.json`. That file is separate from the marker, so a tool call finishing beside a Stop can never bring a cleared turn back. Only a running turn with no sign of life for an hour is taken as over, which covers a Claude Code too old to report an interrupt. The hooks and the poller share this one rule.
- **Activity** (item `d2cbd4c6`). Background subagents appear in the room's Activity as one nested "Delegated to N agents" group, posted as a `phase: trail` with a `subagent` trail event (`hooks/scripts/delegation-trail.mjs`).
  - A trail post must carry the exact command identity, because some server refusals end the turn they match. The identity is recorded once per turn and nothing is posted without one.
  - Measured on 2.1.289: a subagent stops every time it reports, including "my command is still running, I'll wait", and while it waits the host lists its command but not the subagent. So a subagent has finished only when neither it nor anything it started is still listed (`stillAlive`).

## Requirements

- **Node.js 18+** on your PATH (`node --version`). Required at runtime for the hooks/poller.

## Running the tests

```bash
node --test hooks/scripts/*.test.mjs
```

The status-line module also has tests that run under Claude Code's own engine, and the module type-checks against the declarations the engine lays in `.claude-plugin/types/`. The engine creates that folder the first time it loads the plugin from this folder, and it is git-ignored:

```bash
claude plugin test .
tsc -p .
```

## Conversation project selection

`conversation-project.mjs` keeps endpoint-bound selection under private per-Claude-conversation state, keyed by a hash of the local conversation ID. It contains project metadata, not credentials. This is distinct from the shared `.devspec/project.json` folder default. Corrupt state and rejected explicit selections cannot silently fall back to a different folder project.

`devspec-tool-input.mjs` is the single native DevSpec PreToolUse input writer. It composes conversation scope with the existing version stamp so two hook responses cannot overwrite each other's arguments. It uses the firing hook's `session_id`, never another process's ambient ID. It never grants permissions; a contradictory project is denied, and ordinary host permission checks remain in force.

Connect sends folder facts on the normal path, persists the server-confirmed project and reuses it for this conversation. Exact name/ID selection uses `--project`; ambiguity is a structured refusal consumed by the command's native question flow, not parsed from error prose. The startup listener also watches this conversation's project metadata so an explicit choice can wake it without requiring a pin.

`devspec-project.mjs remember|forget` is preview-first. The confirming invocation must carry the exact preview fingerprint, and changes affect future folder-based connections only. A fresh local conversation is required to switch project context. The helper's `prepare --project` path validates an accessible choice and seeds a new UUID accepted by Claude's native `--session-id` option before startup can auto-connect to a folder default. Same-project `/clear` rebonds inherit scope; a resume into a differently scoped conversation refuses and disables the old local delivery instead of copying its connection across.

Run `node tests/runtime/project-scope-runtime.mjs` for an installed-Claude smoke with isolated home and scripted loopback MCP/provider fixtures. Add `--question` to exercise native AskUserQuestion through the host's SDK stdio control protocol, or `--question --cancel` to verify cancellation creates no connection/selection. These are test-only controls, not customer launch flags. The scripted provider advances from completed tool results, so retries or cache warming cannot skip a check. It uses normal manual permissions with an exact read-only status-command grant and the scoped summary tool; it does not simulate or bypass Claude's auto-mode safety classifier. Wrong-project denial remains active. The fixtures make no paid inference requests or live DevSpec writes. The normal test suite remains `node --test hooks/scripts/*.test.mjs`.

## Commit-observation host conformance

Run `node tests/runtime/commit-observation-runtime.mjs` to load this checkout in the installed Claude executable, using a disposable home, real Git repositories/worktree, and scripted localhost provider/MCP. It exercises direct, `cd`, and `git -C` commits plus a fast-forward merge, checks the exact reports and actual resulting refs, and uses exact-command grants under normal manual permissions. It makes no paid inference request or live DevSpec write. This proves this artifact's routing in the measured host, not a customer cache update or support for untested history operations. Hook/component coverage remains in `hooks/scripts/commit-observation*.test.mjs`.

## Room-awareness host conformance

Run `node tests/runtime/room-unread-runtime.mjs` to load this checkout in the installed Claude executable with a disposable home, a bonded connection and a local room copy, against scripted localhost provider and MCP fixtures. It checks four things:
- the `PostToolUse` notice reaches the model mid-turn as counts, with no message bodies
- a message that arrives mid-turn holds the next `post_session_message` once
- the reader hands the messages over, after which the post goes through
- nothing is announced twice

It makes no paid inference request and no live DevSpec write. Unit coverage of what counts, the read record and paging is in `hooks/scripts/room-unread.test.mjs` (item 55feedd7).

## Validating before release

```bash
claude plugin validate . --strict
```

## Bumping the version

Update **both**:
- `.claude-plugin/plugin.json` → `version`
- `.claude-plugin/marketplace.json` → `plugins[0].version`

Keep them in lockstep and record the change in `CHANGELOG.md`.

## Local dev against staging (or any non-prod endpoint)

Set the plugin's **DevSpec server** field to staging. That is the whole thing:

```
https://api.devspecstaging.com/api/mcp
```

`plugin.json` declares the server as `"url": "${user_config.devspec_mcp_url}?model_tools=…"`,
defaulting to `https://api.devspec.ai/api/mcp`. `model_tools` names the connection plumbing
Claude itself calls (the offline heartbeat and detach in `/devspec:devspec.remote-stop`);
DevSpec lists only model tools plus those. Keep the field itself a bare URL. Point it at staging and the plugin's own
`devspec` server goes to staging — and so do the hooks, the commands and the poller.
One server, one host, nothing to keep in sync. How the last part works is worth knowing,
because it is not automatic: see **Where `userConfig` actually reaches** below.

Set the token field to a staging token at the same time. Token and URL always travel as a
pair (item `8bb707fd`); a production token against staging will not own the connection.

### Do not add a second `devspec` server to get staging

A user- or project-defined server named `devspec` does **not** replace the plugin's.
Claude Code namespaces plugin servers, so you end up running both:

```
plugin:devspec:devspec: https://api.devspec.ai/api/mcp          ✘ Failed to connect
devspec:                https://api.devspecstaging.com/api/mcp  ✔ Connected
```

Check with `claude mcp list`. The hook scripts do prefer your own entry, so the *tools*
work — which is why this looked fine for months — but the plugin's server stays
registered and stays red for as long as production is not serving. That is noise you
cannot clear, and it hides the one failure a fresh customer install actually hits.

A project `.mcp.json` is still a legitimate local override for a one-off endpoint. It is
not the way to dogfood staging, and it should not be committed — it carries a live
account-wide token.

### Where `userConfig` actually reaches

Claude Code puts `userConfig` into **hook** subprocesses only, as
`CLAUDE_PLUGIN_OPTION_<KEY>` — the token included, there is no sensitivity filter. Its
own manifest schema says so: the values "become `CLAUDE_PLUGIN_OPTION_<KEY>` env vars
**in hooks**".

**Bash tool calls are a different spawn path and get none of it.** Every script under
`commands/` runs as a Bash tool call, so the connect/poll/wait trio saw an empty
environment and `resolve-mcp-auth.mjs` source 6 was unreachable from exactly the scripts
it existed for. That is item `bb97c9f6`: on a plain plugin install — no `.mcp.json`, no
env vars, which is every customer — `/devspec:devspec.remote` could not authenticate at
all. It appeared to work here only because a hand-written project `.mcp.json` was
supplying the pair.

`hooks/scripts/session-env-credentials.mjs` closes it. On `SessionStart` Claude Code
hands the hook a `CLAUDE_ENV_FILE` path (`session-env/<session>/sessionstart-hook-<n>.sh`)
and applies whatever is written there to the session environment, which Bash tool calls
inherit. The hook re-exports the two `CLAUDE_PLUGIN_OPTION_*` values it was given.

Two things about that are deliberate:

- **It re-exports the same names, not `DEVSPEC_MCP_TOKEN`.** `DEVSPEC_MCP_TOKEN` is
  source 1. Feeding plugin config in at the top would make the plugin's key outrank a
  developer's project `.mcp.json` and `~/.claude.json`, inverting the order below for
  everyone. Re-exporting the plugin's own names keeps it at source 6, where it belongs.
  The environment is being *carried*, not *changed*.
- **It does not read the credential store.** There is no portable one to read:
  `pluginSecrets` goes through the macOS Keychain, the Windows Credential Manager, or
  `~/.claude/.credentials.json` on Linux. Only the last is a file, so reading it would
  work on a Linux dev box and fail silently for most customers. The hook is handed the
  resolved value whatever stored it.

If a host ever stops setting `CLAUDE_ENV_FILE`, the hook writes nothing and the sources
below still work — but `/devspec:devspec.remote` goes back to needing an explicit
`.mcp.json` or env var, so that is the thing to check first if remote connect starts
failing on auth after a Claude Code upgrade.

### Resolution order used by the hook scripts

`hooks/scripts/resolve-mcp-auth.mjs`, first token pair wins. Each source supplies its own
token **and** its own URL; the two are never mixed.

1. `DEVSPEC_MCP_TOKEN` / `DEVSPEC_TOKEN` (+ `DEVSPEC_MCP_URL`) — explicit override
2. The host token, paired with the URL of whichever source it came from
3. Project `.mcp.json` (cwd and parents)
4. `~/.claude.json` entries matching the cwd
5. `~/.claude.json` top-level
6. `CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN` + `CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL` — the
   plugin's own configured pair. Present in hooks because Claude Code sets it, and in
   command scripts because the `SessionStart` hook carries it there (see above).
