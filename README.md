# DevSpec for Claude Code

**Build on your team's best thinking.** [DevSpec](https://devspec.ai) is where your team, your shared knowledge, and your coding agents build software together.

Installing the DevSpec plugin connects Claude Code directly to your DevSpec projects — giving your agent durable project memory, structured task execution, automatic commit provenance, and live remote control from your phone or browser.

---

## Why DevSpec + Claude Code?

- **Shared team memory that never goes stale** — Claude Code recalls the architectural decisions, conventions, risks, and reference docs that apply to the code it's touching. When you make a new decision together, Claude records it to DevSpec so every teammate and every agent stays aligned.
- **Steer Claude Code live from your phone or the web** — Connect any Claude Code terminal to a DevSpec session room (`/devspec:devspec.remote`). Chat with your running agent from [devspec.ai](https://devspec.ai), collaborate with teammates in shared rooms, answer structured agent questions and polls, and track multi-phase execution plans in real time.
- **Tasks, criteria, and automatic commit provenance** — Claim tasks with full project context. While a task is claimed, the plugin automatically tags your commits (`[devspec:<id>]`), links pull requests, and records test evidence against each acceptance criterion.
- **Protected intent** — DevSpec screens changes against your team's recorded decisions and requirements, catching accidental reversals or duplicate work before it lands.

---

## Quick Start

### 1. Install the DevSpec plugin

Inside Claude Code, run:

```text
/plugin marketplace add DevSpecAI/devspec-claude-plugin
/plugin install devspec@devspec
/reload-plugins
```

### 2. Enter your DevSpec token

When Claude Code installs the plugin, it prompts you for your DevSpec API token. Create a **Read & write** token on your [Agent setup](https://app.devspec.ai/settings/agents) page and paste your `dvs_…` token when asked.

*(To update your token later, open `/plugin` → **Installed** → **DevSpec** in Claude Code.)*

### 3. Connect to your project

- **In a linked repository:** Start `claude` in any Git repository linked to your DevSpec project. Claude Code connects to that project automatically and appears on the project's **Agents** page.
- **In any other folder, or when switching projects:** Run `/devspec:devspec.project` to choose which project this conversation belongs to.

Waiting on the **Agents** page costs nothing — Claude Code only runs when you or an authorized teammate asks it to do something.

> **Tip for phone and remote control:** By default, Claude Code pauses in the terminal for local approval before editing files or running commands. When driving Claude Code remotely from your phone or the web, start it with `claude --dangerously-skip-permissions` (or set `"defaultMode": "bypassPermissions"` under `"permissions"` in `~/.claude/settings.json`) so work doesn't stall waiting at your desk.

---

## Commands

You can ask Claude Code to do anything in DevSpec in plain English (*"Work on DevSpec task 4f2a"*, *"What did we decide about caching?"*, *"Create a task for the login redirect bug"*).

The plugin also adds these slash commands inside Claude Code:

| Command | What it does |
|---|---|
| `/devspec:devspec.remote` | Connects this Claude Code conversation to DevSpec and waits on the **Agents** page outside any session. |
| `/devspec:devspec.remote --new` | Connects and starts a fresh shared DevSpec session room (`--new --private` for a private room). |
| `/devspec:devspec.remote --session <id>` | Connects and joins an existing DevSpec session room. |
| `/devspec:devspec.remote --project "<name>"` | Connects and selects a project for this conversation without changing the folder default. |
| `/devspec:devspec.remote --name "Night Owl"` | Connects using a custom agent codename. |
| `/devspec:devspec.remote-stop` | Disconnects this conversation from DevSpec while leaving other Claude Code terminals running. |
| `/devspec:devspec.project` | Inspects or changes the active project (`status`, `choose`, `remember`, or `forget`). |

To turn off automatic connection at startup, switch off **Make Claude Code available on DevSpec when it starts** under `/plugin` → **Installed** → **DevSpec**. You can still connect on demand with `/devspec:devspec.remote`.

---

## Learn More

- **Web & Sign Up:** [devspec.ai](https://devspec.ai)
- **App & Agent Setup:** [app.devspec.ai/settings/agents](https://app.devspec.ai/settings/agents)
- **Privacy Policy:** [devspec.ai/privacy](https://devspec.ai/privacy)
- **Changelog:** [CHANGELOG.md](./CHANGELOG.md)
