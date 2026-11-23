---
name: devspec.login
description: Sign Claude Code in to DevSpec through your browser. Add --code on a remote machine where a browser cannot open locally (over SSH that happens by itself).
argument-hint: "[--code]"
allowed-tools: Bash
---

# Sign in to DevSpec

Signs in to the DevSpec server the plugin is set to (production unless the plugin's DevSpec server setting says otherwise). One sign-in serves Claude Code's own DevSpec tools, remote control and commit tracking.

1. **Start it.** Run exactly this, adding `--code` only if the person typed it:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/devspec-login.mjs" login
   ```

   It returns straight away. Show the person what it printed, word for word, **including the link** — a browser may not have opened. If it exited non-zero, that output is the whole answer: relay it and stop. Never work around it (for example by setting `DEVSPEC_MCP_TOKEN`).

2. **If it asked them to approve in the browser**, run this with the Bash tool's `timeout` set to `600000`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/devspec-login.mjs" login --wait
   ```

   Relay the line it prints, exactly. If it says it is still waiting, offer to run `--wait` again.

3. **If it asked them to copy a code**, stop and ask them to paste the code the DevSpec page shows. When they do, run it in single quotes, exactly as pasted:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/devspec-login.mjs" login --complete '<code>'
   ```

   A real code contains no quote marks or spaces; if what they pasted does, ask again rather than running it. Relay the line it prints, exactly.

Never print, read or copy the sign-in file (`~/.devspec/claude-code/auth.json`) or any token.
