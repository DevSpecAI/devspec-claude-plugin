# claude-code-devspec-autopilot

**Put your action items on autopilot.** Queue an action item in DevSpec, and this Claude Code plugin picks it up, implements it, tests it, and pushes the result — all without leaving your terminal. It also connects your session to the DevSpec **Agents page** for remote control.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What It Does

You chat with DevSpec's AI. It creates action items and flags some as automatable. You click "Queue for Autopilot" in the DevSpec UI. This plugin, running in Claude Code, picks it up on the next polling cycle:

1. Claims the item (so no other instance grabs it)
2. Creates an isolated git worktree (your working directory is never touched)
3. Implements the changes described in the action item
4. Runs your configured tests
5. Commits, pushes, and optionally merges to the target branch
6. Reports the result back to DevSpec with the commit SHA and implementation notes

If something goes wrong, it marks the item as failed with a clear error so you can review and retry.

It also ships terminal companions for the rest of the DevSpec loop — create/claim/implement items (`/devspec.work`), log finished work (`/devspec.done`), generate deployment-tracked commits (`/devspec.commit`), and drive the session from DevSpec's Agents page (`/devspec.remote`).

## Prerequisites

- **Claude Code** with plugin support — run `/plugin` to confirm it's available in your version.
- **A DevSpec account** with a project that has action items (DevSpec is a hosted service at [devspec.ai](https://devspec.ai) — you don't self-host anything).
- **A DevSpec API token** (`read_write` scope) — generate one in DevSpec under **Settings → API**. Tokens are account-wide; one token covers all your projects (the plugin resolves which project a run targets from the workspace's git remote).
- **Node.js 18+** on your `PATH`. Verify with `node --version`. The plugin's remote-control poller and turn-mirroring hooks are small Node scripts, and the autopilot links dependencies with Node.
  > **If you installed Claude Code with the native installer**, a system `node` may not be present — install [Node.js 18+](https://nodejs.org) separately so `node` resolves on your `PATH`.

## Install

Until the plugin is published to the official Claude Code marketplace (see below), the supported install path is a **local marketplace** from a clone of this repo. It installs persistently — launch Claude Code normally (no `--plugin-dir` flag), and updates are picked up from disk.

### 1. Clone this repo anywhere on your machine

```bash
git clone https://github.com/DevSpecAI/claude-code-devspec-autopilot.git
```

### 2. Register it as a marketplace and install

The repo ships its own `.claude-plugin/marketplace.json`, so you can point Claude Code straight at the cloned directory. Inside Claude Code, run:

```
/plugin marketplace add /absolute/path/to/claude-code-devspec-autopilot
/plugin install devspec-autopilot@devspec-autopilot-marketplace
/reload-plugins
```

That's it. From now on, just launch Claude Code with `claude` and the plugin's commands are available everywhere.

> **Path with spaces?** Inside the Claude Code REPL, `/plugin marketplace add` takes the rest of the line as the path — no quoting needed.

### Updating

Because the marketplace source is a local path, `git pull` in the cloned repo is all you need. Run `/reload-plugins` (or restart Claude Code) to pick up changes.

### Coming soon: one-command install

We're publishing this to the official Claude Code plugin marketplace so installation becomes a single `/plugin install` command with no clone step. Until then, the local-marketplace flow above is the supported path.

## Setup

### 1. Provide your DevSpec API token

The plugin wires up the DevSpec MCP connection for you — **the only thing you supply is your token.** When the plugin is enabled, Claude Code prompts:

```
DevSpec API token: [hidden] ________________
```

Paste a DevSpec API token with **`read_write`** scope (generate one in DevSpec under **Settings → API**; it starts with `dvs_`). The token is stored securely in your OS keychain — never in a project file or version control. That's the whole setup; the MCP server (`https://devspec.ai/api/mcp`) is baked into the plugin.

DevSpec MCP tokens are **account-wide** — one token works across all your projects; you don't generate a token per project. The plugin figures out *which* project a run targets from the workspace's git remote (it calls `list_projects` with `git remote get-url origin` at startup). If a repo is tracked by more than one of your DevSpec projects, pin the run explicitly with `--project-id=<uuid>`.

<details>
<summary><b>Advanced: point at a different endpoint (self-host / staging)</b></summary>

If you need to override the baked-in endpoint, define a `devspec` MCP server yourself in your project's `.mcp.json` (or `~/.claude.json`). A user-defined server of the same name takes precedence over the plugin's, so the plugin's default is ignored entirely:

```json
{
  "mcpServers": {
    "devspec": {
      "type": "http",
      "url": "https://your-endpoint.example.com/api/mcp",
      "headers": { "Authorization": "Bearer dvs_your_api_token_here" }
    }
  }
}
```

`.mcp.json` contains a bearer token — add it to `.gitignore` (or use `~/.claude.json`) so it's never committed.
</details>

### 2. Configure Autopilot Settings in DevSpec

Open your project in DevSpec, go to **Settings**, and scroll to **Autopilot Configuration**:

| Setting | Description |
|---------|-------------|
| Enabled | Must be on for the autopilot to process items |
| Target Branch | Branch to merge completed work into (set this to your integration branch, e.g. `main`) |
| Auto-push | Push feature branches to remote |
| Auto-merge | Merge feature branches into the target branch |
| Branch Prefix | Prefix for feature branch names (e.g. `autopilot/action-item-`) |
| Commit Prefix | Prefix for commit messages (e.g. `[autopilot] `) |
| Test Commands | Unit, E2E, and typecheck commands to run |
| Protected Paths | Files the agent must never modify (glob patterns) |
| Custom Instructions | Extra context injected into the agent's prompt |
| Poll Interval | How often to check for staged items (default 60s) |
| Stale Timeout | When to auto-fail stuck items (default 30min) |

### 3. Stage an Action Item

In DevSpec, find an action item with the "Agent" badge. Click **Stage for Autopilot** (fully autonomous) or **Request Agent Plan** (agent analyzes first, you approve before execution).

### 4. Start the Autopilot

In Claude Code:

```
/devspec-autopilot:autopilot.start
```

By default, the autopilot picks up items **assigned to you** plus the **unassigned grab-bag pool** — items the team hasn't earmarked for anyone yet. Items assigned exclusively to other people are left alone unless you opt in with `--all` (shared-queue mode) or `--assigned-to=<user_id>`.

Common variations:

```bash
# Default: assigned to you + unassigned, never stops on idle
/devspec-autopilot:autopilot.start

# Default filter, but stop after the queue drains
/devspec-autopilot:autopilot.start --drain

# Legacy shared-queue mode — every staged item the caller can see
/devspec-autopilot:autopilot.start --all

# Run on a specific teammate's queue (assigned to them + unassigned)
/devspec-autopilot:autopilot.start --assigned-to=<user_id>

# Author-based filter (orthogonal to assignee — stacks if both are set)
/devspec-autopilot:autopilot.start --created-by=<user_id>

# Pin the run to a specific project (only needed when the workspace's git remote
# is tracked by more than one of your DevSpec projects)
/devspec-autopilot:autopilot.start --project-id=<project_uuid>
```

The autopilot enters a polling loop, checks for staged items on your configured interval, processes one per cycle, and reports results back to DevSpec.

## Commands

All commands are namespaced under the plugin, so they're invoked as `/devspec-autopilot:<command>` (Claude Code shows them in the `/` menu once the plugin is installed).

### Autopilot

| Command | Description |
|---------|-------------|
| `autopilot.start` | Start the polling loop (default: assigned to you + unassigned) |
| `autopilot.stop` | Stop after the current cycle completes |
| `autopilot.status` | Show current state, staged item count, and settings |
| `autopilot.history` | Show recent runs with success/failure stats |

### DevSpec workflow

| Command | Description |
|---------|-------------|
| `devspec.work` | Pick up an action item by name, optionally brainstorm, implement it in an isolated worktree, push/merge per settings, and record the implementation. Supports `--unattended` and `--remote`. |
| `devspec.create` | Create an action item in DevSpec from the terminal |
| `devspec.brainstorm` | Brainstorm on an action item to refine scope, approach, and edge cases |
| `devspec.commit` | Generate a deployment-tracked commit message and execute `git commit` |
| `devspec.link` | Link a git commit to an action item |
| `devspec.done` | Log finished work to DevSpec — commits, testing notes, and all |
| `devspec.help` | Ask how to use DevSpec — searches the official product docs and answers |
| `devspec.verify-connection` | Verify the DevSpec connection (token/plugin ping, or a tagged verification commit per tracked repo) |

### Remote control

| Command | Description |
|---------|-------------|
| `devspec.remote` | Connect this session as a **DevSpec remote-control** target (Agents page). Not Claude's built-in `/remote-control`. |
| `devspec.remote-stop` | Disconnect — this session's Agents entry goes offline immediately. |
| `devspec.session-brainstorm` | Continue a DevSpec chat session locally (invoked by the DevSpec "Continue in Local Agent" handoff) |

### Remote control (details)

After `/devspec-autopilot:devspec.remote`, the skill writes `~/.devspec/remote-control.json` (token resolved from project `.mcp.json` / `~/.claude.json` / env) and arms `hooks/scripts/devspec-remote-poll.mjs` in the background. The poller heartbeats and only wakes the model when you post from the Agents page. **Turn mirroring** is mechanical: `UserPromptSubmit` / `Stop` hooks run `mirror-turn.mjs` so the Agents transcript is two-sided without relying on the model. Stop with `/devspec-autopilot:devspec.remote-stop`.

**Requirement — Node.js on PATH:** the poller scripts are small **Node** programs (`devspec-remote-poll.mjs` / `remote-control-state.mjs`). You need **Node.js 18+** available as `node` (same requirement as the rest of the plugin). Idle polling is plain HTTP to DevSpec MCP — it does **not** consume LLM tokens. Without Node, the skill falls back to a coarser in-agent poll loop that is less reliable; install Node for the supported experience.

## How It Works

### Polling Loop

```
Start → Check for stale claims → Fetch staged items → Claim one →
  → Create worktree → Implement → Test → Commit → Push → Merge →
  → Report success → Clean up → Wait → Repeat
```

- **One item per cycle** — if it fails, the cycle stops and the error is reported
- **Stale claim recovery** — items stuck in "in progress" beyond the timeout are auto-failed
- **Race condition safe** — claiming uses a conditional database update; if another instance grabs it first, this one moves on

### Planning Mode

For complex items, use "Request Agent Plan" in DevSpec instead of "Queue for Autopilot":

1. The autopilot reads the item and analyzes the codebase
2. It writes a proposed implementation plan as an implementation note
3. You review the plan in DevSpec
4. Click "Approve & Queue" to proceed with execution, or "Reject" to cancel

No code changes, branches, or commits are made during planning.

### Three-Layer Prompt

The autopilot assembles its instructions from three layers:

1. **Layer 1** (from the skill): The base workflow — fetch, implement, test, push, report. Includes safety rules. Not user-modifiable.
2. **Layer 2** (from settings): Your custom instructions — project conventions, style guides, architectural constraints.
3. **Layer 3** (from DevSpec): The specific action item title, description, type, and priority.

### Safety Rules

- Never asks for user input during execution
- Never force-pushes to any branch
- Never modifies files matching protected path patterns
- All work happens in an isolated git worktree
- All decisions are documented in implementation notes
- If an item is too vague, it fails with "Requires human judgment" rather than guessing

## Monitoring

### In DevSpec

- Action items show agent activity badges (staged, implementing, reporting, finished, failed)
- Completed items link to the branch and commit
- Failed items show the error with a Retry button
- The **Autopilot Runs** dashboard shows success rate, timing, and run history

### In Claude Code

```
/devspec-autopilot:autopilot.status    # loop state, cycles completed, last action, current settings
/devspec-autopilot:autopilot.history   # recent runs with action item titles, outcomes, and timing
```

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Commands don't appear in `/` menu | Plugin not installed/enabled | Re-run the install steps and `/reload-plugins` |
| `node: command not found` in hooks/poller | Node.js not on PATH | Install Node.js 18+ and confirm `node --version` |
| "No staged items" every cycle | No items staged in DevSpec | Stage an item with the "Stage for Autopilot" button |
| "Autopilot is not enabled" | Project settings | Enable autopilot in Project Settings |
| "Claim failed" | Another instance claimed it | Normal — next cycle picks up the next item |
| "Requires human judgment" | Action item description too vague | Edit the item description and retry |
| "Protected path violation" | Changes touched a protected file | Review protected paths in settings, or adjust the action item |
| "Stale claim" | Previous process crashed mid-work | Automatic — item is marked failed for you to retry |
| MCP connection errors | DevSpec server unreachable or token invalid | Check your MCP config and API token; run `/devspec-autopilot:devspec.verify-connection` |

## Project Structure

The plugin is defined entirely by its manifest, Markdown skills/commands, and Node hook scripts — there is no build step or bundled binary to run.

```
.claude-plugin/
├── plugin.json           # Plugin manifest (name, version, component paths)
└── marketplace.json      # Local-marketplace descriptor

commands/                 # Slash commands (/devspec-autopilot:<name>)
├── autopilot.start.md
├── autopilot.stop.md
├── autopilot.status.md
├── autopilot.history.md
├── devspec.work.md
├── devspec.create.md
├── devspec.brainstorm.md
├── devspec.commit.md
├── devspec.link.md
├── devspec.done.md
├── devspec.help.md
├── devspec.verify-connection.md
├── devspec.remote.md
├── devspec.remote-stop.md
└── devspec.session-brainstorm.md

skills/
└── autopilot/
    └── SKILL.md          # Full autopilot skill (the polling loop the model runs)

hooks/
├── hooks.json            # Stop / UserPromptSubmit turn-mirroring hooks
└── scripts/              # Node scripts (built-ins only — no npm install needed)
    ├── devspec-remote-poll.mjs    # Long-lived remote-control poller
    ├── devspec-remote-wait.mjs    # Wakes the model on owner messages
    ├── mirror-turn.mjs            # Mechanical turn mirroring to the Agents page
    ├── remote-control-state.mjs   # Remote-control session state
    ├── resolve-mcp-auth.mjs       # Resolves DevSpec MCP URL + token
    └── mcp-call.mjs               # Minimal JSON-RPC MCP client
```

## License

MIT
