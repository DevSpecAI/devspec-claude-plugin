# DevSpec for Claude Code

Bring your team's DevSpec work into Claude Code — and drive Claude from your browser or phone.

[DevSpec](https://devspec.ai) tracks your team's tasks, bugs, and features — called **action items** — against your git repositories, along with the context, decisions, and history around them. This plugin connects [Claude Code](https://code.claude.com) to your DevSpec account so Claude can implement the action-item work you request and report back — and so you can steer a Claude Code session running on your machine from anywhere.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What you can do with it

- **⭐ Drive Claude from your browser or phone.** Connect a Claude Code session to DevSpec and send it instructions from the **Agents page** — no need to be at your terminal. Start a fresh session, or attach Claude to a DevSpec conversation you already have open. Teammates can follow along and add context in the same thread; only the owner or a server-authorized delegate can send an exactly addressed command. → [Remote control](#-drive-a-session-from-devspec-remote-control)
- **Work a task end to end.** Point Claude at an action item and it implements the change on an isolated branch, runs your project's tests, commits, and hands it back for a human to review — all tracked in DevSpec.
- **Work an explicit batch in order.** Ask Claude in a conversation to work named action items; it reserves the requested order, then claims and implements them one by one.
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

Two commands appear in Claude Code's `/` menu after install, namespaced under the plugin: `/devspec:devspec.remote` and `/devspec:devspec.remote-stop`. Everything else you might want is a sentence — see [Other workflows](#other-workflows).

## ⭐ Drive a session from DevSpec (remote control)

This is the feature most people come for. You run a real Claude Code session on your machine, but steer it from DevSpec — the **Agents page** in your browser, or your phone. Kick off work, answer its questions, and watch it go while you're away from your desk.

### Two ways to connect

**Register available capacity** — in Claude Code, from the repo you want Claude to work in:

```
/devspec:devspec.remote
```

This lists the connection on DevSpec's Agents page without inventing a chat transcript. Sessionless means available; it does not receive action-item assignments. Separately typed owner-scoped playbook runs may still target the connection through their own validated claim/report path.

**Attach to a session you already have open** — in DevSpec, open the session, and from its **settings panel copy the ready-made connect command** (a `/devspec:devspec.remote --session …` line). Paste it into Claude Code in the target repo. That DevSpec conversation is now wired to your local agent. Use `/devspec:devspec.remote --new` when you explicitly want Claude to create and attach a new shared session.

When attached, canonical commands and Claude's direct answers use the DevSpec conversation, so the transcript stays two-sided and you can read it back from anywhere. Waiting for your next instruction is a lightweight background check — it does **not** spend Claude usage while idle. Disconnect this connection (others stay connected) with `/devspec:devspec.remote-stop`.

### Who can talk to it

The collaboration is safe by design. DevSpec decides owner/delegated command authority
and exact addressing on the server; requester provenance is preserved end to end, and
room, system, AI and agent messages remain advisory model context. Typed host controls
are not conversation messages. The versioned execution policy is published at
`devspec://product/remote-ingress-contract` rather than duplicated in this plugin.

> This is **not** Claude Code's built-in `/remote-control` for mobile/desktop. DevSpec's remote control is a separate feature and lives under `/devspec:devspec.remote`.

## Other workflows

**There is no command for these, and that is the point.** The plugin ships two
commands because connecting and disconnecting run a real setup script. Working
on an item does not — your agent already has the DevSpec tools, so you ask for
what you want in plain language.

### Work on a single task

```
Work on DevSpec action item 4f2a
```

Because the conversation explicitly asked for action-item work, Claude reserves it
so no other agent takes it mid-run, then claims it. The served
`devspec://product/implementation-contract` supplies the current lifecycle rules for
isolation, implementation, verification, commits and reporting; the plugin does not
keep a second copy of those rules.

Ask it to "also connect to the Agents page" and it will open a remote-control
channel while it works, so you can watch and steer from your browser.

### Work several tasks in order

```
Work these DevSpec items in order: 4f2a, 9c1b, 2e7d
```

Claude reserves all three in the requested order — that is what stops a second
agent picking up the third while the first is still in progress — then claims and
works each reserved item as it reaches it. DevSpec's web app has a copy button that
writes this line for you from a multi-select.

### Everything else

Ask for it. "Log a DevSpec item for the login bug." "I just finished the caching
fix — record it." "Write the commit message for 4f2a." "Link commit a1b2c3d to
4f2a." "How do I set up a deployment target?" Each maps to a DevSpec MCP tool
your agent can already see.

There used to be nine more commands here. Every one was a page of prose telling
a model to call a tool it already had, kept in six repositories with no way to
notice when one drifted out of date.

## All commands

Both commands are in Claude Code's `/` menu after install, under the `/devspec:` prefix.

| Command | What it does |
|---|---|
| `/devspec:devspec.remote` | ⭐ Connect this session to DevSpec's Agents page (see above) |
| `/devspec:devspec.remote-stop` | Disconnect this session from the Agents page |

## How it finds the right project

You don't pass a project id in most cases. The plugin matches the git remote of the repo you're in to the DevSpec project that tracks it. If a single repo is tracked by more than one project, add `--project-id=<id>` to point at the one you mean.

**No repo yet?** A folder with no git remote can still say which project it belongs to: put

```json
{ "project_id": "<your project uuid>" }
```

in `.devspec/project.json` at the root of that folder — agents look there and in any subdirectory beneath it, stopping at the repository root. That's useful when you're starting a project in DevSpec before the code exists — plan the work, let your agent write it, then create the repo and connect it later.

Two things worth knowing. It holds a project id and **no file paths**, so moving or renaming the folder never breaks it. And it isn't a secret, so you can commit it — then anyone who clones the repo is pointed at the right project with no setup at all.

A real git remote always wins over the pin. So if you pin a folder and later connect its repo to a different project, the repo is believed — and a pin that arrives by copying a template quietly stops mattering instead of hijacking your folder.

## Settings that live in DevSpec

How Claude branches, commits, tests, and merges is controlled per project in DevSpec (**Settings → Execution**), so it stays consistent whether you work one item by hand or a batch you were asked to take:

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
- It won't stall on a question nobody may be reading: a task too ambiguous to do safely is failed with a reason, not guessed at.
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
| A batch you asked for isn't being worked | Nothing routes work — an agent only holds what it reserved. Check the Agents page: it shows which agents are connected and what each is holding, so an unheld item means nobody was asked, not that delivery failed |
| "Claim failed" in a batch | Another connection claimed that task first — this is normal; the batch continues |

## Contributing

The plugin is Markdown commands and skills plus a few dependency-free Node scripts — no build step. See [DEVELOPMENT.md](./DEVELOPMENT.md) for how it's structured, how to run the tests, and how to develop against a non-production DevSpec instance. Release notes are in [CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE)
