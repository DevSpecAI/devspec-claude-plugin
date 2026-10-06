/**
 * Tell DevSpec which model Claude Code is running, at what effort, how full its
 * context is and what the last turn used (item 2382364d).
 *
 * The main loop's first model request of each turn writes a refreshed report, so the
 * model DevSpec holds is the one this turn is using, timed now. The turn's end writes
 * the settled report: the model the API reported, the turn's token counts and the
 * session's cost from Claude Code's own ledger. Each is sent at once through
 * scripts/devspec-telemetry.mjs. The report, its file and why the module is the
 * writer are described in scripts/agent-telemetry.mjs.
 *
 * Subagents' requests and turns are left out: the report describes the agent DevSpec
 * talks to, which is the main loop. A `-p` run reports too when it is connected,
 * because which model did the work matters as much there.
 *
 * Registered by terminal-status.ts, since a plugin has exactly one hooks module.
 * Nothing here is awaited by the hook, so no request and no turn waits on DevSpec.
 */
import type { Register } from 'claude-code'

import { boundConnectionId } from './scripts/terminal-status.mjs'
import { parseTelemetryRecord, refreshedRecord, settledRecord, telemetryPath } from './scripts/agent-telemetry.mjs'

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number | undefined

// The main loop's turn while it runs: the model and effort its latest request was
// sent with, how many requests it has made, the session's cost as it began, and the
// refreshed report's write and send, which the settled one waits for so it is never
// overwritten by it. Module state: a reload starts it afresh, as it does every
// module variable.
type Turn = {
  turnId: string
  model: string
  effort: Effort
  requests: number
  costAtStart: number | undefined
  refreshed: Promise<void>
}
let current: Turn | null = null

export function watchTurnsForTelemetry(on: Parameters<Register>[0]): void {
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const first = current?.turnId !== e.turnId
      const turn: Turn = first
        ? { turnId: e.turnId, model: e.model, effort: e.effort, requests: 0, costAtStart: undefined, refreshed: Promise.resolve() }
        : current!
      turn.model = e.model
      turn.effort = e.effort
      turn.requests = Math.max(turn.requests, e.index + 1)
      current = turn
      if (first) {
        turn.refreshed = (async () => {
          const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
          const conversationId = await $.session.id()
          const readText = (path: string) => $.fs.read(path).then((text) => String(text), () => null)
          const usage = await $.session.usage()
          turn.costAtStart = usage.cost?.usd
          const connectionId = await boundConnectionId({ home, conversationId, readText })
          if (!connectionId) return
          const path = telemetryPath(home, connectionId)
          await $.fs.write(path, refreshedRecord({
            previous: parseTelemetryRecord(await readText(path)),
            conversationId,
            model: turn.model,
            effort: turn.effort,
            context: usage.context,
            nowIso: new Date().toISOString(),
          }))
          await $.process.run(['node', `${$.plugin.root}/hooks/scripts/devspec-telemetry.mjs`, 'send', connectionId], {
            timeoutMs: 15_000,
          })
        })().catch(() => undefined)
      }
    }
    return yield* next(e)
  })

  // An interrupted turn has nothing to settle: Claude Code counts no usage for it, so
  // the report its first request wrote stands. (This is also what lets the module hook
  // turn.complete a second time beside devspec-control.ts, which needs every ending.)
  on('turn.complete', { isAborted: false }, async ($, e, next) => {
    if (e.agentId === undefined) {
      const turn = current?.turnId === e.turnId ? current : null
      current = null
      void (async () => {
        await turn?.refreshed
        const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
        const conversationId = await $.session.id()
        const readText = (path: string) => $.fs.read(path).then((text) => String(text), () => null)
        const connectionId = await boundConnectionId({ home, conversationId, readText })
        if (!connectionId) return
        const usage = await $.session.usage()
        const sessionCostUsd = usage.cost?.usd
        const path = telemetryPath(home, connectionId)
        await $.fs.write(path, settledRecord({
          previous: parseTelemetryRecord(await readText(path)),
          conversationId,
          usage: e.usage,
          stepModel: turn?.model,
          effort: turn?.effort,
          context: usage.context,
          requests: turn?.requests,
          sessionTurns: await $.session.turns(),
          sessionCostUsd,
          turnCostUsd: sessionCostUsd !== undefined && turn?.costAtStart !== undefined
            ? sessionCostUsd - turn.costAtStart
            : undefined,
          nowIso: new Date().toISOString(),
        }))
        await $.process.run(['node', `${$.plugin.root}/hooks/scripts/devspec-telemetry.mjs`, 'send', connectionId], {
          timeoutMs: 15_000,
        })
      })().catch(() => undefined)
    }
    return next(e)
  })
}
