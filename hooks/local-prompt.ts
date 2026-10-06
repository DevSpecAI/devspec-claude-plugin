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
 * Awaited before `next(e)`, as the command hook was. A failure never holds the prompt
 * back: it enters regardless, unmirrored. A build without the function-hooks API runs
 * no module, and so mirrors no prompt.
 *
 * A plugin has exactly one hooks module, so terminal-status.ts registers this.
 */
import type { Register } from 'claude-code'

import { boundConnectionId } from './scripts/terminal-status.mjs'

export function mirrorPromptsToTheRoom(on: Parameters<Register>[0]): void {
  on('prompt.submit', async ($, e, next) => {
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
          }),
          timeoutMs: 30_000,
        })
      }
    } catch {
      /* the prompt is the person's; DevSpec never stands in its way */
    }
    return next(e)
  })
}
