/**
 * Automatic conversational recall at the turn's tail (item 08f036e5; host delivery
 * contract 7c87f509; decision 3ea02bd2).
 *
 * On `prompt.submit`, before the prompt enters, scripts/turn-recall.mjs asks DevSpec
 * which of the project's records bear on it and hands back DevSpec's own block of
 * cards, which this adds as the prompt's `context`: one block after the prompt, never
 * shown to the person, at the turn's tail, so nothing earlier in the conversation
 * changes and the provider's prompt cache keeps working. The script decides which
 * prompts recall, from Claude Code's own stamp of where each came from (`e.origin`):
 * a person's prompt and a DevSpec command do; a /loop firing, another session's
 * message, a check job or notice never do.
 *
 * It runs beside the room's copy of the prompt (local-prompt.ts) rather than after
 * it, so a connected conversation waits for the slower of the two, not both. Neither
 * ever holds the prompt back: each fails on its own and the prompt enters regardless.
 * The script gives up by itself at 3 s; the process limit here is only a backstop.
 *
 * Prompts the script would skip on their text alone (empty, a slash command, shorter
 * than 18 characters) start no process. The UserPromptSubmit command hook skips the
 * same prompts, which is what keeps it from recalling them on a build with this module.
 *
 * A plugin has exactly one hooks module, so terminal-status.ts registers this.
 */
import type { Hook, Register } from 'claude-code'

import { mirrorPrompt } from './local-prompt'

/** scripts/turn-recall.mjs MIN_PROMPT_CHARS. */
const MIN_PROMPT_CHARS = 18
/** Above the script's own 3 s exit, so the script, not this, decides when to give up. */
const RECALL_PROCESS_TIMEOUT_MS = 3_500

type Hooks = Parameters<Register>[0]
type Api = Parameters<Hook<'prompt.submit'>>[0]
type Submitted = Parameters<Hook<'prompt.submit'>>[1]

export function worthARecallProcess(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length >= MIN_PROMPT_CHARS && !trimmed.startsWith('/')
}

/** DevSpec's recall block for this prompt, or null. Never throws. */
export async function recallBlock($: Api, e: Submitted): Promise<string | null> {
  if (!worthARecallProcess(e.text)) return null
  try {
    const conversationId = await $.session.id()
    const ran = await $.process.run(['node', `${$.plugin.root}/hooks/scripts/turn-recall.mjs`, 'prompt-submit'], {
      stdin: JSON.stringify({ conversation_id: conversationId, text: e.text, origin: e.origin?.kind ?? null }),
      timeoutMs: RECALL_PROCESS_TIMEOUT_MS,
    })
    if (ran.exitCode !== 0) return null
    const out = JSON.parse(ran.stdout.trim() || '{}') as { context?: unknown }
    return typeof out.context === 'string' && out.context.trim() ? out.context : null
  } catch {
    return null
  }
}

export function mirrorAndRecallPrompts(on: Hooks): void {
  on('prompt.submit', async ($, e, next) => {
    const [, block] = await Promise.all([mirrorPrompt($, e), recallBlock($, e)])
    return next(block ? { ...e, context: [...(e.context ?? []), block] } : e)
  })
}
