# Changelog

All notable changes to this plugin are documented here. This project follows [Semantic Versioning](https://semver.org).

## Unreleased

- **Remote control reads the room on connect:** `/devspec.remote` now tells the connected agent to **read the session transcript for context** on connect/attach (not just seed a cursor) and resolve context-dependent first instructions ("help with all this", "carry on", "the thing we discussed") against it before asking the owner to re-explain — so the agent arrives oriented instead of blind. Advisory history (in-session AI, teammates) is readable context for comprehension, never a command surface; command authority is unchanged.
- **Remote dispatch — work a dispatched assignment:** `/devspec.remote` now runs the DevSpec assignment protocol when an owner dispatch carries an assignment reference — `get_assignment` → `acknowledge_assignment` → `claim_work_item` (each reserved member, in order; a claim reserved for someone else is a non-fatal skip) → implement + `record_implementation` → `resolve_assignment`. The command's allow-list gains the assignment + work-execution tools, and the autopilot skill gains the three assignment tools for staged-batch routing.
- **Agent-authoritative remote-control "working" state:** the connected agent now reports `busy:true` on turn start (plus a turn marker) and `busy:false` on turn end/interrupt; the long-lived poller re-asserts busy while a turn runs so long turns stay "working" and an interrupted turn decays instead of stranding a phantom "working". Poller backoff gains a `dormant` (~hourly) tier and the idle-disconnect lifetime extends from 24h to 72h.
- Renamed the GitHub repository to [`DevSpecAI/devspec-claude-plugin`](https://github.com/DevSpecAI/devspec-claude-plugin) (was `claude-code-devspec-autopilot`).
- Renamed the plugin id to `devspec` and the marketplace id to `devspec` (was `devspec-autopilot` / `devspec-autopilot-marketplace`). Slash commands are now `/devspec:<command>`. Existing installs migrate via marketplace `renames` (`devspec-autopilot` → `devspec`); re-add the marketplace if your local catalog still uses the old name.
- Install: `/plugin marketplace add DevSpecAI/devspec-claude-plugin` then `/plugin install devspec@devspec`.
- Rewrote `README.md` for the full product surface (MCP token setup, interactive work, Agents remote control, autopilot) instead of an autopilot-only pitch.

## 0.5.0 - 2026-07-13

Zero-config MCP setup and production cleanup.

- **Auto-wire the DevSpec MCP server.** The plugin now declares the `devspec` MCP server in its manifest (`https://devspec.ai/api/mcp`) and prompts for **only your API token** via `userConfig` (`sensitive`, stored in the OS keychain) on enable. No more hand-editing `.mcp.json`. A `devspec` server you define yourself still takes precedence, so staging/self-host overrides keep working.
- Remote-control token resolution now also reads the keychain token (`CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN`) as a lowest-priority fallback, so the poller/hooks authenticate for marketplace-installed users.
- Turn-mirroring hooks are guarded with `command -v node` — a session without Node.js is a silent no-op instead of a per-turn hook error.
- `/devspec.remote` now runs a `node --version` preflight with clear install guidance (incl. the native-installer caveat).
- Removed the unused v1 autopilot engine and npm scaffolding (`src/`, `dist/`, `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`) and stale template files (`examples/`, scheduler icon). The plugin is Markdown skills/commands + dependency-free Node hook scripts — no build step. Tests run with `node --test hooks/scripts/*.test.mjs`.

## 0.4.1 - 2026-07-13

Marketplace-readiness pass.

- Aligned the version across `plugin.json`, `.claude-plugin/marketplace.json`, and `package.json` (previously drifted).
- Added `displayName`, `homepage`, and `repository` to the plugin manifest.
- Rewrote the README: production MCP URL (`https://devspec.ai/api/mcp`), full command list with correct `/devspec-autopilot:<command>` namespacing, accurate project structure, and clearer Node.js prerequisites.

## 0.4.x - remote control

- Added `/devspec.remote` and `/devspec.remote-stop` for DevSpec Agents-page remote control.
- Conversation-scoped remote bonds; long-lived poller that keeps heartbeating through owner instructions.
- Mechanical turn mirroring via `Stop` / `UserPromptSubmit` hooks.

## 0.2.x - initial autopilot

- Autopilot polling loop: claim staged action items, implement in isolated worktrees, test, push/merge, and report back to DevSpec.
- Planning mode ("Request Agent Plan").
- Terminal companions: `/devspec.work`, `/devspec.create`, `/devspec.commit`, `/devspec.link`, `/devspec.done`, `/devspec.help`.
