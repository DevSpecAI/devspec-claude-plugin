import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function artifactVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
    return manifest.name === 'devspec' && typeof manifest.version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+\/-]{0,63}$/.test(manifest.version) ? manifest.version : undefined
  } catch { return undefined }
}

// The cache/checkout containing this executing module is authoritative for the
// report. Never use cwd, a parent host's environment, or a later manifest read.
export const LOADED_PLUGIN_VERSION = artifactVersion()
export function versionedConnectionArguments(name, args = {}) {
  if (name !== 'register_connection' && name !== 'attach_connection') return args
  const { plugin_version: _plugin, host_version: _host, ...rest } = args
  // Claude's documented common hook input has no reliable host-version field.
  return { ...rest, ...(LOADED_PLUGIN_VERSION ? { plugin_version: LOADED_PLUGIN_VERSION } : {}) }
}

export function connectionVersionHook(input) {
  const match = /^mcp__(?:plugin_devspec_)?devspec__(register_connection|attach_connection)$/.exec(input?.tool_name ?? '')
  if (!match || !input.tool_input || typeof input.tool_input !== 'object' || Array.isArray(input.tool_input)) return {}
  return { hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    updatedInput: versionedConnectionArguments(match[1], input.tool_input),
    // No permissionDecision: normal permission checks and other hooks still apply.
  } }
}

let isMain = false
try { isMain = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch {}
if (isMain) {
  try { process.stdout.write(JSON.stringify(connectionVersionHook(JSON.parse(readFileSync(0, 'utf8'))))) }
  catch { /* Optional metadata must not block a call on malformed hook input. */ }
}
