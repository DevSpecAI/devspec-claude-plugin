---
name: autopilot-stop
description: Stop the DevSpec autopilot polling loop after the current cycle completes
---

# Stop DevSpec Autopilot

Stop the autopilot polling loop. If an action item is currently being processed, wait for it to finish before stopping. Do not interrupt mid-execution.

Output the stop banner with session stats:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ◆  DEVSPEC AUTOPILOT  ▸  STOPPED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Ran {N} cycles · {completed} completed · {failed} failed · {planned} planned
  Uptime: {duration}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Include the tracked state values (cycles_run, items_completed, items_failed, items_planned) from the running session.
