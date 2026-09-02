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

Set the plugin's **DevSpec server** field to staging. That is the whole thing:

```
https://staging.devspec.ai/api/mcp
```

`plugin.json` declares the server as `"url": "${user_config.devspec_mcp_url}"`, defaulting
to `https://devspec.ai/api/mcp`. Point that field at staging and the plugin's own
`devspec` server goes to staging — and so do the hook scripts and the poller, because
Claude Code exports the field to subprocesses as `CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL`
and `resolve-mcp-auth.mjs` pairs it with the plugin token. One server, one host, nothing
to keep in sync.

Set the token field to a staging token at the same time. Token and URL always travel as a
pair (item `8bb707fd`); a production token against staging will not own the connection.

### Do not add a second `devspec` server to get staging

A user- or project-defined server named `devspec` does **not** replace the plugin's.
Claude Code namespaces plugin servers, so you end up running both:

```
plugin:devspec:devspec: https://devspec.ai/api/mcp          ✘ Failed to connect
devspec:                https://staging.devspec.ai/api/mcp  ✔ Connected
```

Check with `claude mcp list`. The hook scripts do prefer your own entry, so the *tools*
work — which is why this looked fine for months — but the plugin's server stays
registered and stays red for as long as production is not serving. That is noise you
cannot clear, and it hides the one failure a fresh customer install actually hits.

A project `.mcp.json` is still a legitimate local override for a one-off endpoint. It is
not the way to dogfood staging, and it should not be committed — it carries a live
account-wide token.

### Resolution order used by the hook scripts

`hooks/scripts/resolve-mcp-auth.mjs`, first token pair wins. Each source supplies its own
token **and** its own URL; the two are never mixed.

1. `DEVSPEC_MCP_TOKEN` / `DEVSPEC_TOKEN` (+ `DEVSPEC_MCP_URL`) — explicit override
2. The host token, paired with the URL of whichever source it came from
3. Project `.mcp.json` (cwd and parents)
4. `~/.claude.json` entries matching the cwd
5. `~/.claude.json` top-level
6. `CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN` + `CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL` — the
   plugin's own configured pair
