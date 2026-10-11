/**
 * Carry out the owner's controls from DevSpec inside Claude Code (item cbf3d758).
 *
 * The owner presses Stop, picks a thinking level or compacts in DevSpec; the poller
 * writes the control to a hand-off file; this module carries it out and hands it back
 * through scripts/devspec-control.mjs. Stop cancels the running turn with
 * `$.turn.abort`. Thinking and compact run Claude Code's own `/effort` and `/compact`
 * through `$.command.run`, exactly as if the owner had typed them in this terminal,
 * so Claude Code applies, saves and shows them the way it always does. The module
 * also keeps a small report saying what it carries out, which the poller passes to
 * DevSpec, so DevSpec offers these only while this module is loaded. The whole path
 * is described in scripts/control-relay.mjs, including why model is not among them.
 *
 * A plugin has exactly one hooks module, and a module hooks session.start once, so
 * terminal-status.ts calls watchTurnsForStop from its register and
 * startDevspecControls from its own session.start, once it knows the session is
 * interactive and where home is. The state below is the module instance's: a reload
 * starts it afresh, as it does every module variable.
 */
import type { Register } from 'claude-code'

import { boundConnectionId } from './scripts/terminal-status.mjs'
import { effortChangedRecord, parseTelemetryRecord, telemetryPath } from './scripts/agent-telemetry.mjs'
import {
  CARRIED_REFRESH_MS,
  CONTROL_TICK_MS,
  carriedControlsPath,
  carriedControlsRecord,
  commandForControl,
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
  /** Run a Claude Code slash command as if typed here; Claude Code waits until it is idle. */
  runCommand: (command: string, args: string) => Promise<unknown>
  /** The settings Claude Code reads, merged over every source. */
  readSettings: () => Promise<{ modelSettings?: Record<string, { effortLevel?: unknown } | undefined> }>
  run: (argv: string[]) => Promise<{ exitCode: number }>
  every: (ms: number, fn: () => void) => void
}

type Pending = NonNullable<ReturnType<typeof parsePendingControl>>

/**
 * After `/effort`: tell DevSpec the level Claude Code now holds for this model, read
 * from what Claude Code saved, so the owner sees it confirmed without waiting for the
 * next turn. When that cannot be read, the next turn's report says it instead.
 */
async function reportAppliedEffort(host: ControlHost, connectionId: string, conversationId: string): Promise<void> {
  const path = telemetryPath(host.home, connectionId)
  const previous = parseTelemetryRecord(await host.readText(path))
  const modelId = previous?.conversationId === conversationId ? previous.report?.model?.id : null
  if (typeof modelId !== 'string' || !modelId) return
  const settings = await host.readSettings()
  const text = effortChangedRecord({
    previous,
    conversationId,
    effort: settings.modelSettings?.[modelId]?.effortLevel,
    nowIso: new Date().toISOString(),
  })
  if (!text) return
  await host.writeText(path, text)
  await host.run(['node', `${host.pluginRoot}/hooks/scripts/devspec-telemetry.mjs`, 'send', connectionId])
}

/** Carry one control out. Never throws: a control that fails is still handed back. */
async function carryOut(host: ControlHost, control: Pending, connectionId: string, conversationId: string): Promise<void> {
  if (control.verb === 'abort') {
    if (runningTurn) await host.abortTurn(runningTurn).catch(() => undefined)
    return
  }
  const command = commandForControl(control)
  if (!command) return
  const ran = host.runCommand(command.command, command.args).then(async () => {
    if (control.verb === 'set_thinking') await reportAppliedEffort(host, connectionId, conversationId)
  })
  // Claude Code runs a command only once the turn in progress ends, as it would one
  // typed here. Hand the control back now rather than holding DevSpec's one control
  // slot, and with it the owner's Stop, until then.
  if (runningTurn) {
    ran.catch(() => undefined)
    return
  }
  await ran.catch(() => undefined)
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
        if (controlIsCurrent(control, now)) await carryOut(host, control, connectionId, conversationId)
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
