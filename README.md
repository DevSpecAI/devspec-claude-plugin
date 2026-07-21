# DevSpec for Claude Code

Bring your team's DevSpec work into Claude Code — and drive Claude from your browser or phone.

[DevSpec](https://devspec.ai) tracks your team's tasks, bugs, and features — called **action items** — against your git repositories, along with the context, decisions, and history around them. This plugin connects [Claude Code](https://code.claude.com) to your DevSpec account so Claude can pick up that work, do it, and report back — and so you can steer a Claude Code session running on your machine from anywhere.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What you can do with it

- **⭐ Drive Claude from your browser or phone.** Connect a Claude Code session to DevSpec and send it instructions from the **Agents page** — no need to be at your terminal. Start a fresh session, or attach Claude to a DevSpec conversation you already have open. Teammates can follow along and add context in the same thread, while only you can actually steer it. → [Remote control](#-drive-a-session-from-devspec-remote-control)
- **Work a task end to end.** Point Claude at an action item and it implements the change on an isolated branch, runs your project's tests, commits, and hands it back for a human to review — all tracked in DevSpec.
- **Let Claude clear a queue.** Approve a batch of tasks in DevSpec, then run **autopilot** — Claude works through them one by one on its own.
- **Small conveniences.** Create tasks, make tracked commits, and ask DevSpec's docs questions without leaving the terminal.

Everything runs against your own DevSpec account and repositories, using an API token you control.

## Before you start

You'll need:

- **Claude Code** with plugin support (run `/plugin` to check it's available).
- A **[DevSpec](https://devspec.ai)** account with at least one project that's connected to your git repo(s).
- A **DevSpec API token** with `read_write` scope. Create one in DevSpec under **You → Connections** → **Connect a tool** (pick **Read & write**); it starts with `dvs_`. It's **account-wide** — one token covers all of your projects, so use the **same** token in every tool and on every machine (don't mint one per machine). Need it again? Reveal and copy it any time from **You → Connections**.
- **Node.js 18+** on your `PATH` (check with `node --version`). Remote control — the headline feature — needs it, as does setting up isolated work branches. Most other commands work without it, but you'll want it installed.

> **Heads up:** Claude Code's native installer sometimes ships without a system `node`. If `node --version` fails, install [Node.js 18+](https://nodejs.org) and make sure `node` is on your `PATH`.

## Install

Inside Claude Code:

```
/plugin marketplace add DevSpecAI/devspec-claude-plugin
/plugin install devspec@devspec
/reload-plugins
```

When you enable the plugin, Claude Code asks for your **DevSpec API token**. Paste your `dvs_…` token — it's stored securely on your machine (your OS keychain on macOS, an encrypted credentials file on Linux/Windows). The plugin bundles the DevSpec MCP server and wires it to your token for you, so **you don't need to add anything to `.mcp.json` or configure any URLs**.

<details>
<summary>Installing from a local clone (for contributors)</summary>

```bash
git clone https://github.com/DevSpecAI/devspec-claude-plugin.git
```

Then, in Claude Code (use the absolute path):

```
/plugin marketplace add /absolute/path/to/devspec-claude-plugin
/plugin install devspec@devspec
/reload-plugins
```

To update: `git pull` in the clone, then `/reload-plugins`. See [DEVELOPMENT.md](./DEVELOPMENT.md) for pointing the plugin at a staging or self-hosted DevSpec instance.

</details>

### Check the connection

Ask Claude:

```
Run the DevSpec connection check
```

You should see confirmation that you're connected as your DevSpec user. (If you're following DevSpec's setup wizard, this step turns green once the check passes.)

Commands appear in Claude Code's `/` menu after install, namespaced under the plugin — for example `/devspec:devspec.remote` and `/devspec:autopilot.start`.

## ⭐ Drive a session from DevSpec (remote control)

This is the feature most people come for. You run a real Claude Code session on your machine, but steer it from DevSpec — the **Agents page** in your browser, or your phone. Kick off work, answer its questions, and watch it go while you're away from your desk.

### Two ways to connect

**Start a new session** — in Claude Code, from the repo you want Claude to work in:

```
/devspec:devspec.remote
```

This creates a new remote session and lists it on DevSpec's Agents page. Open it there and start sending instructions.

**Attach to a session you already have open** — in DevSpec, open the session, and from its **settings panel copy the ready-made connect command** (a `/devspec:devspec.remote --session …` line). Paste it into Claude Code in the target repo. That DevSpec conversation is now wired to your local agent.

Either way, your prompts and Claude's replies are mirrored into the DevSpec thread, so the transcript stays two-sided and you can read it back from anywhere. Waiting for your next instruction is a lightweight background check — it does **not** spend Claude usage while idle. Disconnect this session (others stay connected) with `/devspec:devspec.remote-stop`.

### Who can talk to it

The collaboration is safe by design:

- **Only you can command it.** DevSpec verifies on its server that each instruction came from you — the person whose token the session uses. That can't be spoofed by anyone simply typing "I'm the owner."
- **Teammates can join the thread.** They (and DevSpec's own in-app AI) can add context and discuss right alongside you. Claude reads their messages as background, but will never take orders from them — instructions from anyone but you are treated as advisory context only.
- **Nobody can drive someone else's agent.** Steering a session requires that person's own token.

The result is a shared, watchable session the whole team can weigh in on — while only you hold the wheel.

> This is **not** Claude Code's built-in `/remote-control` for mobile/desktop. DevSpec's remote control is a separate feature and lives under `/devspec:devspec.remote`.

## Other workflows

### Work on a single task

```
/devspec:devspec.work <task name or id>
```

Claude claims the task, creates an isolated git branch, implements the change, runs your project's configured tests, and commits. When it's done, it records what it did — the files it touched, tests it ran, and a summary — back on the task in DevSpec, ready for a human to review and mark complete.

Two useful flags:

- `--unattended` — don't pause to ask questions; run start to finish (a task that's too vague to do safely is failed rather than guessed at).
- `--remote` — also connect this session to the Agents page so you can watch and steer from your browser.

### Let autopilot clear a queue

First, in DevSpec, mark the tasks you want Claude to handle as ready for autopilot (**Stage for Autopilot**, or approve a plan). Then:

```
/devspec:autopilot.start
```

Claude picks up each ready task, works it the same way as `devspec.work`, and moves to the next. By default it takes tasks assigned to you plus anything unassigned. Some variations:

```
/devspec:autopilot.start --drain                    # keep going until the queue is empty
/devspec:autopilot.start --all                       # include tasks assigned to others
/devspec:autopilot.start --project-id=<id>           # limit to one project
/devspec:autopilot.start --items=<id1>,<id2>         # only these tasks
```

Check in with `/devspec:autopilot.status` and `/devspec:autopilot.history`, and stop after the current task with `/devspec:autopilot.stop`.

**Want to review the plan first?** In DevSpec, use **Request Agent Plan** — Claude writes up its approach and waits. Nothing is coded until you **Approve & Queue**.

## All commands

Every command is in Claude Code's `/` menu after install, under the `/devspec:` prefix.

| Command | What it does |
|---|---|
| `/devspec:devspec.remote` | ⭐ Connect this session to DevSpec's Agents page (see above) |
| `/devspec:devspec.remote-stop` | Disconnect this session from the Agents page |
| `/devspec:devspec.work` | Pick up an action item, implement it, and record the work |
| `/devspec:devspec.brainstorm` | Talk through scope and approach before writing code |
| `/devspec:devspec.create` | Create a new action item from the terminal |
| `/devspec:devspec.commit` | Write a tracked commit message and commit |
| `/devspec:devspec.link` | Link an existing commit to an action item |
| `/devspec:devspec.done` | Log work you already finished (commits, testing notes) |
| `/devspec:devspec.help` | Ask a question and get an answer from DevSpec's docs |
| `/devspec:devspec.verify-connection` | Confirm the plugin is connected |
| `/devspec:autopilot.start` | Start working through approved tasks automatically |
| `/devspec:autopilot.stop` | Stop after the current task finishes |
| `/devspec:autopilot.status` | Show what autopilot is doing right now |
| `/devspec:autopilot.history` | Show recent autopilot runs and their outcomes |

## How it finds the right project

You don't pass a project id in most cases. The plugin matches the git remote of the repo you're in to the DevSpec project that tracks it. If a single repo is tracked by more than one project, add `--project-id=<id>` to point at the one you mean.

## Settings that live in DevSpec

How Claude branches, commits, tests, and merges is controlled per project in DevSpec (**Settings → Execution**), so it stays consistent whether you run a task by hand or via autopilot:

| Setting | Controls |
|---|---|
| Auto-push / Auto-merge | Whether branches are pushed, and merged into the target branch |
| Target branch (per repo) | The branch Claude's work lands on |
| Branch / commit prefixes | How autopilot names branches and commits |
| Test commands | What Claude runs after making a change (unit, E2E, typecheck) |
| Protected paths | Files and folders Claude must not touch |
| Custom instructions | Extra project rules Claude follows |

## What it will and won't do

- Changes are made on an **isolated branch** — your working checkout stays clean.
- It **never force-pushes**, and it respects the protected paths you set.
- **Nothing is marked done on its own.** Claude does the work and records it; a human reviews and verifies in DevSpec.
- In autopilot or `--unattended` mode it won't stop to ask clarifying questions — a task that's too ambiguous to do safely is failed with a reason, not guessed at.
- Commits it makes for a tracked task carry a small `[devspec:…]` tag so DevSpec can link the commit — and later the deployment — back to the task.

## Troubleshooting

| Problem | Fix |
|---|---|
| Commands don't appear in `/` | Reinstall with `/plugin install devspec@devspec`, then `/reload-plugins` |
| Plugin won't load, or hook errors | Update to the latest version (`git pull` for local installs) and `/reload-plugins` |
| Never asked for a token, or need to change it | Run `/plugin` → **Installed** → **DevSpec**, press Enter, and enter/update your `dvs_…` token there (the prompt fires when you *enable* the plugin) |
| Connection check fails | Confirm your token has `read_write` scope; regenerate it under DevSpec **You → Connections**, then re-enter it via `/plugin` → **Installed** → **DevSpec** |
| Remote control won't start / `node: command not found` | Install [Node.js 18+](https://nodejs.org) and make sure `node` is on your `PATH` |
| "No matching project" | Make sure the repo is tracked in DevSpec, or pass `--project-id=<id>` |
| Autopilot says "no tasks" | Mark tasks ready for autopilot in DevSpec and confirm autopilot is enabled for the project |
| "Claim failed" during autopilot | Another runner picked up that task first — this is normal; autopilot continues |

## Contributing

The plugin is Markdown commands and skills plus a few dependency-free Node scripts — no build step. See [DEVELOPMENT.md](./DEVELOPMENT.md) for how it's structured, how to run the tests, and how to develop against a non-production DevSpec instance. Release notes are in [CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE)
