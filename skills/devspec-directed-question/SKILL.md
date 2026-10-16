---
name: devspec-directed-question
description: Ask the person driving this DevSpec session a question and wait for their answer, when a decision is genuinely theirs to make and no recorded intent settles it. Never for work you can do, check, or decide yourself.
allowed-tools: Bash
---

# Asking one person a question

Use this only for a decision that is genuinely theirs: an unresolved product choice, an
authority boundary, or a fork where two readings lead to materially different work.
Everything the recorded intent, acceptance criteria and served
`devspec://product/implementation-contract` already settle is yours to get on with, and
so is anything you could find out by looking. A question is not a way to hand judgement
work back — if you could observe the answer, observe it.

Ask only when someone is there to answer: the card sits above their composer
until they respond or cancel it.

## Ask

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/devspec-question.mjs" describe --connection-id '<connection_id>'
node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/devspec-question.mjs" use --connection-id '<connection_id>' \
  --input '{"action":"create","client_request_id":"<fresh uuid>","response_kind":"single_select",
            "prompt":"<the question>","options":["<choice>","<choice>"]}'
```

`describe` returns the server's current schema. `response_kind` is `text`,
`single_select` or `multi_select`; select kinds need at least two distinct choices, and
`allow_custom` defaults on, so they can answer in their own words; pass
`allow_custom: false` only when the choices must be strict. `client_request_id` is a
fresh UUID per question — reusing one retries that same question rather than asking a
new one. `list`, `get` and `cancel` reach only your own questions; cancel one that
events have overtaken rather than leaving it up.

**Asking ends Working.** The server closes the asking turn; do not poll or loop. Pass
`--keep-turn` (`keep_turn`) only if you still have work, or to ask independent choices for
one person together: on all but the last. Each answer arrives as its own event; hold a
question that depends on one until it does.

## When they answer

The wake stream hands you a `question_answer` event with their choice.

A `question_answer_queued` event is their answer reaching you while a turn of yours was
still open: informational, no `respond` yet, not a cue to abandon what you are doing.
The same answer returns as `question_answer` once the reply channel opens. It is the
mechanical response to your own question: it carries no new authority and widens
nothing. Carry on with the work it unblocks, then post your reply with:

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/devspec-question.mjs" respond --connection-id '<connection_id>' \
  --message '<your reply>'
```

That one call stores the reply and closes the turn their answer opened. Replying
through the ordinary session path instead leaves the room showing Working with nothing
working. `status` says whether a reply is still owed.

The transcript already records the question and the answer: reply with what you did or
concluded, not a receipt.

Delivery, leasing and completion authority are the served
`devspec://product/interaction-event-contract`. Nothing here overrides it, and asking a
question never becomes work evidence: it cannot stand in for `claim_work_item` or
`record_implementation`.

`question_dismissal` is no answer or authority. Use `respond` after delivery, not `_queued`. Never retarget or cancel on disconnect. See `devspec://product/question-dismissal-event-contract`.
