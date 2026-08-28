---
name: devspec-session-poll
description: Open a shared poll in a DevSpec session when the room genuinely has a choice to make between concrete options, and read the result. Not for asking one person a question, and not for decisions you can make yourself.
allowed-tools: Bash, mcp__devspec__manage_poll
---

# Session polls

A poll asks the ROOM to choose between options. Use it when a real fork exists, the
options are concrete, and more than one person's view matters. Anything the recorded
intent, the acceptance criteria or the served contracts already settle is yours to get on
with — and if one specific person needs to decide, ask them directly instead
(`devspec-directed-question`), because a poll waits on nobody in particular.

**A poll never blocks you.** Creating, updating or ending one holds no turn, opens no
reply channel, and leaves the room's Working state exactly as it was. There is no vote
action either: voting is something people do in the UI. `recommendation_index` records
which option YOU would pick — it is advice, and it is not a ballot.

## Claude Code access

Remote connect negotiates a hidden, connection-bound capability. Never ask for, print,
copy or pass that value. Reach the tool through the capability-safe bridge:

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/devspec-poll.mjs" describe --connection-id '<connection_id>'
node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/devspec-poll.mjs" use --connection-id '<connection_id>' --input '<manage_poll JSON>'
```

`describe` returns the server's current schema — read it rather than trusting this file
for argument shapes. `use` can call only `manage_poll`; pump verbs are not exposed. Your
identity, session and project are server-derived and are not arguments you can supply.

## Operations

- `create`: a question, 2–30 concrete options, and a fresh UUID `client_request_id`
  (reusing one retries that same poll rather than opening a second). `multi_select` and
  `allow_write_in` widen what voters may do; `series_id` groups related polls and then
  needs a `series_label`.
- `list` / `get`: reads, optionally filtered by `status`.
- `update` / `end` / `retract` / `supersede`: every one needs `poll_id` and the current
  `expected_revision`, so read before you write. `retract` needs a reason, and
  `supersede` needs its own `client_request_id`.
- End a poll explicitly once its answer has been acted on. Leaving a decided poll open
  invites votes on something already settled.
