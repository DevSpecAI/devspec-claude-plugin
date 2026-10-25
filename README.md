# DevSpec for Claude Code

Connect [Claude Code](https://code.claude.com) to [DevSpec](https://devspec.ai) with one plugin. Once installed, Claude Code connects to your DevSpec project automatically when you start it in a repository linked to that project, appears on your project's **Agents** page, works from your tasks, decisions, and documents, and can be steered live from your phone or the web.

## Requirements

- [Claude Code](https://code.claude.com)
- Node.js 18 or later (`node --version` — install from [nodejs.org](https://nodejs.org/en/download) if needed)

## Setup

### 1. Install the DevSpec plugin

Inside Claude Code, run these three commands one by one:

```text
/plugin marketplace add DevSpecAI/devspec-claude-plugin
/plugin install devspec@devspec
/reload-plugins
```

### 2. Paste your DevSpec token

When Claude Code installs the plugin, it prompts you for your DevSpec API token. Create a token with **Read & write** access on your [Agents settings](https://app.devspec.ai/settings/agents) page and paste your `dvs_…` token when asked.

To change your token later, open `/plugin` → **Installed** → **DevSpec** in Claude Code.

### 3. Optional — recommended for phone and voice control: skip permission prompts

By default, Claude Code pauses in the terminal and waits for your approval before editing files or running commands. When you are driving Claude Code remotely from your phone or by voice, skipping permission prompts keeps work from stalling at your computer while Claude Code's built-in safety checks remain in place.

Either start Claude Code with:

```bash
claude --dangerously-skip-permissions
```

or add `"defaultMode": "bypassPermissions"` to `~/.claude/settings.json` (`%USERPROFILE%\.claude\settings.json` on Windows):

```json
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
```

### 4. Start Claude Code and connect to your project

- **Inside a linked repository:** Start `claude` (or `claude --dangerously-skip-permissions`) in the folder where you cloned the Git repository linked to your DevSpec project. Claude Code connects to that project automatically and appears on the project's **Agents** page.
- **In any other folder, or when switching projects:** Start Claude Code and run `/devspec:devspec.project` to choose which project this conversation belongs to.

Waiting on the **Agents** page costs nothing — Claude Code only runs when you or an authorized teammate asks it to do something.

## Commands

Everything in DevSpec can be asked in plain words ("Work on DevSpec task 4f2a", "What did we decide about caching?", "Create a task for the login redirect bug"). The plugin also adds three slash commands:

| Command | What it does |
|---|---|
| `/devspec:devspec.remote` | Connects this Claude Code conversation to DevSpec and waits on the **Agents** page outside any session. |
| `/devspec:devspec.remote --project "Client Website"` | Connects and selects a project for this conversation without changing the folder default. |
| `/devspec:devspec.remote --session <id>` | Connects and joins an existing DevSpec session. |
| `/devspec:devspec.remote --new` | Creates a new shared DevSpec session and joins it (`--new --private` creates a private session). |
| `/devspec:devspec.remote --name "Night Owl"` | Connects under the codename you choose instead of one DevSpec picks. |
| `/devspec:devspec.remote-stop` | Disconnects this conversation from DevSpec while leaving other Claude Code terminals running. |
| `/devspec:devspec.project` | Shows the current project and folder default, or lets you `choose`, `remember`, or `forget` a project. |

To turn off automatic connection at startup, switch off **Make Claude Code available on DevSpec when it starts** under `/plugin` → **Installed** → **DevSpec**. You can still connect on demand with `/devspec:devspec.remote`.

## Choosing and remembering a project

When a repository belongs to more than one DevSpec project, or you open Claude Code in a folder without a Git remote, run `/devspec:devspec.project`:

- `/devspec:devspec.project` (or `/devspec:devspec.project status`) shows the selected project, organization, full project ID, how it was selected, and any folder default.
- `/devspec:devspec.project choose` selects a project for this conversation. Switching away from a project you have already been working in gives you a command to start a fresh Claude Code conversation so context from one project never leaks into another.
- `/devspec:devspec.project remember` saves the current project to `.devspec/project.json` in the folder after showing the file path and asking for confirmation.
- `/devspec:devspec.project forget` removes the `.devspec/project.json` folder default after confirmation without disconnecting active conversations.

## Updating

Inside Claude Code, run:

```text
/plugin marketplace update devspec
/plugin update devspec@devspec
```

Then start a new Claude Code conversation so the updated plugin is loaded. Release notes are in [CHANGELOG.md](./CHANGELOG.md).
