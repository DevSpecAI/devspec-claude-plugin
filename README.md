# claude-code-devspec-autopilot

**Put your action items on autopilot.** Queue an action item in DevSpec, and this Claude Code plugin picks it up, implements it, tests it, and pushes the result — all without leaving your IDE.

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

## Prerequisites

- **Claude Code** v1.0.33+
- **DevSpec** account with a project that has action items
- **DevSpec API token** (read_write scope) — generate one in DevSpec under API settings
- **Node.js** 18+

## Install

### Option 1: Local Install (development)

```bash
# Build the plugin
cd claude-code-scheduler
npm install
npm run build

# In Claude Code, install from local path
/install-plugin /absolute/path/to/claude-code-scheduler
```

### Option 2: From Marketplace (once published)

```
/plugin marketplace add claude-code-devspec-autopilot
```

## Setup

### 1. Configure the DevSpec MCP Server

The plugin communicates with DevSpec through MCP. Add the DevSpec MCP server to your Claude Code configuration.

In your project's `.mcp.json` or Claude Code MCP settings, add:

```json
{
  "mcpServers": {
    "devspec": {
      "type": "url",
      "url": "https://your-devspec-instance.com/api/mcp",
      "headers": {
        "Authorization": "Bearer dvs_your_api_token_here"
      }
    }
  }
}
```

The token needs **read_write** scope for the project you want the autopilot to work on.

### 2. Configure Autopilot Settings in DevSpec

Open your project in DevSpec, go to **Settings**, and scroll to **Autopilot Configuration**:

| Setting | Default | Description |
|---------|---------|-------------|
| Enabled | off | Must be on for the autopilot to process items |
| Target Branch | `staging` | Branch to merge completed work into |
| Auto-push | on | Push feature branches to remote |
| Auto-merge | on | Merge feature branches into target branch |
| Branch Prefix | `fix/action-item-` | Prefix for feature branch names |
| Commit Prefix | `[autopilot] ` | Prefix for commit messages |
| Test Commands | (empty) | Unit, E2E, and typecheck commands to run |
| Protected Paths | (empty) | Files the agent must never modify (glob patterns) |
| Custom Instructions | (empty) | Extra context injected into the agent's prompt |
| Poll Interval | 60s | How often to check for queued items |
| Stale Timeout | 30min | When to auto-fail stuck items |

### 3. Queue an Action Item

In DevSpec, find an action item with the "Agent" badge. Click **Queue for Autopilot** (fully autonomous) or **Request Agent Plan** (agent analyzes first, you approve before execution).

### 4. Start the Autopilot

In Claude Code:

```
/autopilot:start
```

The autopilot enters a polling loop. It checks for queued items every 60 seconds (configurable), processes one per cycle, and reports results back to DevSpec.

## Commands

| Command | Description |
|---------|-------------|
| `/autopilot:start` | Start the polling loop |
| `/autopilot:stop` | Stop after the current cycle completes |
| `/autopilot:status` | Show current state, queued item count, settings |
| `/autopilot:history` | Show recent runs with success/failure stats |

## How It Works

### Polling Loop

```
Start → Check for stale claims → Fetch queued items → Claim one →
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

1. **Layer 1** (hardcoded): The base workflow — fetch, implement, test, push, report. Includes safety rules. Not user-modifiable.
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

- Action items show agent status badges (queued, in progress, completed, failed)
- Completed items link to the branch and commit
- Failed items show the error with a Retry button
- The **Autopilot Runs** dashboard shows success rate, timing, and run history

### In Claude Code

```
/autopilot:status
```

Shows whether the loop is running, cycles completed, last action, and current settings.

```
/autopilot:history
```

Shows recent runs with action item titles, outcomes, and timing.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| "No queued items" every cycle | No items queued in DevSpec | Queue an item with "Queue for Autopilot" button |
| "Autopilot is not enabled" | Project settings | Enable autopilot in Project Settings |
| "Claim failed" | Another instance claimed it | Normal — next cycle picks up the next item |
| "Requires human judgment" | Action item description too vague | Edit the item description and retry |
| "Protected path violation" | Changes touched a protected file | Review protected paths in settings, or adjust the action item |
| "Stale claim" | Previous process crashed mid-work | Automatic — item is marked failed for you to retry |
| MCP connection errors | DevSpec server unreachable | Check your MCP config and API token |

## Project Structure

```
src/
├── types.ts              # Zod schemas (ActionItem, AutopilotSettings, CycleResult)
├── config.ts             # State management and settings parsing
├── autopilot/
│   ├── loop.ts           # Polling loop logic and cycle formatting
│   ├── prompt.ts         # Three-layer prompt assembly
│   └── executor.ts       # Execution orchestration (full + planning mode)
├── mcp/
│   └── client.ts         # DevSpec MCP tool call helpers
├── vcs/
│   ├── index.ts          # Git worktree operations (create, commit, push, merge, cleanup)
│   └── types.ts          # Worktree type definitions
├── logs/
│   └── index.ts          # Execution log file management
├── history/
│   └── index.ts          # JSONL execution history tracking
└── utils/
    └── shell.ts          # Shell escaping and path validation

commands/
├── autopilot-start.md    # /autopilot:start
├── autopilot-stop.md     # /autopilot:stop
├── autopilot-status.md   # /autopilot:status
└── autopilot-history.md  # /autopilot:history

skills/
└── autopilot/
    └── SKILL.md          # Full autopilot skill definition (Layer 1 prompt)
```

## License

MIT
