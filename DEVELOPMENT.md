# Development

Maintainer notes for the DevSpec Claude Code plugin (`devspec`). End users don't need any of this — see `README.md`.

## What the plugin actually is

Markdown skills/commands + a manifest + a handful of Node hook scripts. **There is no build step and no bundled binary.**

- `.claude-plugin/plugin.json` — manifest (name, version, `userConfig`, `mcpServers`, component paths). This is the source of truth for the version.
- `commands/*.md`, `skills/*/SKILL.md` — the slash commands and skills.
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

The plugin bakes the production MCP endpoint (`https://devspec.ai/api/mcp`) into `plugin.json`. To develop against staging, override that server **once at user home** so every folder dogfoods staging — including repos that have no project `.mcp.json` (ColdTrace). Do not copy a project `.mcp.json` into each repo.

Put the block in `~/.claude.json`, or run `claude mcp add` at **user** scope:

```bash
claude mcp add --scope user --transport http devspec https://staging.devspec.ai/api/mcp \
  --header "Authorization: Bearer dvs_your_staging_token"
```

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

A project `.mcp.json` is still a valid **local** override (the hook scripts prefer it when present). It is not the default for staging dogfood.

Token/endpoint resolution order used by the hook scripts (`hooks/scripts/resolve-mcp-auth.mjs`):

1. `DEVSPEC_MCP_TOKEN` / `DEVSPEC_TOKEN` (+ `DEVSPEC_MCP_URL`)
2. Project `.mcp.json` (cwd and parents) — optional local override
3. `~/.claude.json` matching entries — **use this for staging**
4. `CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN` (the `userConfig` token from the keychain)

Keep the plugin installed from the marketplace. A user-defined `devspec` server of the same name overrides the plugin's baked-in production URL. (Claude Code may still prompt for the `userConfig` token when you enable the plugin even though the override makes it unused — enter anything, or your staging token.)
