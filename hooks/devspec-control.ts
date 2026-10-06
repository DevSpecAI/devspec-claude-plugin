/**
 * Carry out the owner's controls from DevSpec inside Claude Code (item cbf3d758).
 *
 * The owner presses Stop in DevSpec; the poller writes the control to a hand-off file;
 * this module cancels the running turn with `$.turn.abort` and hands the control back
 * through scripts/devspec-control.mjs. It also keeps a small report saying what it
 * carries out, which the poller passes to DevSpec, so Stop is offered only while this
 * module is loaded. The whole path is described in scripts/control-relay.mjs.
 *
 * Only Stop for now: model, thinking and compact are not built, so they are not
 * reported, not offered, and handed back by the poller if one arrives anyway.
 *
 * A plugin has exactly one hooks module, and a module hooks session.start once, so
 * terminal-status.ts calls watchTurnsForStop from its register and
 * startDevspecControls from its own session.start, once it knows the session is
 * interactive and where home is. The state below is the module instance's: a reload
 * starts it afresh, as it does every module variable.
 */
import type { Register } from 'claude-code'

import { boundConnectionId } from './scripts/terminal-status.mjs'
import {
  CARRIED_REFRESH_MS,
  CONTROL_TICK_MS,
  carriedControlsPath,
  carriedControlsRecord,
  controlIsCurrent,
  parsePendingControl,
  pendingControlPath,
  stopHookPath,
  stopHookRanSince,
} from './scripts/control-relay.mjs'

// The main loop's turn, if one is running. A subagent's run raises no turn.start, so
// this is always the turn Stop means.
let runningTurn: string | null = null
// Carried out, and handed back: kept apart so a failed ack is retried without stopping
// anything a second time.
const carriedOut = new Set<string>()
const handedBack = new Set<string>()

/** Follow the running turn, so Stop knows what to cancel. */
export function watchTurnsForStop(on: Parameters<Register>[0]): void {
  on('turn.start', async ($, e, next) => {
    runningTurn = e.turnId
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && e.turnId === runningTurn) runningTurn = null
    // Some turns end with no Stop hook, and the Stop hook is what tells DevSpec a turn
    // ended, so DevSpec went on showing the agent as working. Measured on 2.1.291: an
    // interrupt (Esc, Stop from DevSpec) completes as 'aborted' and a denied permission
    // prompt as 'answer', neither running the Stop hook, while a normal turn's Stop
    // hook runs a few milliseconds before this event. So when no Stop hook ran since
    // this turn began, end it the same way the Stop hook does. A Stop hook that kept
    // the turn open on purpose (re-arming, background work) did run, and is left be.
    if (!e.agentId) {
      const turnStartedAt = Date.now() - e.durationMs
      void (async () => {
        const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
        const conversationId = await $.session.id()
        const readText = (path: string) => $.fs.read(path).then((text) => String(text), () => null)
        const connectionId = await boundConnectionId({ home, conversationId, readText })
        if (!connectionId) return
        if (stopHookRanSince(await readText(stopHookPath(home, connectionId)), turnStartedAt)) return
        await $.process.run(['node', `${$.plugin.root}/hooks/scripts/mirror-turn.mjs`, 'stop'], {
          stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: conversationId, stop_hook_active: false }),
          timeoutMs: 30_000,
        })
      })().catch(() => undefined)
    }
    return next(e)
  })
}

/**
 * What starting needs from the session, as closures made where `$` lives: the plugin
 * API is followed only within the file that holds the hook, never across an import.
 */
export type ControlHost = {
  home: string
  pluginRoot: string
  conversationId: () => Promise<string>
  readText: (path: string) => Promise<string | null>
  writeText: (path: string, text: string) => Promise<void>
  abortTurn: (turnId: string) => Promise<void>
  run: (argv: string[]) => Promise<{ exitCode: number }>
  every: (ms: number, fn: () => void) => void
}

/** Start looking for controls. Only for an interactive session: nobody steers a `-p` run. */
export function startDevspecControls(host: ControlHost): void {
  const { home, readText } = host
  let reportedFor: string | null = null
  let reportedAt = 0
  let ticking = false
  const tick = async () => {
    if (ticking) return
    ticking = true
    try {
      // Asked every time: /clear starts a new conversation in the same process.
      const conversationId = await host.conversationId()
      const connectionId = await boundConnectionId({ home, conversationId, readText })
      if (!connectionId) return
      const now = Date.now()
      if (reportedFor !== connectionId || now - reportedAt >= CARRIED_REFRESH_MS) {
        await host.writeText(carriedControlsPath(home, connectionId), carriedControlsRecord(new Date(now).toISOString()))
        reportedFor = connectionId
        reportedAt = now
      }

      const control = parsePendingControl(await readText(pendingControlPath(home, connectionId)))
      if (!control || handedBack.has(control.id)) return
      if (!carriedOut.has(control.id)) {
        carriedOut.add(control.id)
        if (control.verb === 'abort' && runningTurn && controlIsCurrent(control, now)) {
          await host.abortTurn(runningTurn).catch(() => undefined)
        }
      }
      const { exitCode } = await host.run(['node', `${host.pluginRoot}/hooks/scripts/devspec-control.mjs`, 'ack', connectionId, control.id])
      if (exitCode === 0) handedBack.add(control.id)
    } finally {
      ticking = false
    }
  }

  host.every(CONTROL_TICK_MS, () => {
    tick().catch(() => undefined)
  })
}
