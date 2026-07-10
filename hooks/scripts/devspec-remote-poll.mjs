#!/usr/bin/env node
/**
 * devspec-remote-poll — background long-poller for DevSpec remote control.
 *
 * Runs outside the model context. Heartbeats the session, polls transcript,
 * and **exits 0 only when a new owner-authored human message arrives**, printing
 * those messages as JSON lines so the agent can re-invoke and act.
 *
 * Usage (from skill, background):
 *   node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/devspec-remote-poll.mjs" \
 *     --session <uuid> [--interval-ms 5000] [--heartbeat-ms 15000] [--max-ms 600000]
 *
 * Exit codes:
 *   0  — owner message(s) arrived (agent should wake and process)
 *   1  — disabled / offline / auth failure / error (do not treat as instruction)
 *   2  — bad args
 *
 * Requires token in ~/.devspec/remote-control.json (from remote-control-state.mjs write)
 * or DEVSPEC_MCP_TOKEN env.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mcpToolsCall } from './mcp-call.mjs'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'

const STATE_PATH = path.join(os.homedir(), '.devspec', 'remote-control.json')

function parseArgs(argv) {
  const out = {
    intervalMs: 5000,
    heartbeatMs: 15000,
    maxMs: 10 * 60 * 1000, // re-exit after 10m so the skill can re-arm if needed
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--session' || a === '--session_id') out.session = argv[++i]
    else if (a === '--interval-ms') out.intervalMs = Number(argv[++i])
    else if (a === '--heartbeat-ms') out.heartbeatMs = Number(argv[++i])
    else if (a === '--max-ms') out.maxMs = Number(argv[++i])
    else if (a === '--cursor') out.cursor = argv[++i]
    else if (a === '--owner-user-id') out.ownerUserId = argv[++i]
  }
  return out
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return null
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function isOwnerMessage(msg, ownerUserId) {
  if (!msg) return false
  // Human messages only
  if (msg.role !== 'user') return false
  if (msg.message_type && msg.message_type !== 'user' && msg.message_type !== null) {
    // allow plain user messages; skip local_agent_handoff etc if any
    if (msg.message_type !== 'text' && msg.message_type !== 'user') {
      // still treat standard user role as instruction
    }
  }
  const author = msg.author
  if (author?.kind && author.kind !== 'human') return false
  if (ownerUserId && author?.user_id && author.user_id !== ownerUserId) return false
  // Prefer owner_user_id from transcript session when available
  return true
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const state = readState()
  const sessionId = args.session || state?.session_id
  if (!sessionId) {
    process.stderr.write('devspec-remote-poll: missing --session and no state file session_id\n')
    process.exit(2)
  }

  if (state && state.enabled === false) {
    process.stderr.write('devspec-remote-poll: remote control disabled in state file\n')
    process.exit(1)
  }

  let token = state?.token || null
  let mcpUrl = state?.mcp_url || null
  if (!token) {
    const auth = resolveDevspecMcpAuth(state?.cwd || process.cwd())
    token = auth.token
    mcpUrl = mcpUrl || auth.mcp_url
  }
  if (!token) {
    process.stderr.write(
      'devspec-remote-poll: no token. Run remote-control-state.mjs write after connect, or set DEVSPEC_MCP_TOKEN.\n',
    )
    process.exit(1)
  }
  mcpUrl = mcpUrl || 'https://devspec.ai/api/mcp'
  const agentName = state?.agent_name || 'Claude Code'

  let cursor = args.cursor || state?.cursor_after_message_id || null
  let ownerUserId = args.ownerUserId || state?.owner_user_id || null
  let lastHeartbeat = 0
  const started = Date.now()

  // Initial transcript to seed cursor + owner id
  try {
    const initial = await mcpToolsCall({
      mcpUrl,
      token,
      name: 'get_session_transcript',
      arguments: {
        session_id: sessionId,
        ...(cursor ? { after_message_id: cursor } : {}),
      },
    })
    if (initial?.owner_user_id) ownerUserId = initial.owner_user_id
    if (initial?.cursor?.next_after_message_id) {
      // If no cursor yet, jump to end so we only wake on NEW messages
      if (!cursor) cursor = initial.cursor.next_after_message_id
    }
    // If we had a cursor and there are already owner messages, exit immediately
    const msgs = Array.isArray(initial?.messages) ? initial.messages : []
    const ownerMsgs = msgs.filter((m) => isOwnerMessage(m, ownerUserId))
    if (cursor && ownerMsgs.length > 0) {
      for (const m of ownerMsgs) {
        process.stdout.write(JSON.stringify({ type: 'owner_message', message: m }) + '\n')
      }
      process.stdout.write(
        JSON.stringify({
          type: 'wake',
          reason: 'owner_message',
          count: ownerMsgs.length,
          next_after_message_id: initial?.cursor?.next_after_message_id || cursor,
        }) + '\n',
      )
      process.exit(0)
    }
  } catch (e) {
    process.stderr.write(`devspec-remote-poll: initial transcript failed: ${e.message}\n`)
    process.exit(1)
  }

  while (Date.now() - started < args.maxMs) {
    // Re-read state each loop so /remote-stop can disable us
    const liveState = readState()
    if (liveState && liveState.enabled === false) {
      process.stderr.write('devspec-remote-poll: disabled — exiting\n')
      process.exit(1)
    }

    const now = Date.now()
    if (now - lastHeartbeat >= args.heartbeatMs) {
      try {
        await mcpToolsCall({
          mcpUrl,
          token,
          name: 'report_remote_agent_heartbeat',
          arguments: { session_id: sessionId, agent_name: agentName, status: 'live' },
        })
        lastHeartbeat = now
      } catch (e) {
        process.stderr.write(`devspec-remote-poll: heartbeat failed: ${e.message}\n`)
      }
    }

    try {
      const delta = await mcpToolsCall({
        mcpUrl,
        token,
        name: 'get_session_transcript',
        arguments: {
          session_id: sessionId,
          ...(cursor ? { after_message_id: cursor } : {}),
        },
      })
      if (delta?.owner_user_id) ownerUserId = delta.owner_user_id
      const msgs = Array.isArray(delta?.messages) ? delta.messages : []
      const ownerMsgs = msgs.filter((m) => isOwnerMessage(m, ownerUserId))
      if (ownerMsgs.length > 0) {
        for (const m of ownerMsgs) {
          process.stdout.write(JSON.stringify({ type: 'owner_message', message: m }) + '\n')
        }
        const next = delta?.cursor?.next_after_message_id || ownerMsgs[ownerMsgs.length - 1]?.id
        process.stdout.write(
          JSON.stringify({
            type: 'wake',
            reason: 'owner_message',
            count: ownerMsgs.length,
            next_after_message_id: next,
          }) + '\n',
        )
        // Persist cursor into state for next arm
        try {
          const s = readState() || {}
          s.cursor_after_message_id = next
          s.owner_user_id = ownerUserId
          s.updated_at = new Date().toISOString()
          fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
        } catch {
          /* ignore */
        }
        process.exit(0)
      }
      if (delta?.cursor?.next_after_message_id) {
        cursor = delta.cursor.next_after_message_id
      }
    } catch (e) {
      process.stderr.write(`devspec-remote-poll: poll failed: ${e.message}\n`)
    }

    await sleep(args.intervalMs)
  }

  // Timed out without owner message — exit 1 so skill can re-arm without treating as instruction
  process.stderr.write('devspec-remote-poll: max wait reached without owner message — re-arm\n')
  process.exit(1)
}

main().catch((e) => {
  process.stderr.write(`devspec-remote-poll: ${e.message}\n`)
  process.exit(1)
})
