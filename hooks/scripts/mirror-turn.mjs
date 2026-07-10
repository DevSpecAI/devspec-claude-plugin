#!/usr/bin/env node
/**
 * DevSpec remote-control mirror hook.
 *
 * Invoked by Claude Code Stop / UserPromptSubmit hooks when this plugin is
 * enabled. If ~/.devspec/remote-control.json says a remote session is active
 * and a token is available, posts the latest turn to DevSpec via MCP HTTP.
 *
 * State file (written by /devspec.remote on connect):
 *   {
 *     "enabled": true,
 *     "session_id": "<uuid>",
 *     "agent_name": "Claude Code",
 *     "mcp_url": "https://devspec.ai/api/mcp",
 *     "token": "dvs_..."   // optional — falls back to DEVSPEC_MCP_TOKEN env
 *   }
 *
 * Exit 0 always so hooks never block the agent turn.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mode = process.argv[2] === 'user_prompt' ? 'user_prompt' : 'stop'
const statePath = path.join(os.homedir(), '.devspec', 'remote-control.json')

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function loadState() {
  try {
    if (!fs.existsSync(statePath)) return null
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    if (!raw || raw.enabled !== true || !raw.session_id) return null
    return raw
  } catch {
    return null
  }
}

function extractLastText(hookInput, which) {
  // Claude Code hook stdin is JSON; shapes vary slightly by version. Be defensive.
  let data
  try {
    data = JSON.parse(hookInput || '{}')
  } catch {
    return null
  }

  if (which === 'user_prompt') {
    return (
      data.prompt ||
      data.user_prompt ||
      data.message ||
      data.transcript?.slice?.(-1)?.[0]?.content ||
      null
    )
  }

  // Stop: last assistant message
  if (typeof data.last_assistant_message === 'string') return data.last_assistant_message
  if (typeof data.assistant_message === 'string') return data.assistant_message
  if (typeof data.response === 'string') return data.response
  const msgs = data.transcript || data.messages
  if (Array.isArray(msgs)) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m && (m.role === 'assistant' || m.type === 'assistant')) {
        const c = m.content
        if (typeof c === 'string' && c.trim()) return c
        if (Array.isArray(c)) {
          const text = c
            .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
            .map((b) => b.text || '')
            .join('\n')
            .trim()
          if (text) return text
        }
      }
    }
  }
  return null
}

async function postSessionMessage({ mcpUrl, token, sessionId, agentName, message }) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'post_session_message',
      arguments: {
        session_id: sessionId,
        message,
        agent_name: agentName || 'Claude Code',
      },
    },
  }

  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  })

  // Best-effort; never throw out of the hook.
  if (!res.ok) {
    process.stderr.write(`[devspec-remote] post failed: HTTP ${res.status}\n`)
  }
}

async function heartbeat({ mcpUrl, token, sessionId, agentName }) {
  const body = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'report_remote_agent_heartbeat',
      arguments: {
        session_id: sessionId,
        agent_name: agentName || 'Claude Code',
      },
    },
  }
  try {
    await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    })
  } catch {
    /* ignore */
  }
}

async function main() {
  const state = loadState()
  if (!state) process.exit(0)

  const token = state.token || process.env.DEVSPEC_MCP_TOKEN || process.env.DEVSPEC_TOKEN
  const mcpUrl = state.mcp_url || process.env.DEVSPEC_MCP_URL || 'https://devspec.ai/api/mcp'
  if (!token) {
    // No token — leave a tiny system hint via stdout is not supported for command
    // hooks reliably; just exit quietly. The skill still posts instructionally.
    process.exit(0)
  }

  const raw = readStdin()
  const text = extractLastText(raw, mode)
  if (!text || !String(text).trim()) {
    await heartbeat({
      mcpUrl,
      token,
      sessionId: state.session_id,
      agentName: state.agent_name,
    })
    process.exit(0)
  }

  const message =
    mode === 'user_prompt'
      ? `👤 **Local prompt:**\n\n${String(text).trim().slice(0, 12000)}`
      : String(text).trim().slice(0, 12000)

  try {
    await postSessionMessage({
      mcpUrl,
      token,
      sessionId: state.session_id,
      agentName: state.agent_name,
      message,
    })
    await heartbeat({
      mcpUrl,
      token,
      sessionId: state.session_id,
      agentName: state.agent_name,
    })
  } catch (e) {
    process.stderr.write(`[devspec-remote] ${e instanceof Error ? e.message : String(e)}\n`)
  }
  process.exit(0)
}

main()
