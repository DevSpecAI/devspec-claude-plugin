/**
 * Clear a reported terminal wait when the prompt is DENIED (item acde245e).
 *
 * scripts/terminal-wait.mjs reports a wait from the Notification hook and clears it
 * from PostToolUse, the next prompt, Stop and SessionEnd. A denial fires none of
 * them: on Claude Code 2.1.291 (measured 2026-10-06), choosing "No" on a permission
 * prompt interrupts the turn and runs no command hook at all. There was no
 * PostToolUse, PostToolUseFailure, PermissionDenied or Stop, and no idle
 * Notification within 75 s. So DevSpec kept showing a denied prompt as waiting until
 * the person's next prompt.
 *
 * `tool.call` runs the hooks, then the permission check and its dialog, then the
 * tool. A hook's `next` therefore settles however the dialog was answered, denial
 * included, and this hands the clear to the same script whenever a wait is on
 * record. On a build without the function-hooks API the module is ignored, and a
 * denied prompt clears at the next prompt as before.
 *
 * A plugin has exactly one hooks module, so terminal-status.ts registers this.
 */
import type { Register } from 'claude-code'

import { boundConnectionId, terminalWaitPath } from './scripts/terminal-status.mjs'

export function clearTerminalWaitWhenAnswered(on: Parameters<Register>[0]) {
  on('tool.call', async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      // Never awaited: the call's own result is not held up by DevSpec.
      void (async () => {
        const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
        const conversationId = await $.session.id()
        const readText = (path: string) => $.fs.read(path).then((text) => String(text), () => null)
        const connectionId = await boundConnectionId({ home, conversationId, readText })
        if (!connectionId || (await readText(terminalWaitPath(home, connectionId))) === null) return
        await $.process.run(['node', `${$.plugin.root}/hooks/scripts/terminal-wait.mjs`, 'clear'], {
          stdin: JSON.stringify({ hook_event_name: 'ToolCallSettled', session_id: conversationId }),
          timeoutMs: 15_000,
        })
      })().catch(() => undefined)
    }
  })
}
