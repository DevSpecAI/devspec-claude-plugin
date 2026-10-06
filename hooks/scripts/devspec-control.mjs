#!/usr/bin/env node
/**
 * Hand an owner control back to DevSpec once the module has handled it (item cbf3d758):
 *
 *   node devspec-control.mjs ack <connection_id> <control_id>
 *
 * The plugin's function-hooks module carries the control out inside Claude Code, but
 * it has no network of its own, so it runs this. heartbeat_connection `control_ack`
 * frees the connection's one control slot, and only while that control is still the
 * pending one. The hand-off file is removed only if it still names this control, so a
 * newer one the poller wrote meanwhile stays for the module.
 *
 * Exits 0 once DevSpec has the ack, 1 when it could not be sent, so the module can try
 * again on its next tick. See control-relay.mjs for the whole path.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mcpToolsCall } from './mcp-call.mjs'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import { readPrivateJson } from './private-state.mjs'
import { parsePendingControl, pendingControlPath } from './control-relay.mjs'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** @returns {Promise<{ ok: boolean, reason?: string }>} */
export async function ackControl({ connectionId, controlId, home = os.homedir(), call = mcpToolsCall }) {
  if (!ID.test(connectionId ?? '') || !ID.test(controlId ?? '')) return { ok: false, reason: 'bad_id' }
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
    arguments: { connection_id: connectionId, agent_name: AGENT_NAME, status: 'live', control_ack: controlId },
  })
  const file = pendingControlPath(home, connectionId)
  try {
    if (parsePendingControl(fs.readFileSync(file, 'utf8'))?.id === controlId) fs.rmSync(file, { force: true })
  } catch {
    /* already gone */
  }
  return { ok: true }
}

async function main() {
  const [mode, connectionId, controlId] = process.argv.slice(2)
  if (mode !== 'ack') return 1
  try {
    return (await ackControl({ connectionId, controlId })).ok ? 0 : 1
  } catch {
    return 1
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main().then((code) => process.exit(code))
