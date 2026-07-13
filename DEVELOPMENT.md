# Development

Maintainer notes for the DevSpec Autopilot plugin. End users don't need any of this — see `README.md`.

## What the plugin actually is

Markdown skills/commands + a manifest + a handful of Node hook scripts. **There is no build step and no bundled binary.**

- `.claude-plugin/plugin.json` — manifest (name, version, `userConfig`, `mcpServers`, component paths). This is the source of truth for the version.
- `commands/*.md`, `skills/*/SKILL.md` — the slash commands and the autopilot skill.
- `hooks/scripts/*.mjs` — the remote-control poller and turn-mirroring hooks. **They import only Node built-ins** — no npm dependencies, so nothing to install.

Keep it that way: don't reintroduce a `package.json`/build pipeline or npm dependencies in the hook scripts.

## Requirements

- **Node.js 18+** on your PATH (`node --version`). Required at runtime for the hooks/poller.

## Running the tests

```bash
node --test hooks/scripts/*.test.mjs
```

## Validating before release

```bash
claude plugin validate . --strict
```

## Bumping the version

Update **both**:
- `.claude-plugin/plugin.json` → `version`
- `.claude-plugin/marketplace.json` → `plugins[0].version`

Keep them in lockstep and record the change in `CHANGELOG.md`.

## Local dev against staging (or any non-prod endpoint)

The plugin bakes the production MCP endpoint (`https://devspec.ai/api/mcp`) into `plugin.json`. To develop against staging, **define your own `devspec` MCP server** in your project's `.mcp.json` (or `~/.claude.json`) — a user-defined server of the same name completely overrides the plugin's, and it's also what the hook scripts resolve first:

```json
{
  "mcpServers": {
    "devspec": {
      "type": "http",
      "url": "https://staging.devspec.ai/api/mcp",
      "headers": { "Authorization": "Bearer dvs_your_staging_token" }
    }
  }
}
```

Token/endpoint resolution order used by the hook scripts (`hooks/scripts/resolve-mcp-auth.mjs`):

1. `DEVSPEC_MCP_TOKEN` / `DEVSPEC_TOKEN` (+ `DEVSPEC_MCP_URL`)
2. Project `.mcp.json` (cwd and parents)
3. `~/.claude.json` matching entries
4. `CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN` (the `userConfig` token from the keychain) — lowest priority, so your local `.mcp.json` always wins.

Because your `.mcp.json` wins, you can keep the plugin installed from the local marketplace and still hit staging. (Claude Code may still prompt for the `userConfig` token when you enable the plugin even though the override makes it unused — enter anything, or your staging token.)
