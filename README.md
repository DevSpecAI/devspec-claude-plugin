# DevSpec for Claude Code

Connect [Claude Code](https://code.claude.com) to [DevSpec](https://devspec.ai) — the project intelligence and action-item platform for AI-native teams.

This plugin gives Claude Code a first-class DevSpec loop: claim and implement action items, mirror a session to the Agents page, run autopilot against a staged queue, and keep commits deployment-tracked. It ships as Claude Code skills, slash commands, hooks, and a bundled MCP server.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What you get

| Capability | What it does |
|---|---|
| **MCP connection** | Wires `https://devspec.ai/api/mcp` automatically; you only paste an API token |
| **Interactive work** | `/devspec:devspec.work`, brainstorm, create, commit, verify, help |
| **Agents remote control** | `/devspec:devspec.remote` — drive this Claude Code session from the DevSpec Agents page |
| **Autopilot** | `/devspec:autopilot.start` — poll staged items, implement in worktrees, test, push/merge, report back |

Commands are namespaced as `/devspec:<command>` (for example `/devspec:devspec.work`).

## Prerequisites

- **Claude Code** with plugin support (`/plugin` available)
- A **[DevSpec](https://devspec.ai)** account and at least one project that tracks your git repo(s)
- A DevSpec API token with **`read_write`** scope (Settings → API). Tokens are **account-wide** — one token covers all your projects
- **Node.js 18+** on your `PATH` (`node --version`) — required for remote-control poller/hooks and worktree dependency linking

> Native Claude Code installers often ship without a system `node`. Install [Node.js 18+](https://nodejs.org) separately so `node` resolves on your `PATH`.

## Install

### Option A — from GitHub (recommended once the repo is public)

Inside Claude Code:

```
/plugin marketplace add DevSpecAI/devspec-claude-plugin
/plugin install devspec@devspec
/reload-plugins
```

Claude Code prompts for your **DevSpec API token** on enable. Paste a `dvs_…` token; it is stored in the OS keychain (or Claude’s secure credential store). You do **not** need to type the MCP URL.

### Option B — local marketplace (development / private clone)

```bash
git clone https://github.com/DevSpecAI/devspec-claude-plugin.git
```

Then in Claude Code (use your absolute path; spaces are fine without quotes in the REPL):

```
/plugin marketplace add /absolute/path/to/devspec-claude-plugin
/plugin install devspec@devspec
/reload-plugins
```

Updates: `git pull` in the clone, then `/reload-plugins`.

### Verify the connection

In Claude Code, run:

```
Run the DevSpec connection check
```

or `/devspec:devspec.verify-connection` with no ID. You should see a confirmation that you’re connected as your DevSpec user. The personal setup wizard in DevSpec turns green when this ping succeeds.

## How project resolution works

DevSpec MCP tokens are account-wide — they do not pin a project. At the start of a run the plugin:

1. Reads `git remote get-url origin`
2. Calls `list_projects({ git_remote })`
3. Uses `remote_match.resolved_project_id` for project-scoped tools

If one remote is tracked by multiple projects, pass `--project-id=<uuid>` (supported on autopilot and the interactive work flows that need it).

## Quick starts

### 1. Work on a specific action item

```
/devspec:devspec.work <action-item-uuid>
```

Claims the item (if needed), implements in an isolated git worktree, runs configured tests, commits with a `[devspec:<id>]` tag, pushes/merges per project execution settings, and calls `record_implementation`.

Useful flags:

- `--unattended` — no human prompts; fire-and-forget
- `--remote` — also open an Agents-page remote-control channel for this session

Related:

```
/devspec:devspec.brainstorm <id>     # refine scope before implementing
/devspec:devspec.create              # create an item from the terminal
/devspec:devspec.commit              # deployment-tracked commit message + git commit
/devspec:devspec.done                # log finished work after the fact
/devspec:devspec.help                # ask product docs questions
```

### 2. Drive this session from the DevSpec Agents page

```
/devspec:devspec.remote
```

Creates (or soft-reconnects) a private **agent remote control** session, heartbeats to DevSpec, and mirrors turns so the Agents transcript stays two-sided. Post instructions from the Agents page; only the token owner’s messages are treated as commands.

Stop this session’s remote (leaves other remotes alone):

```
/devspec:devspec.remote-stop
```

Idle polling is plain HTTP to DevSpec MCP — it does **not** burn LLM tokens. Node.js on `PATH` is required for the supported poller; without Node the skill falls back to a coarser in-agent loop.

This is **not** Claude’s built-in `/remote-control` (mobile/desktop). DevSpec remote control is separate and lives under `/devspec:devspec.remote`.

### 3. Autopilot a staged queue

In DevSpec, stage items (**Stage for Autopilot** or approve a plan), ensure project execution/autopilot settings are configured, then:

```
/devspec:autopilot.start
```

Default filter: items **assigned to you** plus the **unassigned** pool. Common variants:

```
/devspec:autopilot.start --drain
/devspec:autopilot.start --all
/devspec:autopilot.start --assigned-to=<user_id>
/devspec:autopilot.start --created-by=<user_id>
/devspec:autopilot.start --project-id=<project_uuid>
/devspec:autopilot.start --items=<id1>,<id2>
```

Each cycle: claim → worktree → implement → test → commit → push → optional merge → `record_implementation` → cleanup. Monitor with `/devspec:autopilot.status` and `/devspec:autopilot.history`. Stop after the current cycle with `/devspec:autopilot.stop`.

Planning mode (no code until you approve): use **Request Agent Plan** in DevSpec, review the note, then **Approve & Queue**.

## Execution settings (DevSpec project)

Configure in the DevSpec project (Settings / execution). These apply to interactive work and autopilot:

| Setting | Role |
|---|---|
| Auto-push / Auto-merge | Push feature branches; merge into each repo’s target branch |
| Target branch (per repo) | Integration branch (`target_branch`, else `default_branch`) |
| Branch / commit prefixes | Naming for autopilot branches and commits |
| Test commands | Unit / E2E / typecheck commands to run after implementation |
| Protected paths | Globs the agent must not modify |
| Custom instructions | Extra project rules injected into the agent prompt |

Autopilot also uses poll interval, stale-claim timeout, and the project “autopilot enabled” flag for the background loop.

## Command reference

All commands are listed in Claude Code’s `/` menu after install.

### Workflow

| Command | Description |
|---|---|
| `devspec.work` | Claim/implement an action item in a worktree; record implementation |
| `devspec.brainstorm` | Refine scope, approach, and edge cases |
| `devspec.create` | Create an action item from the terminal |
| `devspec.commit` | Generate a tagged commit message and run `git commit` |
| `devspec.link` | Link a commit SHA to an action item |
| `devspec.done` | Log finished work (commits, testing notes) |
| `devspec.help` | Search DevSpec product docs and answer how-to questions |
| `devspec.verify-connection` | Ping token/plugin, or push tagged verify commits per tracked repo |
| `devspec.session-brainstorm` | Continue a DevSpec chat locally (“Continue in Local Agent”) |

### Remote control

| Command | Description |
|---|---|
| `devspec.remote` | Connect this session to the Agents page |
| `devspec.remote-stop` | Disconnect this session’s Agents entry |

### Autopilot

| Command | Description |
|---|---|
| `autopilot.start` | Start the polling loop |
| `autopilot.stop` | Stop after the current cycle |
| `autopilot.status` | Loop state, settings, staged count |
| `autopilot.history` | Recent runs and outcomes |

## Advanced: non-production MCP endpoint

The plugin defaults to `https://devspec.ai/api/mcp`. To point at staging or a self-hosted instance, define a user/project `devspec` MCP server — it **overrides** the plugin’s bundled server:

```json
{
  "mcpServers": {
    "devspec": {
      "type": "http",
      "url": "https://staging.devspec.ai/api/mcp",
      "headers": {
        "Authorization": "Bearer dvs_your_api_token_here"
      }
    }
  }
}
```

Prefer `~/.claude.json` (user scope) over a committed project `.mcp.json`. If you use a project file, gitignore it — it contains a secret.

## Safety model

- Work that changes the repo runs in an **isolated git worktree** (your main checkout stays clean)
- No force-push; protected paths are respected
- Autopilot / unattended modes do not stop for ad-hoc questions — vague items fail with “Requires human judgment”
- Lifecycle is DevSpec’s chain: claim → implement → `record_implementation` → human verify → done
- Commits that implement tracked items include `[devspec:<action-item-uuid>]` so deployment tracking can link them

## Troubleshooting

| Problem | Fix |
|---|---|
| Commands missing from `/` | Reinstall `devspec@devspec`, run `/reload-plugins` |
| Plugin failed to load / hooks error | Pull latest `main`; do not set `"hooks"` in `plugin.json` (Claude Code auto-loads `hooks/hooks.json`) |
| No token prompt | `/plugin` → DevSpec → **Configure options**, or reinstall |
| Connection check fails | Confirm `read_write` token; regenerate under Settings → API |
| `node: command not found` | Install Node.js 18+ and ensure `node` is on `PATH` |
| Wrong project / no project match | Ensure the repo is tracked in DevSpec; or pass `--project-id=` |
| Autopilot “no staged items” | Stage items in DevSpec; confirm autopilot is enabled for the project |
| Claim failed | Another runner won the race — normal; next cycle continues |

## Repository layout

No build step, no npm dependencies for runtime hooks.

```
.claude-plugin/
├── plugin.json          # Manifest (id, version, userConfig, mcpServers)
└── marketplace.json     # Marketplace catalog + renames

commands/                # Slash commands → /devspec:<name>
skills/autopilot/        # Autopilot loop skill
hooks/
├── hooks.json           # Turn-mirroring hooks (auto-loaded)
└── scripts/             # Node built-ins only
```

Maintainer notes: see [DEVELOPMENT.md](./DEVELOPMENT.md). Release history: [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
