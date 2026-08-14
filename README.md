# DevSpec for Claude Code

Bring your team's DevSpec work into Claude Code — and drive Claude from your browser or phone.

[DevSpec](https://devspec.ai) tracks your team's tasks, bugs, and features — called **action items** — against your git repositories, along with the context, decisions, and history around them. This plugin connects [Claude Code](https://code.claude.com) to your DevSpec account so Claude can pick up that work, do it, and report back — and so you can steer a Claude Code session running on your machine from anywhere.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What you can do with it

- **⭐ Drive Claude from your browser or phone.** Connect a Claude Code session to DevSpec and send it instructions from the **Agents page** — no need to be at your terminal. Start a fresh session, or attach Claude to a DevSpec conversation you already have open. Teammates can follow along and add context in the same thread, while only you can actually steer it. → [Remote control](#-drive-a-session-from-devspec-remote-control)
- **Work a task end to end.** Point Claude at an action item and it implements the change on an isolated branch, runs your project's tests, commits, and hands it back for a human to review — all tracked in DevSpec.
- **Let Claude clear a queue.** Stage a batch of tasks in DevSpec, and any idle connected session of yours picks them up — Claude works through them one by one on its own.
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

Commands appear in Claude Code's `/` menu after install, namespaced under the plugin — for example `/devspec:devspec.remote` and `/devspec:devspec.work`.

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

### Let a queue clear itself

Stage the tasks in DevSpec (Action Items → **Stage for Autopilot**, or approve a plan). That's the whole setup: DevSpec hands the batch to one of your idle connected sessions — no command to start, nothing to enroll — and Claude works the members in order, the same way as `devspec.work`, recording progress on each task as it goes. When the batch finishes, the session simply goes back to being available.

Watch from the **Agents page** if you like: each batch shows which session holds it, and a batch still waiting says why (no idle session, or the tool it needs isn't running). A task Claude can't do safely is failed with a reason, not guessed at — and because that's tracked on the task itself, you're not paged into a room nobody is watching.

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

## How it finds the right project

You don't pass a project id in most cases. The plugin matches the git remote of the repo you're in to the DevSpec project that tracks it. If a single repo is tracked by more than one project, add `--project-id=<id>` to point at the one you mean.

**No repo yet?** A folder with no git remote can still say which project it belongs to: put

```json
{ "project_id": "<your project uuid>" }
```

in `.devspec/project.json` at the root of that folder. That's useful when you're starting a project in DevSpec before the code exists — plan the work, let your agent write it, then create the repo and connect it later.

Two things worth knowing. It holds a project id and **no file paths**, so moving or renaming the folder never breaks it. And it isn't a secret, so you can commit it — then anyone who clones the repo is pointed at the right project with no setup at all.

A real git remote always wins over the pin. So if you pin a folder and later connect its repo to a different project, the repo is believed — and a pin that arrives by copying a template quietly stops mattering instead of hijacking your folder.

## Settings that live in DevSpec

How Claude branches, commits, tests, and merges is controlled per project in DevSpec (**Settings → Execution**), so it stays consistent whether you run a task by hand or it arrives as a staged batch:

| Setting | Controls |
|---|---|
| Auto-push / Auto-merge | Whether branches are pushed, and merged into the target branch |
| Target branch (per repo) | The branch Claude's work lands on |
| Branch / commit prefixes | How Claude names branches and commits |
| Test commands | What Claude runs after making a change (unit, E2E, typecheck) |
| Protected paths | Files and folders Claude must not touch |
| Custom instructions | Extra project rules Claude follows |

## What it will and won't do

- Changes are made on an **isolated branch** — your working checkout stays clean.
- It **never force-pushes**, and it respects the protected paths you set.
- **Nothing is marked done on its own.** Claude does the work and records it; a human reviews and verifies in DevSpec.
- In `--unattended` runs and dispatched batches it won't stop to ask clarifying questions — a task that's too ambiguous to do safely is failed with a reason, not guessed at.
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
| A staged batch isn't being picked up | Check the batch's lane on the Agents page — it says why (no idle session of yours, or the tool the batch needs isn't running) |
| "Claim failed" in a batch | Another connection claimed that task first — this is normal; the batch continues |

## Contributing

The plugin is Markdown commands and skills plus a few dependency-free Node scripts — no build step. See [DEVELOPMENT.md](./DEVELOPMENT.md) for how it's structured, how to run the tests, and how to develop against a non-production DevSpec instance. Release notes are in [CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE)
