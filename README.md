# DevSpec for Claude Code

**Build on your team's best thinking.** [DevSpec](https://devspec.ai) is where your team, your shared knowledge, and your coding agents build software together.

Installing the DevSpec plugin connects Claude Code directly to your DevSpec projects — giving your agent durable project memory, structured task execution, automatic commit provenance, and live remote control from your phone or browser.

---

## Why DevSpec + Claude Code?

- **Shared team memory with automatic staleness screening** — Claude Code recalls the architectural decisions, conventions, risks, and reference docs that apply to the code it's touching. When you record a new decision or land changes, DevSpec screens your project's records for conflicts, duplicates, and **Possibly outdated** guidance so your team's shared memory stays accurate.
- **Steer Claude Code live from your phone or the web** — In a linked repository, Claude Code connects automatically and waits on your project's **Agents** page outside any session (or run `/devspec:devspec.remote`). Join a session room with `--new` or `--session <id>` — or attach from [devspec.ai](https://devspec.ai) — to chat from your phone or browser, collaborate with teammates in shared rooms, answer structured agent questions and polls, and track multi-phase execution plans in real time.
- **Tasks, observed verification, and automatic commit provenance** — Claim tasks with full project context. When a single task is claimed in a linked project repository (including Git worktrees) or a `.devspec/project.json`-pinned folder, the plugin tags your commits (`[devspec:<id>]`) automatically, links pull requests, and records observed verification evidence from checks Claude actually ran against each acceptance criterion. Full commit tracking — every commit reported to DevSpec and tagged with its task automatically — needs macOS, Linux, or Windows through WSL (on native Windows, Bash commands use a simpler check for plain commit commands, and PowerShell commits are linked when Claude records its implementation).
- **Protected intent and GitHub pull-request holds** — DevSpec screens changes against your team's recorded decisions, requirements, and open tasks, holds reversals of someone else's decision and unagreed experiments on their own branch until approved, and publishes its pull-request check on GitHub to reflect pending checks and holds.

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
- **Machines with no browser at all** (CI, cloud workers) can set `DEVSPEC_MCP_TOKEN` instead. It always takes precedence over a browser sign-in, so remove it from your shell profile on a machine where you sign in through the browser; Claude Code says so at startup when both are present.

### 3. Connect to your project

- **In a linked repository:** Start `claude` in any Git repository linked to your DevSpec project. Claude Code connects to that project automatically and appears on the project's **Agents** page.
- **In any other folder, or when switching projects:** Run `/devspec:devspec.project` to choose which project this conversation belongs to.

Sitting idle on the **Agents** page uses no tokens — Claude Code runs only when you or an authorized teammate asks it to do something, when your project routes a check on a change for it to rule, or when an automation you opted into runs.

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

- **MCP Server Connection:** Communicates over HTTPS with `https://api.devspec.ai/api/mcp` (or the URL configured in `devspec_mcp_url`). Claude Code gets the `Authorization` header from the plugin's `headersHelper` (`mcp-headers.mjs`), which reads your browser sign-in for that server; on a machine with no browser, `DEVSPEC_MCP_TOKEN` is sent instead.
- **Browser sign-in (`devspec-login.mjs`, `oauth.mjs`, `auth-store.mjs`):** OAuth 2.1 authorization code with PKCE through DevSpec's sign-in server, using Claude Code's own registered sign-in app. The approval comes back to a listener on `127.0.0.1` that closes after ten minutes, or, on a machine your browser cannot reach, as a code you paste. The plugin never polls a server for the result. Access is renewed with a single-use renewal key under a lock shared by every Claude Code process on the machine.
- **Hooks & Modules (`hooks/hooks.json`, `hooks/terminal-status.ts`, `hooks/local-prompt.ts`, `hooks/devspec-control.ts`, `hooks/devspec-telemetry.ts`):**
  - On `SessionStart` (`startup-listener.mjs`) and monitor startup (`devspec-remote-listen.mjs`), spawns a background Node poller (`devspec-remote-poll.mjs`) when `connect_at_startup` is enabled or when `/devspec:devspec.remote` is invoked.
  - On `UserPromptSubmit` and `Stop` (`mirror-turn.mjs`), mirrors prompts and turn completion to the attached DevSpec session room so your web/phone transcript stays synchronized, and relays runtime telemetry (`agent-telemetry.mjs`) for the active DevSpec turn: model, effort, context fill, token counts, and, for a Pro or Max plan, how much of the 5-hour and weekly usage limits is used and when each resets.
  - On `StopFailure` (`mirror-turn.mjs`, `turn-failure.mjs`), when an error from Anthropic's service ends a turn before Claude can answer a message sent from a DevSpec room, posts Claude Code's own error message to that room and ends the turn there. It sends the error reason and message text only, never your conversation.
  - On `PreToolUse` (`devspec-tool-input.mjs`, `git-observer.mjs`) and `PostToolUse` (`mark-explicit-reply.mjs`, `repo-link-nudge.mjs`), attaches the active connection/session identity to `mcp__devspec__*` tool calls and prepends a lightweight `git` wrapper (`git-shim.mjs`) on `Bash` commands so commits in linked project repositories (including Git worktrees) and `.devspec/project.json`-pinned folders are tagged with `[devspec:<id>]` when a single task is claimed and recorded against that task.
  - When a remote control action is triggered from the DevSpec Agents page, the status module (`terminal-status.ts`, `devspec-control.ts`) updates the terminal status line and runs `/devspec:devspec.remote` or `/devspec:devspec.remote-stop` on your behalf.
- **Local Files Written:**
  - `~/.devspec/claude-code/auth.json` (permissions `0600` / `0700`): your browser sign-in, one entry per DevSpec server. Only this plugin reads it. `/devspec:devspec.logout` removes the entry and cancels it at DevSpec's sign-in server.
  - `~/.devspec/remote-control/` (permissions `0600` / `0700`): stores per-connection state, session room transcript cache, and project instruction tiers.
  - `.devspec/project.json`: written in the repository root only when you explicitly run `/devspec:devspec.project remember` to pin a default project for that folder.

---

## Learn More

- **Web & Sign Up:** [devspec.ai](https://devspec.ai)
- **App & Agent Setup:** [app.devspec.ai/settings/agents](https://app.devspec.ai/settings/agents)
- **Privacy Policy:** [devspec.ai/privacy](https://devspec.ai/privacy)
- **Changelog:** [CHANGELOG.md](./CHANGELOG.md)
