# DevSpec for Claude Code

Once the plugin is configured, start Claude Code in your project folder and it connects to DevSpec automatically.

**Build on your team’s best thinking.**

[DevSpec](https://devspec.ai) is where your team, your knowledge and your agents build software together, made for AI-native development from the ground up.

Bring your team's DevSpec work into Claude Code — and drive Claude from your browser or phone. This plugin connects [Claude Code](https://code.claude.com) to your DevSpec account so Claude can implement the task work you request and report back — and so you can steer a Claude Code session running on your machine from anywhere.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What you can do with it

- **⭐ Drive Claude from your browser or phone.** Connect a Claude Code session to DevSpec and send it instructions from the **Agents page** — no need to be at your terminal. Start a fresh session, or attach Claude to a DevSpec conversation you already have open. Teammates can follow along and add context in the same thread; only the owner or a server-authorized delegate can send an exactly addressed command. → [Remote control](#-drive-a-session-from-devspec-remote-control)
- **Work a task end to end.** Point Claude at a task and it implements the change on an isolated branch, runs your project's tests, commits, and hands it back for a human to review — all tracked in DevSpec.
- **Work an explicit batch in order.** Ask Claude in a conversation to work named tasks; it reserves the requested order, then claims and implements them one by one.
- **Share material progress in the room.** For genuinely multi-phase work, Claude can maintain one revisioned session plan that every attached participant can follow and a reconnecting agent can resume. Routine read-only investigation stays plan-free.
- **Small conveniences.** Create tasks, make tracked commits, and ask DevSpec's docs questions without leaving the terminal.

Everything runs against your own DevSpec account and repositories, using an API token you control.

## Before you start

You'll need:

- **Claude Code** with plugin support (run `/plugin` to check it's available).
- A **[DevSpec](https://devspec.ai)** account with at least one project that's connected to your git repo(s).
- A **DevSpec API token** with `read_write` scope. Create one on the [Agents page in your DevSpec settings](https://app.devspec.ai/settings/agents): choose **Connect a tool** and pick **Read & write**; it starts with `dvs_`. It's **account-wide** — one token covers all of your projects, so use the **same** token in every tool and on every machine (don't mint one per machine). Need it again? Reveal and copy it any time from that same [Agents page](https://app.devspec.ai/settings/agents).
- **Node.js 18+** on your `PATH` (check with `node --version`). Remote control — the headline feature — needs it, as does setting up isolated work branches. Most other commands work without it, but you'll want it installed.

> **Heads up:** Claude Code's native installer sometimes ships without a system `node`. If `node --version` fails, install [Node.js 18+](https://nodejs.org) and make sure `node` is on your `PATH`.

## Install

Inside Claude Code:

```
/plugin marketplace add DevSpecAI/devspec-claude-plugin
/plugin install devspec@devspec
/reload-plugins
```

When you enable the plugin, Claude Code asks for your **DevSpec API token**. Paste your `dvs_…` token — it's stored securely on your machine (your OS keychain on macOS, an encrypted credentials file on Linux/Windows). While a Claude Code session is open, the plugin's own commands read it from a file in `~/.devspec` that only your user account can open, which is deleted when the session ends (or, after a crash, when the next session starts). The token is never put on a command line, where other accounts on the same computer could see it. The plugin bundles the DevSpec MCP server and wires it to your token for you, so **you don't need to add anything to `.mcp.json` or configure any URLs**.

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

Three commands appear in Claude Code's `/` menu after install: `/devspec:devspec.remote`, `/devspec:devspec.remote-stop`, and `/devspec:devspec.project`. Other workflows can still be requested in a sentence — see [Other workflows](#other-workflows).

## ⭐ Drive a session from DevSpec (remote control)

This is the feature most people come for. You run a real Claude Code session on your machine, but steer it from DevSpec — the **Agents page** in your browser, or your phone. Kick off work, answer its questions, and watch it go while you're away from your desk.

### It connects when Claude Code starts

Start Claude Code in a folder that belongs to one of your DevSpec projects and it appears on the **Agents page** within a few seconds, ready for your team to send it work. You don't type anything. Waiting costs nothing: Claude only starts working when someone actually sends it a message.

It only connects in folders that belong to a DevSpec project, meaning a repo your project tracks, or a folder with a `.devspec/project.json` pin (see [How it finds the right project](#how-it-finds-the-right-project)). Anywhere else it stays out of the way. If a folder becomes part of a project while Claude Code is open, because you or your agent add the pin or a repo your project tracks, it connects then, with no restart. To turn it off, run `/plugin` → **Installed** → **DevSpec**, press Enter, and switch off **Make Claude Code available on DevSpec when it starts**, the same place your token is set. You can still connect by hand whenever you like.

### Connecting by hand

**Register available capacity** — in Claude Code, from the repo you want Claude to work in:

```
/devspec:devspec.remote
```

This lists the connection on DevSpec's Agents page without inventing a chat transcript. Sessionless means available; it does not receive task assignments. Separately typed owner-scoped automation runs may still target the connection through their own validated claim/report path.

**Attach to a session you already have open** — in DevSpec, open the session, and from its **settings panel copy the ready-made connect command** (a `/devspec:devspec.remote --session …` line). Paste it into Claude Code in the target repo. That DevSpec conversation is now wired to your agent. Use `/devspec:devspec.remote --new` when you explicitly want Claude to create and attach a new shared session.

**Choosing a project.** Normal connection stays automatic when the repository or existing pin resolves. If it is ambiguous, Claude offers accessible projects labelled with their organisations using its native question UI. Cancel leaves it unconnected. You can also specify an exact name or ID: `/devspec:devspec.remote --project "Client Website"`. Duplicate names require a choice; a partial name is not guessed.

The choice belongs to this **local Claude conversation**, including resume, and is applied to normal DevSpec tools as well as Remote. Choosing does not write a folder pin. `/devspec:devspec.project remember` saves a folder default, warning you once that the file can be shared; `forget` removes it. Neither changes an already-selected conversation. To switch an established conversation, use `/devspec:devspec.project choose`. Claude prepares a **fresh** native conversation and gives you a `claude --session-id …` command to run in a new terminal. Its project is selected before auto-connect, without changing the folder default or carrying old model context across organisations. `/clear` may retain a same-project remote connection; it is not a project switch. Project choice is separate from DevSpec room selection and Claude's own resume flags.

When attached, canonical commands and Claude's direct answers use the DevSpec conversation, so the transcript stays two-sided and you can read it back from anywhere. Disconnect this connection (others stay connected) with `/devspec:devspec.remote-stop`.

**See it in the terminal (Claude Code 2.1.289+).** While Claude Code is connected, a line under the prompt shows the name it has on the Agents page, the DevSpec project, the session it is attached to and the item it is working on:

```
devspec: Cosmic Raven · DevSpec · “Fix the login redirect” · working on c6dcb524
```

A short notice appears when it connects.

**Waiting for you shows in DevSpec.** If Claude Code stops on something only you can answer in its terminal, such as a permission prompt or a connected tool asking a question, DevSpec shows the agent as waiting for you, says what for ("Approve Bash"), and notifies you. Only the tool's name is sent, never what it was going to run. You still answer it in the terminal.

**Stop, thinking, compact and clear work from DevSpec.** While Claude is working, the square Stop button in the session's composer stops it in its terminal, just as pressing Esc there would. Claude Code and the conversation stay open for your next message. From the agent's controls in the composer, or by typing `/thinking high`, `/compact` or `/clear` to it, you can change how hard Claude thinks, compact its conversation or clear it, exactly as typing `/effort`, `/compact` or `/clear` in its terminal would. After a clear, Claude starts a fresh conversation and stays connected to the same session; the old conversation can still be picked up with `claude --resume`. Like `/effort` there, a new thinking level also becomes Claude Code's default for that model in new sessions. If Claude is busy, the change happens when it finishes what it is doing. DevSpec offers these only when this Claude Code can carry them out (they need a recent Claude Code). Switching model from DevSpec is not available for Claude Code: Claude Code asks for confirmation in its own terminal before switching model part-way through a conversation, and nobody is there to answer when you are steering from DevSpec.

**Ending it from DevSpec closes it.** When you end the agent from DevSpec (End on the Agents page or in a session), its Claude Code closes in its terminal, even if it is in the middle of something, so you don't have to hunt through your tabs for it. The conversation is kept, and you can pick it up again with `claude --resume`. Stopping it from the terminal with `/devspec:devspec.remote-stop`, detaching it from a session, or a blip on DevSpec's side never closes it. On Windows it is not closed yet: the line under the prompt changes to `devspec: Cosmic Raven · ended from DevSpec` instead. On older Claude Code versions the line does not appear and everything else works the same.

### Shared session plans

Claude keeps routine read-only investigation and quick answers plan-free. When work has material multi-phase progress that others in the room need to follow or resume, it creates one shared plan, advances it atomically at meaningful boundaries, and explicitly completes or abandons it. Reconnecting agents receive the latest revision.

Everyone attached to the room can read a plan; reading it gives no right to change it. A plan shows progress only: it never claims or records work.

### Who can talk to it

The collaboration is safe by design. DevSpec decides owner/delegated command authority
and exact addressing on the server. Delegated commands include a server-owned project
scope object and instruction; owner commands carry null scope and receive no injected
instruction. Requester provenance is preserved end to
end, and room, system, AI and agent messages remain advisory model context. Typed host
controls are not conversation messages. The mutable runtime policy is published at
`devspec://product/remote-ingress-contract` rather than duplicated in this plugin.

> This is **not** Claude Code's built-in `/remote-control` for mobile/desktop. DevSpec's remote control is a separate feature and lives under `/devspec:devspec.remote`.

## Other workflows

**There is no command for these.** Claude already has the DevSpec tools, so you
ask for what you want in plain language.

### Work on a single task

```
Work on DevSpec task 4f2a
```

Because the conversation explicitly asked for task work, Claude reserves it
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

### Decisions waiting in Review

Ask Claude to make any decision you could make on DevSpec's Review page and it
makes it as soon as your request is clear, then tells you what happened and what you
can do next. It warns you once, up front, only if you seem unaware of a significant
consequence (say, that it undoes someone's decision), and never asks you to confirm
again. Who may decide what is DevSpec's rule; if you can't, Claude says who can.

| To | Claude uses |
|---|---|
| See what is waiting | `get_review_queue` |
| Accept or decline a proposed change, or a request to confirm | `decide_proposal` |
| Answer on work that would undo a decision, let an experiment land, adopt or take ownership | `manage_protected_intent` |
| Say a memory or document flagged out of date is still accurate | `resolve_memory_flag`, `resolve_resource_flag` |
| Close a duplicate, or say two records are not duplicates | `resolve_duplicate`, `record_duplicate_nonmatch` |

## All commands

All three are in Claude Code's `/` menu after install, under the `/devspec:` prefix.

| Command | What it does |
|---|---|
| `/devspec:devspec.remote` | ⭐ Connect this session to DevSpec's Agents page (see above) |
| `/devspec:devspec.remote-stop` | Disconnect this session from the Agents page |
| `/devspec:devspec.project` | Show the conversation project and folder default; `choose`, `remember`, or `forget` |

### Repository context

Connecting also gives Claude the selected project's complete repository list, including remote URLs and tracked/default branches. These are project facts, not claims that code is cloned on this computer or that pushing is allowed. Description and vision remain available on demand.

If DevSpec can't be read, Claude says the list is unavailable rather than treating the project as empty.

**Linking your GitHub account.** When the project's repositories are on GitHub and you have not linked your GitHub account to DevSpec yet, Claude tells you once, with a link to open. Linking makes your pull requests and commits show as yours in DevSpec. It is one click, GitHub confirms who you are, and DevSpec keeps no access to your GitHub account. Nothing waits on it. You can also link or unlink it in DevSpec under **Settings → Sign-in & security**.

Update the installed plugin and start a new conversation after upgrading: Claude's version-keyed cache, not the repository checkout, supplies its hooks.

## How it finds the right project

You don't pass a project ID in most cases. A unique accessible repository match connects automatically, and a folder pin can resolve a shared remote or a greenfield folder. If several projects still match, choose for this conversation with `/devspec:devspec.remote --project "Project name"` or the native question UI. A folder pin is optional, not the price of choosing.

**No repo yet?** A folder with no git remote can still say which project it belongs to: put

```json
{ "project_id": "<your project uuid>" }
```

in `.devspec/project.json` at the root of that folder — agents look there and in any subdirectory beneath it, stopping at the repository root. That's useful when you're starting a project in DevSpec before the code exists — plan the work, let your agent write it, then create the repo and connect it later. When your agent gives a pinned folder its repository, it reminds you to add that repository to the project in DevSpec (**Settings → Integrations → Repositories**), so DevSpec can read the code and connect its commits to your work.

Two things worth knowing. It holds a project id and **no file paths**, so moving or renaming the folder never breaks it. And it isn't a secret, so you can commit it — then anyone who clones the repo is pointed at the right project with no setup at all.

A unique accessible remote match wins over a stale pin. If the remote matches several projects, a pin naming one of those candidates breaks the tie. An inaccessible pin is ignored; an inaccessible explicit project choice is refused, never replaced by another default.

For the full project ID, organisation, selection source and effective pin file, run `/devspec:devspec.project` or add `status`. You normally choose by readable names rather than hunting a UUID. Forgetting a local pin may reveal an inherited one; check the resulting details. Neither action changes existing conversations.

The instructions above describe plugin 0.32.14 or later. A change on `staging` is not a release to `main`, and neither updates a running installed copy. Update through Claude Code's `/plugin`, reload plugins and start a fresh conversation as needed. An exhausted Claude allowance can prevent a command completing even when it appears in the menu; a plugin update does not reset that provider limit.

## Settings that live in DevSpec

How Claude branches, commits, tests, and merges is controlled per project in DevSpec (**Project Settings → Agents**), so it stays consistent whether you work one item by hand or a batch you were asked to take:

| Setting | Controls |
|---|---|
| Auto-push / Auto-merge | Whether branches are pushed, and merged into the target branch |
| Target branch (per repo) | The branch Claude's work lands on |
| Branch / commit prefixes | How Claude names branches and commits |
| Agent rules | The execution mechanics Claude follows — including what it runs to check a change before pushing |
| Protected paths | Files and folders Claude must not touch |
| Custom instructions | Extra project rules Claude follows |

## What it will and won't do

- Changes are made on an **isolated branch** — your working checkout stays clean.
- It **never force-pushes**, and it respects the protected paths you set.
- **Work that would undo someone else's decision waits for their OK.** Claude can still build it, on its own branch, but it does not merge it until the OK is given, and it tells you who it is waiting for. The same goes for an item marked as an experiment. Who can give the OK is decided by DevSpec.
- **It tells you what DevSpec finds about its work** — for example that a change would undo a decision, duplicates other work, or left a description out of date — while it is connected to DevSpec.
- It tells DevSpec which plugin it is and which version, on every call. That only identifies it; it grants nothing.
- **Claude records the work; it never signs it off.** What happens after that — whether the task's own checks settle it, or a person has to verify it — is decided by DevSpec, the same way for every tool.
- It won't stall on a question nobody may be reading: a task too ambiguous to do safely is failed with a reason, not guessed at.
- Commits it makes for a tracked task carry a small `[devspec:…]` tag so DevSpec can link the commit — and later the deployment — back to the task.

## Troubleshooting

| Problem | Fix |
|---|---|
| Commands don't appear in `/` | Reinstall with `/plugin install devspec@devspec`, then `/reload-plugins` |
| Plugin won't load, or hook errors | Update to the latest version (`git pull` for local installs) and `/reload-plugins` |
| Never asked for a token, or need to change it | Run `/plugin` → **Installed** → **DevSpec**, press Enter, and enter/update your `dvs_…` token there (the prompt fires when you *enable* the plugin) |
| Connection check fails | Confirm your token has `read_write` scope; regenerate it on the [Agents page in your DevSpec settings](https://app.devspec.ai/settings/agents), then re-enter it via `/plugin` → **Installed** → **DevSpec** |
| Remote control won't start / `node: command not found` | Install [Node.js 18+](https://nodejs.org) and make sure `node` is on your `PATH` |
| "No matching project" | Make sure the repo is tracked in DevSpec, or add a `.devspec/project.json` pin naming the project |
| A batch you asked for isn't being worked | Nothing routes work — an agent only holds what it reserved. Check the Agents page: it shows which agents are connected and what each is holding, so an unheld item means nobody was asked, not that delivery failed |
| "Claim failed" in a batch | Another connection claimed that task first — this is normal; the batch continues |

## Contributing

The plugin is Markdown commands and skills plus a few dependency-free Node scripts — no build step. See [DEVELOPMENT.md](./DEVELOPMENT.md) for how it's structured, how to run the tests, and how to develop against a non-production DevSpec instance. Release notes are in [CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE)
