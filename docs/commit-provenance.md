# Commit provenance in Claude Code — capability table

Implements the Claude Code share of [ADR `71c23b46`] ("Git artifacts are authoritative
for provenance; edit-time tracking is advisory") under brief `e3d3b54f`, items
`e21d7d4b` and `6fa0241e`. Memory `26aab381` supersedes `5181f5dd`.

The point of a capability table is to stop a plugin claiming enforcement it cannot
deliver. Each row below says what Claude Code *actually* exposes, what this plugin
therefore does, and — where the answer is "nothing" — what covers the gap instead.
Nothing here is ported from another host; Pi, Cursor, Grok, OpenCode, Codex and
Antigravity each answer these rows for themselves.

## What Claude Code exposes, and what we do with it

| Surface | Claude capability | What this plugin does | Gap covered by |
|---|---|---|---|
| **Edit events** (`Write`, `Edit`, `NotebookEdit`) | `PreToolUse` fires with the target path before the write | **Never denies.** Emits at most one reminder per session+repository when no claim is held, on BOTH channels — `systemMessage` for the human at the terminal and `additionalContext` for the agent, which is the party that can act on it (and the only one present when the work is driven from a phone) | — |
| **Arbitrary execution** (`Bash`) | `PreToolUse` fires with the raw command string | **Never denies** for lack of a claim. No allowlist, no tokenizer over arbitrary commands, no path rules | — |
| **Commit message inspection** | The command string is visible, but only *a string* — Claude has no first-class commit event | Reads the message from two families of shape, and allows every other untouched. (1) The narrow unambiguous `git commit … -m <quoted>` form, optionally behind a single readable prefix — `cd <path> &&` or `git add <pathspec…> &&` — or a `git -C <path>` form (`simpleGitCommit`, `readablePrefix`). (2) The two multi-line forms whose message is a SINGLE-QUOTED heredoc, where the shell expands nothing and the text is exactly the bytes between the delimiter lines (`heredocGitCommit`): `-F -` with `<<'D'`, and `-m "$(cat <<'D' … D)"`. Family 2 exists because a commit message with a *body* cannot be written as one quoted argument, so before it every commit carrying real prose took the refusal path — measured at 59 of 59 unreferenced commits on one staging branch over 14 days (item `022e487b`). An unquoted delimiter, `<<-`, a second heredoc, a substitution that is not exactly `cat` of one heredoc, a backtick, or unexpected trailing text all still refuse. `-F <path>` is deliberately still refused: the only outcome would be a denial (a reference cannot be stamped into someone else's file by rewriting a command) and the file may be written by the very command being inspected | Server-side commit ingestion + unlinked-commit analyzer |
| **Commit message transformation** | **Yes** — `hookSpecificOutput.updatedInput` is honoured for `PreToolUse` (verified in 2.1.235; Claude logs "modified tool input keys") | Appends `[devspec:<uuid>]` when exactly one claim is active, and reports it via `systemMessage`. For a quoted `-m` that is inside the quotes; for a heredoc it is the end of the SUBJECT line, inside the heredoc body — never after the delimiter (outside the message) and never on the last body line (which is routinely a `Co-Authored-By:` trailer). The rewritten command is round-tripped through a real `git commit` in the test suite rather than trusted from offset arithmetic | — |
| **Push observation** | `PreToolUse` on the `git push` command string | **Recognised but never blocked.** No safe non-destructive recovery for already-created commits is implemented, and the ADR forbids blocking without one | Analyzer |
| **Project association** | No association event of its own; `/devspec.remote` resolves the project and *offers* to write `.devspec/project.json` | Jurisdiction requires a positive local marker (pin, or a project-scoped config registering DevSpec), searched cwd→repo root **and at the repository's main working tree** — jurisdiction is a property of the repository, not of the directory ([contract](devspec://product/implementation-contract) 4.1.0, `commit_provenance_contract.project_association`). Credentials and the connect-time pin lookup follow the same rule. The hook itself writes nothing | Ingestion never depends on a pin |
| **Reference existence** | No Claude surface — DevSpec's own `validate_commit_reference` | A reference that is present is confirmed to resolve in the project this folder belongs to, using the jurisdiction the folder already carries (a `.devspec/project.json` pin, `git remote get-url origin`). **Only a definitive `not_found` denies** | — |
| **Offline / server error** | n/a | The one call is bounded at 2.5s, a fifth of the hook's own 10s budget, and is made *only* when a reference is already present. Timeout, refused connection, DNS/TLS failure, HTTP or MCP error, an unresolvable project, an unparseable body and absent credentials are all "no answer", which allows. A commit with **no** reference makes no network call at all | Server-side linkage + analyzer still catch whatever was allowed |
| **Feedback continuation** | `permissionDecision: "deny"` blocks one tool call and returns the reason to the agent; it does not end the turn | Denials carry a complete recovery route (reuse or create the smallest item, add the reference, retry). No `terminate`/`continue`/`stopReason` field is ever emitted | — |
| **Installed testing** | Hooks are plain commands over stdin/stdout, so the manifest can be executed directly | `commit-provenance.test.mjs` runs the real manifest command with real payloads, not just imported helpers | — |

## When a commit is denied — the whole list

Three cases, and all three are certain:

1. The message has **no** `[devspec:<full-uuid>]` reference **and** no single active claim
   to stamp from.
2. The message has no reference, exactly the ambiguity of **several** active claims
   exists, and guessing between them is forbidden.
3. The message *has* a well-formed reference and the server answers, definitively, that
   it resolves to no item in this project.

Everything else allows, including: a reference the server confirms, a reference the
server could not answer for (for any reason at all), a shape we cannot read, no
jurisdiction, unreadable claim state, malformed hook input, a crashed hook, and a
missing Node runtime.

## Why `cd <path> &&` and `git -C <path>` are readable

They are the only two ways to commit into a worktree from Claude Code, because the
shell cwd resets on every Bash call — and the implementation contract *requires*
isolated work. Refusing them (as 0.16.0 did) left the check able to read only a bare
`git commit` in the session's own cwd, which isolated work never produces. The teeth
looked mechanical and never fired.

Reading past them stays honest for one reason: neither can author a commit or change
which verb runs. `cd` only moves; `-C` only names a directory and takes exactly one
value, so the verb's position remains known. A second separator, a prefix that is not
exactly `cd <one-path>`, or any other global option still refuses — and refusing still
means allow.

## Why the reference is confirmed, and why that cannot stop you

Shape is not existence. `[devspec:439fc6c0-…]` can be perfectly well formed and point at
nothing, and that is not a hypothetical: a correct short code with a wrong uuid tail
reached shared `staging` during this programme, caught only afterwards by the
authoritative link `record_implementation` wrote. Confirming it at commit time is the
last moment the mistake is free to fix, and `validate_commit_reference` — which did not
exist when 0.16.x declined this — answers exactly that question and no other.

The dependency it adds is real, so it is fenced:

- **Only a present reference triggers it.** No reference, no network — the unclaimed and
  offline paths are untouched, and the nudge, the stamp and the two local denials all
  work with the machine unplugged.
- **2.5 seconds, then the commit proceeds.** A fifth of the hook's own budget. No answer
  is not an answer.
- **Only `not_found` denies.** The contract names four outcomes, and `unavailable` and
  `indeterminate` "must never be collapsed into not-found". Every transport failure, HTTP
  status, MCP error, unresolvable project and unparseable body lands there, so the
  failure direction is unchanged: uncertainty allows.
- **The denial names the cause, not the rule** — a wrong uuid tail, or an item from
  another project — and is recoverable in place like the other two.

## One deliberate hole

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
