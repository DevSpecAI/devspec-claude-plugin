/** One PreToolUse input writer: scope and version stamps must not race each other. */
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { versionedConnectionArguments, connectionVersionHook } from './connection-version.mjs'
import { conversationScopeHook } from './conversation-project.mjs'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'

export function prepareDevspecToolInput(input, { env = process.env, home } = {}) {
  const match = /^mcp__(?:plugin_devspec_)?devspec__(.+)$/.exec(input?.tool_name ?? '')
  if (!match || !input.tool_input || typeof input.tool_input !== 'object' || Array.isArray(input.tool_input)) return {}
  if (typeof input.session_id !== 'string' || !input.session_id) return connectionVersionHook(input)
  const endpoint = input.tool_name.startsWith('mcp__plugin_devspec_') && env.CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL
    ? env.CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL
    : resolveDevspecMcpAuth(input.cwd || process.cwd(), { env }).mcp_url
  const scoped = conversationScopeHook(input, { endpoint, home })
  if (scoped?.hookSpecificOutput?.permissionDecision === 'deny') return scoped
  if (!scoped && match[1] !== 'register_connection' && match[1] !== 'attach_connection') return {}
  return { hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    updatedInput: versionedConnectionArguments(match[1], scoped?.hookSpecificOutput?.updatedInput ?? input.tool_input),
    // No allow decision: the host's ordinary permissions and other hooks still apply.
  } }
}
let main = false
try { main = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch {}
if (main) {
  try { process.stdout.write(JSON.stringify(prepareDevspecToolInput(JSON.parse(readFileSync(0, 'utf8'))))) }
  catch { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'DevSpec could not safely read this conversation’s project scope. Reconnect or start a fresh conversation.' } })) }
}
