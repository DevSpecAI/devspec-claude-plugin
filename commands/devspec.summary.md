---
name: devspec.summary
description: Show a project overview from DevSpec
allowed-tools: mcp__devspec__get_project_summary
---

# DevSpec Summary

Show a high-level overview of the project state.

## Steps

1. Call `get_project_summary`.

2. Format as a structured panel:

   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     ◆  {project_name}
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     repos:          {N}
     indexed files:  {N}
     sessions:       {N}
     action items:   {N open} open · {N done} done

     autopilot:      {enabled/disabled}
     auto-push:      {on/off}
     auto-merge:     {on/off}
     poll interval:  {N}s
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ```

## Rules

- Do NOT output filler text before or after the panel
- Use `on`/`off` for boolean settings
- If autopilot settings are not available, show `autopilot: not configured`
