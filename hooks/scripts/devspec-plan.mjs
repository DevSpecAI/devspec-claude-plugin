#!/usr/bin/env node
/**
 * Capability-safe MCP describe/use bridge for the connection-bound manage_plan tool.
 *
 * Claude Code cannot add a header learned by the raw connect script to a later native
 * MCP call. Connect therefore stores the hidden capability in its mode-0600 connection
 * state and this bridge injects it mechanically. Only manage_plan is reachable here;
 * poll/heartbeat/delivery verbs remain private to the remote-control pump.
 *
 * Usage:
 *   node devspec-plan.mjs describe --connection-id <uuid>
 *   node devspec-plan.mjs use --connection-id <uuid> --input '{"action":"list"}'
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mcpToolsCall, mcpToolsList } from './mcp-call.mjs'
import { readPrivateJson } from './private-state.mjs'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MANAGE_PLAN_ACTIONS = new Set([
  'create', 'list', 'get', 'update', 'start_step', 'complete_step', 'skip_step',
  'fail_step', 'advance', 'complete', 'abandon', 'adopt',
])
const READ_ACTIONS = new Set(['list', 'get'])
const MANAGE_PLAN_PROPERTIES = new Set([
  'action', 'plan_id', 'expected_revision', 'title', 'steps', 'step_id',
  'current_step_id', 'next_step_id', 'reason', 'retryable',
])
const MANAGE_PLAN_STEP_PROPERTIES = new Set(['id', 'title', 'description'])

export function parseArgs(argv) {
  const out = { command: null, connectionId: null, input: null }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!out.command && (arg === 'describe' || arg === 'use')) out.command = arg
    else if (arg === '--connection-id' || arg === '--connection_id') out.connectionId = argv[++index]
    else if (arg === '--input' || arg === '--json') out.input = argv[++index]
  }
  return out
}

export function validateManagePlanArguments(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'manage_plan input must be a JSON object' }
  }
  if (!MANAGE_PLAN_ACTIONS.has(input.action)) {
    return { ok: false, error: 'unknown manage_plan action' }
  }
  const unknown = Object.keys(input).find((key) => !MANAGE_PLAN_PROPERTIES.has(key))
  if (unknown) {
    return { ok: false, error: `unknown manage_plan property: ${unknown}` }
  }
  if (Object.hasOwn(input, 'steps')) {
    if (!Array.isArray(input.steps)) return { ok: false, error: 'steps must be an array' }
    for (const step of input.steps) {
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        return { ok: false, error: 'every step must be an object' }
      }
      const unknownStep = Object.keys(step).find((key) => !MANAGE_PLAN_STEP_PROPERTIES.has(key))
      if (unknownStep) return { ok: false, error: `unknown manage_plan step property: ${unknownStep}` }
    }
  }
  if (input.action !== 'create' && !READ_ACTIONS.has(input.action)) {
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1) {
      return { ok: false, error: 'existing-plan mutations require expected_revision' }
    }
  }
  if (input.action === 'adopt' && typeof input.plan_id !== 'string') {
    return { ok: false, error: 'adopt requires explicit plan_id' }
  }
  return { ok: true }
}

export function readPlanConnectionState(connectionId, dir = CONNECTIONS_DIR) {
  if (typeof connectionId !== 'string' || !UUID.test(connectionId)) {
    throw new Error('missing or invalid --connection-id')
  }
  const statePath = path.join(dir, `${connectionId}.json`)
  const state = readPrivateJson(statePath)
  if (!state) throw new Error('connection state is unavailable or unreadable')
  if (state.connection_id !== connectionId || state.enabled === false) {
    throw new Error('connection state is unavailable or disabled')
  }
  if (!state.session_id) throw new Error('manage_plan requires an attached DevSpec session')
  if (!state.token || !state.mcp_url) throw new Error('connection MCP authentication is unavailable')
  if (!state.connection_capability) {
    throw new Error('connection plan capability is unavailable; reconnect with the current plugin')
  }
  return state
}

export function managePlanRequestOptions(state) {
  return {
    mcpUrl: state.mcp_url,
    token: state.token,
    connectionCapability: state.connection_capability,
    timeoutMs: 30_000,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.command) throw new Error('expected describe or use')
  const state = readPlanConnectionState(args.connectionId)
  const options = managePlanRequestOptions(state)

  if (args.command === 'describe') {
    const tools = await mcpToolsList(options)
    const tool = tools.find((candidate) => candidate?.name === 'manage_plan')
    if (!tool) throw new Error('server did not advertise manage_plan')
    process.stdout.write(JSON.stringify(tool, null, 2) + '\n')
    return
  }

  const raw = args.input ?? fs.readFileSync(0, 'utf8')
  let input
  try {
    input = JSON.parse(raw)
  } catch {
    throw new Error('use requires valid JSON via --input or stdin')
  }
  const validation = validateManagePlanArguments(input)
  if (!validation.ok) throw new Error(validation.error)
  const result = await mcpToolsCall({
    ...options,
    name: 'manage_plan',
    arguments: input,
  })
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}

const isMain = Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`devspec-plan: ${error?.message || String(error)}\n`)
    process.exit(1)
  })
}
