/**
 * The DevSpec line under Claude Code's prompt, and a toast when it changes (item
 * c6dcb524).
 *
 * A Claude Code function-hooks module: `hooks.json` names it under `modules`, next
 * to the plugin's command hooks. With it present the command hooks still ran on
 * every build measured (2.1.132, 2.1.193, 2.1.246, 2.1.278, 2.1.289): builds that
 * predate the API ignore the key, and one whose API differs (2.1.246) refuses this
 * module alone. Either way the terminal is back to showing nothing, which is where
 * it started.
 *
 * Display only. It reads the conversation's own DevSpec state (see
 * scripts/terminal-status.mjs) and never writes it, never calls the model, and
 * never talks to DevSpec.
 *
 * Claude Code takes one hooks module per plugin, so this is also where the
 * terminal-wait clear for a denied prompt (terminal-wait.ts), the owner's controls
 * from DevSpec (devspec-control.ts) and the runtime report of which model is running
 * (devspec-telemetry.ts) are registered. Those three do reach DevSpec, through
 * scripts/terminal-wait.mjs, scripts/devspec-control.mjs and
 * scripts/devspec-telemetry.mjs.
 */
import type { Register } from 'claude-code'

import { startDevspecControls, watchTurnsForStop } from './devspec-control'
import { watchTurnsForTelemetry } from './devspec-telemetry'
import { clearTerminalWaitWhenAnswered } from './terminal-wait'

import {
  STATUS_REFRESH_MS,
  applyWorkChange,
  devspecVerb,
  formatStatusLine,
  readConnectionView,
  transitionToast,
  workChange,
} from './scripts/terminal-status.mjs'

type View = Awaited<ReturnType<typeof readConnectionView>>

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const register: Register = (on) => {
  clearTerminalWaitWhenAnswered(on)
  watchTurnsForStop(on)
  watchTurnsForTelemetry(on)

  // Items this conversation's own claims hold, oldest first, as DevSpec answered
  // them. Held by the module, so a reload of the plugin starts it empty.
  let work: string[] = []
  // undefined until the first reading, so the baseline is never announced.
  let lastView: View | undefined = undefined
  let lastLine: string | undefined = undefined

  on('session.start', async ($, e, next) => {
    // A `-p` run or an SDK host has no prompt to draw under.
    if (!e.isInteractive || e.surface === null) return next(e)
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
    if (!home) return next(e)

    const readText = (path: string) => $.fs.read(path).then((text) => String(text), () => null)

    const paint = async () => {
      // Asked every time: /clear starts a new conversation in the same process,
      // and the plugin moves the connection over to it.
      const conversationId = await $.session.id()
      const view = await readConnectionView({ home, conversationId, readText, sha256Hex })
      const toast = transitionToast(lastView, view)
      lastView = view
      if (toast) $.ui.toast(toast, { timeoutMs: 8_000 })
      const line = formatStatusLine(view, view?.state === 'connected' ? work : [])
      if (line !== lastLine) {
        lastLine = line
        $.ui.status(line)
      }
    }

    await paint().catch(() => undefined)
    $.clock.every(STATUS_REFRESH_MS, () => paint().catch(() => undefined))
    startDevspecControls({
      home,
      pluginRoot: $.plugin.root,
      conversationId: () => $.session.id(),
      readText,
      writeText: (path, text) => $.fs.write(path, text),
      abortTurn: (turnId) => $.turn.abort({ turnId }),
      run: (argv) => $.process.run(argv, { timeoutMs: 15_000 }),
      every: (ms, fn) => {
        $.clock.every(ms, fn)
      },
    })
    return next(e)
  })

  on('tool.call', { tool: /^mcp__(?:plugin_devspec_)?devspec__/ }, async ($, e, next) => {
    const ran = await next(e)
    if (devspecVerb(e.tool) === null || ran.deny !== undefined) return ran
    const change = workChange({
      tool: e.tool,
      input: e,
      resultText: ran.text,
      isError: ran.isError === true,
    })
    if (change) {
      work = applyWorkChange(work, change)
      const line = formatStatusLine(lastView ?? null, lastView?.state === 'connected' ? work : [])
      if (line !== lastLine) {
        lastLine = line
        $.ui.status(line)
      }
    }
    return ran
  })
}
