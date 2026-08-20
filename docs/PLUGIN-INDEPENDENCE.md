# The DevSpec plugins are independent implementations

**Direction (owner-set 2026-07-31, restated 2026-08-03): no file crosses a repo
boundary.** There is no canonical plugin, no sync tool, no file tiers, and no porting
step. Each plugin repo owns 100% of its own scripts.

This replaces the earlier hook-sync model, which made this repo canonical and copied
`hooks/scripts/` outward. That produced a recurring cycle — fix one host, port the fix,
break a second host, port *that* fix, introduce a third bug — and the churn cost more
than the duplication it was avoiding. The families are stable now precisely because they
are allowed to differ.

**If two plugins need the same fix, apply it twice, by hand, deliberately.** That is not a
failure to automate; it is the design. A hand-applied fix is reviewed against the host it
lands on. A synced fix is reviewed against one host and inflicted on four.

Do not reintroduce a sync script, a drift-report CI job, or a shared npm package for these
files. And do not change the DevSpec monorepo to fix one plugin's problem unless the
intent is genuinely a new shared capability — a server change made to satisfy one host is
the same tug-of-war wearing a different hat.

## What is shared — and it is never a file

Everything shared lives **on the DevSpec side**, as a contract:

- the **MCP tool contract** — `register_connection`, `poll_connection`,
  `post_session_message`, the separate `claim_playbook_run` path, and
  conversation-requested `reserve_work_items` then `claim_work_item`
- the **remote-ingress contract** — `devspec://product/remote-ingress-contract` —
  including server-only owner/delegated exact-target authority, immutable requester
  provenance and typed controls, plus each host's durable inbox and byte-offset cursor
  implementation
- the **implementation contract** — `devspec://product/implementation-contract` —
  which governs action-item acquisition and execution; connection availability never
  assigns action-item work
- the **delivery contract** — the agent posts answers; Stop does **not** full-mirror
  assistant text (monorepo `docs/REMOTE-CONTROL-DELIVERY-CONTRACT.md`, ADR `b98a39a9`).
  Nothing here may re-introduce dual-writer full-turn Stop mirroring.
- the **behaviour a connection must exhibit** — appear on the Agents page, accept
  exactly addressed canonical commands and separately typed owner-scoped playbook runs,
  never act on advisory context, and report honestly when it cannot hear

A plugin satisfies that contract however its host makes sense. The wake mechanism, the
turn-lifecycle hooks, the token location and conversation-id resolution are properties of
the **host**, and they are expected to differ.

## Identity is per-plugin, and pinned by a test

The agent name is a fixed property of the plugin. It lives in one place —
`hooks/scripts/agent-identity.mjs`:

```js
export const AGENT_NAME = 'Claude Code'
```

Every script imports `AGENT_NAME` and uses it unconditionally — never a
`state.agent_name || '<literal>'` fallback, never an `--agent` default, and never a
second per-plugin literal hardcoded somewhere else. That is what stopped this plugin
from registering as "Grok Build" (item `f99bc20b`).

This used to be guaranteed by generating the file from a central config. It is now
guaranteed by `hooks/scripts/agent-identity.test.mjs`, which asserts this repo's own
name — same guarantee, no cross-repo copying.

**A per-plugin value belongs in this module, or in a test-pinned constant beside the code
that uses it.** Item `85e626a9` is the cautionary case: it hardcoded a per-plugin
`provider:` string into `devspec-remote-poll.mjs` — correct in each repo, but at the time
that file was still being copied from this one, so the next sync run would have silently
rewritten Cursor's and Grok's to `claude_code`. Deleting the sync removed the hazard;
keeping per-plugin values discoverable is what stops it recurring.

## Why the wake channel is the clearest example

How you wake a model is the most host-specific thing in the whole plugin, and treating it
as universal is what produced item `be0a929a`:

- **Claude Code** reaps tracked background tasks at turn end. Exit-to-wake there ties the
  listener's lifetime to the *turn*: a perfectly compliant agent arms, gets reaped, is
  blocked by the Stop hook, re-arms, gets reaped — one model turn per lap, with no exit.
  Claude Code therefore arms `--stream` under a **persistent monitor**, where the wake is
  a stdout *line* and the arm is session-scoped.
- **Grok Build**'s monitor tool already turns every stdout line into a model-visible
  event — the same shape, arrived at independently.
- **Codex** is an app-server bridge with no local waker at all.

No single file is correct for all three. Syncing one would push Claude Code's default onto
hosts that cannot honour it, which is exactly the port-a-fix-break-another-host cycle this
direction ends.

## The plugin families

Families describe how a host achieves the contract. They are a description, not a
hierarchy — no family is canonical.

- **Local-poller** (Claude Code, Grok Build, Cursor, Antigravity): a long-lived local
  poller drives liveness and owner-message delivery; `mirror-turn.mjs` handles the turn
  lifecycle and heartbeats. They started from a common implementation and still resemble
  each other in places. That resemblance is history, not a constraint — a family member
  diverging is an expected outcome, never drift to be corrected.
- **Bridge** (Codex): remote turns are mediated by an app-server bridge. Its
  `mirror-turn.mjs` / `devspec-remote-poll.mjs` / `remote-control-state.mjs` implement a
  genuinely different model (thread-id bonds, `bridge_remote_turn_active`, remote-reply
  suppression, no local heartbeat).
- **In-process** (OpenCode): remote control is TypeScript inside the plugin
  (`src/remote-control.ts`), not a hook layer at all.

When a **shared concern** changes — a security fix in message-ownership filtering, the
idle-disconnect ladder, an MCP contract change — each affected repo gets the fix on its
own terms. Decide per repo whether it applies at all, and let the code read like the repo
it lives in.

## Adding a new plugin

1. Create the repo.
2. Write its scripts, for its host. Start from whichever existing plugin is closest if
   that helps — as a starting point, not as a link.
3. Add `agent-identity` with the plugin's name, and a test asserting it.
4. Commit. There is nothing to register and nothing to run.
