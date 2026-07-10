#!/usr/bin/env node
/**
 * DevSpec remote-control mirror hook (Stop / UserPromptSubmit).
 * Uses token from ~/.devspec/remote-control.json or resolve-mcp-auth.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mcpToolsCall } from './mcp-call.mjs'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'

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
  let data
  try {
    data = JSON.parse(hookInput || '{}')
  } catch {
    return null
  }

  if (which === 'user_prompt') {
    return data.prompt || data.user_prompt || data.message || null
  }

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

async function main() {
  const state = loadState()
  if (!state) process.exit(0)

  let token = state.token
  let mcpUrl = state.mcp_url
  if (!token) {
    const auth = resolveDevspecMcpAuth(state.cwd || process.cwd())
    token = auth.token
    mcpUrl = mcpUrl || auth.mcp_url
  }
  if (!token) process.exit(0) // silent — skill still posts instructionally

  mcpUrl = mcpUrl || 'https://devspec.ai/api/mcp'
  const agentName = state.agent_name || 'Claude Code'
  const sessionId = state.session_id

  const raw = readStdin()
  const text = extractLastText(raw, mode)

  try {
    if (text && String(text).trim()) {
      const message =
        mode === 'user_prompt'
          ? `👤 **Local prompt:**\n\n${String(text).trim().slice(0, 12000)}`
          : String(text).trim().slice(0, 12000)
      await mcpToolsCall({
        mcpUrl,
        token,
        name: 'post_session_message',
        arguments: { session_id: sessionId, message, agent_name: agentName },
      })
    }
    await mcpToolsCall({
      mcpUrl,
      token,
      name: 'report_remote_agent_heartbeat',
      arguments: { session_id: sessionId, agent_name: agentName, status: 'live' },
    })
  } catch (e) {
    process.stderr.write(`[devspec-remote] ${e instanceof Error ? e.message : String(e)}\n`)
  }
  process.exit(0)
}

main()
