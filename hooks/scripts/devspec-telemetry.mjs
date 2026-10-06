#!/usr/bin/env node
/**
 * Send this conversation's runtime report to DevSpec (item 2382364d):
 *
 *   node devspec-telemetry.mjs send <connection_id>
 *
 * The plugin's function-hooks module writes the report (which model is running, at
 * what effort, the context fill and the last turn's usage) when a turn makes its first
 * model request and when it ends, but it has no network of its own, so it runs this.
 * The report rides heartbeat_connection as `agent_stats`, which DevSpec stores as the
 * connection's last known report and its model. No `busy` is sent, so the working state
 * the turn hooks keep is left as it is. See agent-telemetry.mjs for the whole path.
 *
 * Exits 0 once DevSpec has the report, 1 when there was nothing to send or it could
 * not be sent; the next turn sends a newer one either way.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mcpToolsCall } from './mcp-call.mjs'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import { readPrivateJson } from './private-state.mjs'
import { parseTelemetryRecord, telemetryPath } from './agent-telemetry.mjs'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** @returns {Promise<{ ok: boolean, reason?: string }>} */
export async function sendTelemetry({ connectionId, home = os.homedir(), call = mcpToolsCall }) {
  if (!ID.test(connectionId ?? '')) return { ok: false, reason: 'bad_id' }
  let text = null
  try {
    text = fs.readFileSync(telemetryPath(home, connectionId), 'utf8')
  } catch {
    return { ok: false, reason: 'no_report' }
  }
  const report = parseTelemetryRecord(text)?.report
  if (!report) return { ok: false, reason: 'no_report' }
  const state = readPrivateJson(path.join(home, '.devspec', 'remote-control', 'connections', `${connectionId}.json`))
  let token = state?.token
  let mcpUrl = state?.mcp_url
  if (!token) {
    const auth = resolveDevspecMcpAuth(state?.cwd || process.cwd())
    token = auth.token
    mcpUrl = mcpUrl || auth.mcp_url
  }
  if (!token) return { ok: false, reason: 'no_token' }
  await call({
    mcpUrl: mcpUrl || 'https://api.devspec.ai/api/mcp',
    token,
    name: 'heartbeat_connection',
    arguments: { connection_id: connectionId, agent_name: AGENT_NAME, status: 'live', agent_stats: report },
  })
  return { ok: true }
}

async function main() {
  const [mode, connectionId] = process.argv.slice(2)
  if (mode !== 'send') return 1
  try {
    return (await sendTelemetry({ connectionId })).ok ? 0 : 1
  } catch {
    return 1
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main().then((code) => process.exit(code))
