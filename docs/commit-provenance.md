# Commit provenance in Claude Code — capability table

Implements the Claude Code share of [ADR `71c23b46`] ("Git artifacts are authoritative
for provenance; edit-time tracking is advisory") under brief `e3d3b54f`, item
`e21d7d4b`. Memory `26aab381` supersedes `5181f5dd`.

The point of a capability table is to stop a plugin claiming enforcement it cannot
deliver. Each row below says what Claude Code *actually* exposes, what this plugin
therefore does, and — where the answer is "nothing" — what covers the gap instead.
Nothing here is ported from another host; Pi, Cursor, Grok, OpenCode, Codex and
Antigravity each answer these rows for themselves.

## What Claude Code exposes, and what we do with it

| Surface | Claude capability | What this plugin does | Gap covered by |
|---|---|---|---|
| **Edit events** (`Write`, `Edit`, `NotebookEdit`) | `PreToolUse` fires with the target path before the write | **Never denies.** Emits at most one `systemMessage` reminder per session+repository when no claim is held | — |
| **Arbitrary execution** (`Bash`) | `PreToolUse` fires with the raw command string | **Never denies** for lack of a claim. No allowlist, no tokenizer over arbitrary commands, no path rules | — |
| **Commit message inspection** | The command string is visible, but only *a string* — Claude has no first-class commit event | Reads the message only from the narrow unambiguous `git commit … -m <quoted>` shape (`simpleGitCommit`). Every other shape is allowed untouched | Server-side commit ingestion + unlinked-commit analyzer |
| **Commit message transformation** | **Yes** — `hookSpecificOutput.updatedInput` is honoured for `PreToolUse` (verified in 2.1.235; Claude logs "modified tool input keys") | Appends `[devspec:<uuid>]` inside the quoted message when exactly one claim is active, and reports it via `systemMessage` | — |
| **Push observation** | `PreToolUse` on the `git push` command string | **Recognised but never blocked.** No safe non-destructive recovery for already-created commits is implemented, and the ADR forbids blocking without one | Analyzer |
| **Project association** | No association event of its own; `/devspec.remote` resolves the project and *offers* to write `.devspec/project.json` | Jurisdiction requires a positive local marker (pin, or a project-scoped config registering DevSpec), searched cwd→repo root and at the repository's main working tree. The hook itself writes nothing | Ingestion never depends on a pin |
| **Offline / server error** | n/a — the hook makes no network call | Reference checking is **local shape only**. There is no commit-time round trip to fail, so offline work is unaffected | Server-side linkage catches a well-formed-but-wrong uuid |
| **Feedback continuation** | `permissionDecision: "deny"` blocks one tool call and returns the reason to the agent; it does not end the turn | Denials carry a complete recovery route (reuse or create the smallest item, add the reference, retry). No `terminate`/`continue`/`stopReason` field is ever emitted | — |
| **Installed testing** | Hooks are plain commands over stdin/stdout, so the manifest can be executed directly | `commit-provenance.test.mjs` runs the real manifest command with real payloads, not just imported helpers | — |

## When a commit is denied — the whole list

Only two cases, and both are certain:

1. The message has **no** `[devspec:<full-uuid>]` reference **and** no single active claim
   to stamp from.
2. The message has no reference, exactly the ambiguity of **several** active claims
   exists, and guessing between them is forbidden.

Everything else allows, including: a reference already present (any item, claimed or
not), a shape we cannot read, no jurisdiction, unreadable claim state, malformed hook
input, a crashed hook, and a missing Node runtime.

## Two deliberate holes

**A well-formed reference is not verified to exist.** `[devspec:<uuid>]` is checked for
shape, not against the server. A correct short code with a wrong uuid suffix therefore
passes — the exact failure that reached shared `staging` once. Validating it would put a
network call and an auth dependency in front of every commit for a case the server
already resolves through `record_implementation` linkage and the analyzer. The ADR makes
online validation optional; this host declines it.

**An unquoted message cannot be stamped.** `git commit -m bare` gets a denial rather
than a stamp, because appending ` [devspec:…]` to an unquoted word would make the
reference a separate argument and git would read it as a pathspec. Corrupting the
command would be worse than asking.

## What this replaced

`claim-guard.mjs` is deleted, not disabled. With it goes the shell tokenizer, the
read-only command allowlist, redirect classification, `$`-expansion rules, the
non-product write-path exceptions, the control-plane script allowance (nothing needs
allowing when nothing is denied), and the claim-scoped repository permission model.

The historical items that built it — `cdd7a494`, `dfa86f3f`, `4910e673`, `730bf485` —
remain valid evidence of what was true then. This supersedes their enforcement
architecture; it does not rewrite their past.

## What this is not

This is cooperative provenance assistance. A user can uninstall the plugin, commit from
a GUI, use another agent, or pass `--no-verify`. It is not a security boundary and must
never be described as one. Claude's own permission system, authentication,
authorization, cost confirmation, destructive-database safeguards, deployment safety and
host sandboxing are independent and unchanged by this work.

[ADR `71c23b46`]: devspec://resource/71c23b46
