# DevSpec for Claude Code

**Build on your team's best thinking.** [DevSpec](https://devspec.ai) is where your team, your shared knowledge, and your coding agents build software together.

Installing the DevSpec plugin connects Claude Code directly to your DevSpec projects — giving your agent durable project memory, structured task execution, automatic commit provenance, and live remote control from your phone or browser.

---

## Why DevSpec + Claude Code?

- **Shared team memory, recalled as you talk, with automatic staleness screening** — Before each substantive prompt, from you or from DevSpec, Claude Code is handed the project records that bear on it: the requirements that apply, standing documents and runbooks, decisions and conventions, plans already filed or turned down, and past shipped work. Each appears once per conversation unless it changes, it is added after your prompt so the conversation's cache keeps working, and a slow or unreachable DevSpec never holds your prompt back. Claude Code asks you before it records a decision or a requirement, writes down your reason rather than one of its own, and checks the work it delivers against the requirements that apply. When you record a new decision or land changes, DevSpec screens your project's records for conflicts, duplicates, and **Possibly outdated** guidance so your team's shared memory stays accurate.
- **Steer Claude Code live from your phone or the web** — In a linked repository, Claude Code connects automatically and waits on your project's **Agents** page outside any session (or run `/devspec:devspec.remote`). Join a session room with `--new` or `--session <id>` — or attach from [devspec.ai](https://devspec.ai) — to chat from your phone or browser, collaborate with teammates in shared rooms, answer structured agent questions and polls, and track multi-phase execution plans in real time.
- **Tasks, observed verification, and automatic commit provenance** — Claim tasks with full project context. When a single task is claimed in a linked project repository (including Git worktrees) or a `.devspec/project.json`-pinned folder, the plugin tags your commits (`[devspec:<id>]`) automatically, links pull requests, and records observed verification evidence from checks Claude actually ran against each acceptance criterion. With several tasks claimed, it asks Claude which task a commit belongs to before the commit is made. A commit made with no task claimed, such as a dependency update or an automation run, goes through as written, with a note. Full commit tracking — every commit reported to DevSpec and tagged with its task automatically — needs macOS, Linux, or Windows through WSL (on native Windows, Bash commands use a simpler check for plain commit commands, and PowerShell commits are linked when Claude records its implementation).
- **Protected intent, pull-request checks, and Merge when cleared** — DevSpec screens changes against your team's recorded decisions, requirements, and open tasks, runs one final check per pull request when it is ready (protected or not), holds reversals of someone else's decision and unagreed experiments on their own branch until approved, publishes its pull-request check on GitHub, and merges cleared pull requests automatically (or wakes Claude Code once to merge with your GitHub credentials when the GitHub App is read-only).

---

## Quick Start

### 1. Install the DevSpec plugin

Inside Claude Code, run:

```text
/plugin marketplace add DevSpecAI/devspec-claude-plugin
/plugin install devspec@devspec
/reload-plugins
```

Then open `/plugin` → **Marketplaces** → **devspec** and choose **Enable auto-update** so Claude Code installs new plugin releases automatically when it starts.

### 2. Sign in through your browser

Inside Claude Code, run:

```text
/devspec:devspec.login
```

Your browser opens DevSpec's approval page; approve **Claude Code** there, then restart Claude Code (or reconnect DevSpec's tools in `/mcp` → **devspec** → **Reconnect**). That one sign-in serves everything the plugin does: Claude Code's own DevSpec tools, remote control and commit tracking. It renews itself and lasts until you sign out (`/devspec:devspec.logout`) or disconnect Claude Code on your [Agent setup](https://app.devspec.ai/settings/agents) page; if it ever stops working, Claude Code tells you when it starts and asks you to run `/devspec:devspec.login` again.

- **On a machine your browser cannot reach** (over SSH, or a remote dev box), the command shows a link instead; open it anywhere, approve, and paste back the code DevSpec's page shows. Run `/devspec:devspec.login --code` to choose this yourself.
- **Staging and production** are signed in separately and both sign-ins are kept, so switching the plugin's DevSpec server never needs a fresh sign-in.

### 3. Connect to your project

- **In a linked repository:** Start `claude` in any Git repository linked to your DevSpec project. Claude Code connects to that project automatically and appears on the project's **Agents** page.
- **In any other folder, or when switching projects:** Run `/devspec:devspec.project` to choose which project this conversation belongs to.

Sitting idle on the **Agents** page uses no tokens — Claude Code runs only when you or an authorized teammate asks it to do something, when your project routes a check on a change for it to rule, or when an automation you opted into runs. If Anthropic stops Claude Code for a usage limit, the plugin tells DevSpec, so checks go to another agent until Claude Code can work again.

> **Tip for phone and remote control:** By default, Claude Code pauses in the terminal for local approval before editing files or running commands. When driving Claude Code remotely from your phone or the web, start it with `claude --dangerously-skip-permissions` (or set `"defaultMode": "bypassPermissions"` under `"permissions"` in `~/.claude/settings.json`) so work doesn't stall waiting at your desk.

---

## Commands

You can ask Claude Code to do anything in DevSpec in plain English (*"Work on DevSpec task 4f2a"*, *"What did we decide about caching?"*, *"Create a task for the login redirect bug"*).

The plugin also adds these slash commands inside Claude Code:

| Command | What it does |
|---|---|
| `/devspec:devspec.login` | Signs Claude Code in to DevSpec through your browser (`--code` on a machine your browser cannot reach). |
| `/devspec:devspec.logout` | Signs Claude Code out of DevSpec on this computer, for the server the plugin is set to. |
| `/devspec:devspec.remote` | Connects this Claude Code conversation to DevSpec and waits on the **Agents** page outside any session. |
| `/devspec:devspec.remote --new` | Connects and starts a fresh shared DevSpec session room (`--new --private` for a private room). |
| `/devspec:devspec.remote --session <id>` | Connects and joins an existing DevSpec session room. |
| `/devspec:devspec.remote --project "<name>"` | Connects and selects a project for this conversation without changing the folder default. |
| `/devspec:devspec.remote --name "Night Owl"` | Connects using a custom agent codename. |
| `/devspec:devspec.remote-stop` | Disconnects this conversation from DevSpec while leaving other Claude Code terminals running. |
| `/devspec:devspec.project` | Inspects or changes the active project (`status`, `choose`, `remember`, or `forget`). |

To turn off automatic connection at startup, switch off **Make Claude Code available on DevSpec when it starts** under `/plugin` → **Installed** → **DevSpec**. You can still connect on demand with `/devspec:devspec.remote`.

---

## How It Works & Data Handling

For transparency and security review, here is what the plugin runs, stores locally, and sends to DevSpec:

- **MCP Server Connection:** Communicates over HTTPS with `https://api.devspec.ai/api/mcp` (or the URL configured in `devspec_mcp_url`). Claude Code gets the `Authorization` header from the plugin's `headersHelper` (`mcp-headers.mjs`), which reads your browser sign-in for that server.
- **Browser sign-in (`devspec-login.mjs`, `oauth.mjs`, `auth-store.mjs`):** OAuth 2.1 authorization code with PKCE through DevSpec's sign-in server, using Claude Code's own registered sign-in app. The approval comes back to a listener on `127.0.0.1` that closes after ten minutes, or, on a machine your browser cannot reach, as a code you paste. The plugin never polls a server for the result. Access is renewed with a single-use renewal key under a lock shared by every Claude Code process on the machine.
- **Hooks & Modules (`hooks/hooks.json`, and the hooks module `hooks/terminal-status.ts` with `local-prompt.ts`, `turn-recall.ts`, `terminal-wait.ts`, `devspec-control.ts` and `devspec-telemetry.ts`):**
  - **Project recall, before each prompt** (`turn-recall.ts`, `turn-recall.mjs`): the text of each substantive prompt — one you type or send through Claude Code's own Remote Control (18 characters or more, not a slash command), and each DevSpec command or automation run sent to this agent — is sent to DevSpec (`<server>/api/mcp/turn-recall`) to look up the project records that bear on it, and the records DevSpec returns are added after your prompt. Check jobs, notices, scheduled prompts and messages from other sessions are never sent.
  - On `SessionStart` (`startup-listener.mjs`) and monitor startup (`devspec-remote-listen.mjs`), spawns a background Node poller (`devspec-remote-poll.mjs`) when `connect_at_startup` is enabled or when `/devspec:devspec.remote` is invoked. The poller receives what DevSpec sends this agent and tells DevSpec when Claude Code starts and finishes each room command.
  - On each prompt (`local-prompt.ts`, `mirror-turn.mjs`) and on `Stop`, while this conversation is attached to a DevSpec session room: a prompt you type or send through Claude Code's own Remote Control is posted to the room so your web/phone transcript stays in step, and the turn's start and end are reported. Runtime telemetry (`devspec-telemetry.ts`, `agent-telemetry.mjs`) is sent for the connected conversation: model, effort, context fill, token counts, and, for a Pro or Max plan, how much of the 5-hour and weekly usage limits is used and when each resets.
  - On `StopFailure` (`mirror-turn.mjs`, `turn-failure.mjs`), when an error from Anthropic's service ends a turn before Claude can answer a message sent from a DevSpec room, posts Claude Code's own error message to that room and ends the turn there. Whenever Anthropic stops a turn for a usage limit, it also tells DevSpec that Claude Code cannot take checks for the next 15 minutes, and a turn that then runs clears that. It sends the error reason and message text only, never your conversation.
  - On `PreToolUse` (`devspec-tool-input.mjs`), attaches this conversation's connection, and the request the call serves, to DevSpec tool calls.
  - **Commit tracking** (`git-observer.mjs`, `git-shim.mjs`, `commit-provenance.mjs`): at `SessionStart` a private `git` stand-in is put first on `PATH` for this conversation's shell commands, through the environment file Claude Code applies to them. Nothing is installed in any repository or git configuration. In linked project repositories (including Git worktrees) and `.devspec/project.json`-pinned folders it tags commits with `[devspec:<id>]` when a single task is claimed, asks which task a commit belongs to when several are, and lets a commit with no task claimed through as written, with a note. Every commit Claude makes is reported to DevSpec (its id, branch and repository) after each tool call, at `Stop`, `SubagentStop` and `SessionEnd`.
  - When a remote control action is triggered from the DevSpec Agents page, the status module (`terminal-status.ts`, `devspec-control.ts`) updates the terminal status line and runs `/devspec:devspec.remote` or `/devspec:devspec.remote-stop` on your behalf.
- **Local Files Written:**
  - `~/.devspec/claude-code/auth.json` (permissions `0600` / `0700`): your browser sign-in, one entry per DevSpec server. Only this plugin reads it. `/devspec:devspec.logout` removes the entry and cancels it at DevSpec's sign-in server.
  - `~/.devspec/remote-control/` (permissions `0600` / `0700`): stores per-connection state, session room transcript cache, and project instruction tiers.
  - `~/.devspec/recall/claude-code/` (permissions `0600` / `0700`): which project records each conversation has already been shown, so each appears once. Files untouched for 30 days are removed.
  - `~/.devspec/git-observer/`: each conversation's `git` stand-in and the commits waiting to be reported, removed when the conversation ends, plus `commits.log`, a record of what was reported.
  - `.devspec/project.json`: written in the repository root only when you pin a default project for that folder, with `/devspec:devspec.project remember` or by asking Claude to pin it.

---

## Learn More

- **Web & Sign Up:** [devspec.ai](https://devspec.ai)
- **App & Agent Setup:** [app.devspec.ai/settings/agents](https://app.devspec.ai/settings/agents)
- **Privacy Policy:** [devspec.ai/privacy](https://devspec.ai/privacy)
- **Changelog:** [CHANGELOG.md](./CHANGELOG.md)
