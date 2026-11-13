/**
 * Every prompt this conversation receives goes to scripts/mirror-turn.mjs, with where
 * Claude Code says it came from (item dd1a8325).
 *
 * The script opens the owner's own turn and shows the prompt in the room only when a
 * person submitted it. It used to run from the UserPromptSubmit command hook, which
 * cannot tell who that was: measured on Claude Code 2.1.291, a /loop firing reaches
 * that hook with the same fields and the same text as the prompt that was typed to
 * start the loop. So a scheduled wake-up appeared in the room as the owner's message.
 * `prompt.submit` carries the engine's own stamp (`e.origin`, a closed set:
 * `composer` for a prompt typed here, `scheduled-trigger` for that firing), and runs
 * before the turn starts, so the owner's turn is still admitted before the model
 * writes anything (item 718825fc).
 *
 * Awaited before the prompt enters, as the command hook was. A failure never holds the
 * prompt back: it enters regardless, unmirrored. A build without the function-hooks
 * API runs no module, and so mirrors no prompt.
 *
 * turn-recall.ts runs this beside the prompt's recall, in the one `prompt.submit` hook
 * the module registers: a plugin has exactly one hooks module, so terminal-status.ts
 * registers that.
 */
import type { Hook } from 'claude-code'

import { boundConnectionId } from './scripts/terminal-status.mjs'

type Api = Parameters<Hook<'prompt.submit'>>[0]
type Submitted = Parameters<Hook<'prompt.submit'>>[1]

/** Hand the prompt to the room's mirror when this conversation is connected. Never throws. */
export async function mirrorPrompt($: Api, e: Submitted): Promise<void> {
  try {
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
    const conversationId = await $.session.id()
    const readText = (path: string) => $.fs.read(path).then((text) => String(text), () => null)
    if (await boundConnectionId({ home, conversationId, readText })) {
      await $.process.run(['node', `${$.plugin.root}/hooks/scripts/mirror-turn.mjs`, 'user_prompt'], {
        stdin: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          session_id: conversationId,
          prompt: e.text,
          origin: e.origin,
          // Set when the prompt is delivered into, or typed over, a running turn:
          // what it carries then joins that turn (item 7a4d04fd).
          turn_id: e.turnId ?? null,
        }),
        timeoutMs: 30_000,
      })
    }
  } catch {
    /* the prompt is the person's; DevSpec never stands in its way */
  }
}
