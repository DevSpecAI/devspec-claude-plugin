---
name: devspec.logout
description: Sign Claude Code out of DevSpec on this computer, for the DevSpec server the plugin is set to. Staging and production sign-ins are separate; the other one stays.
allowed-tools: Bash
---

# Sign out of DevSpec

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/devspec-login.mjs" logout
```

Relay what it prints, exactly. To see how this computer is signed in instead, run the same script with `status`.
