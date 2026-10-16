/**
 * PreToolUse for a call that would start work outliving it — a background command
 * or subagent, a workflow, a monitor, a scheduled wake-up, a cron (item 7a4d04fd).
 *
 * Whatever that work does when it later wakes the agent is credited to the request
 * it was started for. While the turn carries requests that would be recorded
 * differently and the agent has not said which it is working on, nothing here can
 * know which one this work is for, so the launch is refused with the one command
 * that names it. Never a guess, and nothing is started under one.
 *
 * Imports only Node built-ins and sibling modules (DEVELOPMENT.md).
 */

import os from 'node:os'
import path from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ownConnectionId } from './own-connection.mjs'
import { readRequestState, selectableRequests, servableCarried, startsBackgroundWork, turnAmbiguity, undecidedTurnMessage } from './requests.mjs'

export function launchGuard(input, { home = os.homedir(), env = process.env } = {}) {
  if (!startsBackgroundWork(input?.tool_name, input?.tool_input)) return {}
  const connectionId = ownConnectionId(input?.session_id, { home, env })
  if (!connectionId) return {}
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  const agentId = typeof input?.agent_id === 'string' && input.agent_id ? input.agent_id : null
  const state = readRequestState(connectionId, { dir })
  const carried = turnAmbiguity(state, agentId)
  if (!carried) return {}
  return { hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: undecidedTurnMessage(connectionId, servableCarried(state, selectableRequests(state) ?? carried), 'whatever this background work does when it wakes you'),
  } }
}

let main = false
try { main = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch {}
if (main) {
  // A guard that cannot read its input lets the call through: the launch is then
  // recorded against the current request, and DevSpec's own checks still apply.
  try { process.stdout.write(JSON.stringify(launchGuard(JSON.parse(readFileSync(0, 'utf8'))))) } catch { process.stdout.write('{}') }
}
