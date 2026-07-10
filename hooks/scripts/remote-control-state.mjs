#!/usr/bin/env node
/**
 * Read/write ~/.devspec/remote-control.json for connect / poll / stop.
 *
 * Usage:
 *   node remote-control-state.mjs write --session <uuid> [--agent "Claude Code"] [--cwd <path>]
 *   node remote-control-state.mjs disable
 *   node remote-control-state.mjs read
 *   node remote-control-state.mjs resolve-auth   # print auth resolution only
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'

const STATE_PATH = path.join(os.homedir(), '.devspec', 'remote-control.json')

function readState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return null
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return null
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
  // Never world-readable if we store a token
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--session' || a === '--session_id') out.session = argv[++i]
    else if (a === '--agent' || a === '--agent_name') out.agent = argv[++i]
    else if (a === '--cwd') out.cwd = argv[++i]
    else if (a === '--url') out.url = argv[++i]
    else out._.push(a)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const cmd = args._[0] || 'read'

if (cmd === 'resolve-auth') {
  const auth = resolveDevspecMcpAuth(args.cwd || process.cwd())
  // Mask token in human-friendly view when --mask
  if (process.argv.includes('--mask') && auth.token) {
    auth.token_preview = auth.token.slice(0, 8) + '…' + auth.token.slice(-4)
    delete auth.token
  }
  process.stdout.write(JSON.stringify(auth, null, 2) + '\n')
  process.exit(auth.ok ? 0 : 1)
}

if (cmd === 'read') {
  const s = readState()
  process.stdout.write(JSON.stringify(s, null, 2) + '\n')
  process.exit(s ? 0 : 1)
}

if (cmd === 'disable') {
  const prev = readState() || {}
  writeState({
    ...prev,
    enabled: false,
    updated_at: new Date().toISOString(),
  })
  process.stdout.write(JSON.stringify({ ok: true, enabled: false, path: STATE_PATH }) + '\n')
  process.exit(0)
}

if (cmd === 'write') {
  if (!args.session) {
    process.stderr.write('Usage: remote-control-state.mjs write --session <uuid>\n')
    process.exit(2)
  }
  const cwd = args.cwd || process.cwd()
  const auth = resolveDevspecMcpAuth(cwd)
  const state = {
    enabled: true,
    session_id: args.session,
    agent_name: args.agent || 'Claude Code',
    mcp_url: args.url || auth.mcp_url || 'https://devspec.ai/api/mcp',
    token: auth.token || undefined,
    auth_source: auth.source || auth.error || null,
    auth_ok: !!auth.ok,
    cwd,
    // Clear any prior UI-end sticky flags from a previous session.
    ended_from_ui: false,
    end_reason: null,
    updated_at: new Date().toISOString(),
  }
  writeState(state)

  const result = {
    ok: true,
    path: STATE_PATH,
    session_id: state.session_id,
    mcp_url: state.mcp_url,
    auth_ok: state.auth_ok,
    auth_source: state.auth_source,
    token_present: !!state.token,
  }
  if (!state.auth_ok) {
    result.warning = auth.error
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  // Exit 0 even without token so connect continues; poller/hooks will warn.
  process.exit(0)
}

process.stderr.write(`Unknown command: ${cmd}\n`)
process.exit(2)
