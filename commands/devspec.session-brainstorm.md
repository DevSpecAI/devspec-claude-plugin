---
name: devspec.session-brainstorm
description: Continue a DevSpec chat session locally — either post a one-shot answer back into the session, or brainstorm interactively with the user first and post the agreed conclusion. Invoked by the DevSpec "Continue in Local Agent" handoff.
argument-hint: "mode=<answer|brainstorm> session_id=<uuid> [free-text topic]"
allowed-tools: Read, Grep, Glob, Bash, Agent, mcp__devspec__get_session_transcript, mcp__devspec__post_session_message, mcp__devspec__search_memories, mcp__devspec__search_index, mcp__devspec__read_file
---

# DevSpec Session Brainstorm

A DevSpec web chat session has been handed off to you locally. Load the conversation, then either **answer** it in one shot or **brainstorm** it interactively — and surface the result back into the session the user is watching, via `post_session_message`.

This command is normally launched by the "Continue in Local Agent" button in the DevSpec chat composer, which passes a `mode` and a `session_id`. It also works when a user types it directly.

## Steps

1. **Parse `$ARGUMENTS`.** Extract three values and store them in working memory:
   - `mode` — from `mode=<value>`. Accept `answer` or `brainstorm`. If the word `brainstorm` (or `interactive`) appears anywhere and no explicit `mode=` is given, treat it as `brainstorm`. **Default: `answer`.**
   - `session_id` — the session UUID, from `session_id=<uuid>` or the first UUID-shaped token in the input. **CRITICAL:** store the **complete UUID** exactly as given (e.g. `e681f85a-bc99-43a3-97fd-7c9c3a57e875`). Never truncate, pad, or reconstruct it — every `post_session_message` call must use this exact string.
   - `topic` — any remaining free text (what the user was thinking about). Optional.
   - If no `session_id` can be found, output `✗ No session_id provided — cannot continue a session.` and stop.

2. **Announce locally (terminal indication).** Immediately print this header so it is obvious a DevSpec session is running:
   ```
   ━━━ DevSpec Session ━━━
   Session:  {first 8 chars of session_id}  (display only — full UUID stored in working memory)
   Mode:     {answer | brainstorm}
   ────────────────────────
   {topic or "No topic provided — see transcript"}
   ━━━━━━━━━━━━━━━━━━━━━━━━
   ```

3. **Signal the web session (web indication).** Right away — before doing any investigation — call
   `post_session_message(session_id: <session_id>, message: "🖥️ **Local agent connected** — reading the session and investigating the codebase…")`.
   This is what tells the user in the browser that the handoff worked and you are now working. Do this in **both** modes.

4. **Load the conversation.** Call `get_session_transcript(session_id: <session_id>)` to load what has been discussed so far. Skim it and the `topic` to understand what the user actually wants.

5. **Branch on `mode`:**

   ### mode = answer  (one-shot)
   - Investigate here in this repository — read the relevant code (`Read`/`Grep`/`Glob`, `search_index`, `search_memories`, run read-only commands as needed) to ground your answer in the real codebase.
   - When you have findings, post them back **once**:
     `post_session_message(session_id: <session_id>, message: <your findings as markdown>)`.
   - Use clear markdown — a short summary line, then specifics (files, `code`, bullet lists). Do **not** create an action item or a comment; post directly to the session.
   - Then output a local confirmation and **stop** (see Output).

   ### mode = brainstorm  (interactive)
   - Do **not** post conclusions yet. Brainstorm *with the user, here in the terminal*, grounded in the transcript and the code.
   - Investigate enough to ask sharp questions, then ask in **rounds of up to 5**, drawn from this taxonomy (pick the biggest gaps first):
     - **Scope & Intent** — core problem, who benefits, what's out of scope
     - **Approach & Alternatives** — strategies, tradeoffs, existing patterns to follow/avoid
     - **Data & State** — data changes, migrations, new entities, side effects
     - **Edge Cases & Failure Modes** — invalid input, concurrency, rate limits, timeouts
     - **Dependencies & Integration** — other systems/APIs/action items, downstream breakage
     - **Acceptance & Verification** — definition of done, what a tester checks, logs/metrics
   - For each question: analyze the code/transcript, propose a recommended answer, then ask. Format:
     `**Suggested:** <proposal> — <1-sentence reasoning>` then `Agree, adjust, or give your own answer.`
     Accept on "yes"/"agree"/"suggested"; "skip" moves on. Record each accepted answer in working memory.
   - **After each round:** if all high-impact areas are covered, say `All key areas covered — ready to post the summary.` Otherwise ask `Continue brainstorming? (y/n)`.
   - **Early exit:** on "done"/"good"/"that's it"/"stop", end the loop immediately.
   - When the loop ends, compile a structured summary:
     ```markdown
     ## Brainstorm Summary
     **Scope:** <1-2 sentences>
     **Approach:** <chosen strategy + key tradeoffs>
     **Edge Cases:** <bullet list>
     **Acceptance Criteria:** <bullet list of verifiable conditions>
     **Open Questions:** <anything unresolved, if any>
     ```
   - Show it in the terminal, then ask: `Post this summary back to the DevSpec session? (y/n)`
     - If **yes**: `post_session_message(session_id: <session_id>, message: <the summary>)`.
     - If **no**: do not post; tell the user the summary is above if they want it later.
   - Then output a local confirmation and stop (see Output).

## Output

On success, print:
```
✓ Posted to DevSpec session
  Session:  {first 8 chars of session_id}
  Mode:     {answer | brainstorm}
```
If in brainstorm mode the user declined to post, replace the first line with `↻ Not posted — summary is above if you need it later.`

## Rules

- Post the "Local agent connected" signal (step 3) **before** investigating, in both modes — it is the user's only indication the handoff worked.
- In **brainstorm** mode, never post a conclusion to the session until the user has finished brainstorming and agreed to post. In **answer** mode, post exactly one findings message.
- Always use the full `session_id` UUID stored in step 1 — never reconstruct or pad it.
- Ground everything in the actual transcript and codebase — no generic advice.
- Do NOT create action items or comments; this command posts into the live session only.
- Keep terminal output tight — no filler before or after the structured blocks.
