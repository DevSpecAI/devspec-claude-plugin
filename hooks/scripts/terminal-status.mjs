/**
 * What the DevSpec line under Claude Code's prompt says (item c6dcb524).
 *
 * Since auto-connect at startup a terminal joins DevSpec without a model turn, and
 * the terminal showed nothing at all: not the codename the Agents page lists it by,
 * not the room it is attached to, not that someone ended it from DevSpec. The
 * function-hooks module `hooks/terminal-status.ts` draws this line with Claude
 * Code's `$.ui.status` and `$.ui.toast`, which cost no model call.
 *
 * PURE ON PURPOSE: no Node built-ins. The hooks module runs in Claude Code's plugin
 * environment, which has no Node, and imports this file; `node --test` imports the
 * same file. So the paths, the reading and the copy are defined once.
 *
 * Everything is READ from state the plugin's Node side already writes for this
 * conversation, and nothing is written back:
 *   - the bond      `local/claude-code/<conversation id>.json` → which connection
 *   - the connection `connections/<connection id>.json`        → codename, room, end
 *   - the project   `local/claude-code/projects/<sha256>.json`  → project name
 * Going bond → connection by id is deliberate: a developer machine holds hundreds
 * of connection files, so the line never scans the directory.
 */

/** How often the line re-reads that state. A UI End reaches the connection file on
 * the poller's next poll, so the line trails it by at most this much more. */
export const STATUS_REFRESH_MS = 2_000

/** `agentSlug('Claude Code')` in remote-control-state.mjs: the bond directory. */
const AGENT_DIR = 'claude-code'

/** The command a person runs to connect this conversation again. */
const CONNECT_COMMAND = '/devspec:devspec.remote'

const REMOTE_DIR = '.devspec/remote-control'

export function bondPath(home, conversationId) {
  return `${home}/${REMOTE_DIR}/local/${AGENT_DIR}/${conversationId}.json`
}

export function connectionStatePath(home, connectionId) {
  return `${home}/${REMOTE_DIR}/connections/${connectionId}.json`
}

/** Where terminal-wait.mjs remembers a terminal wait (its waitStatePath), for the module. */
export function terminalWaitPath(home, connectionId) {
  return `${home}/${REMOTE_DIR}/connections/${connectionId}.terminal-wait.json`
}

/** The connection a conversation is bound to, from its bond file, or null. Node-free. */
export async function boundConnectionId({ home, conversationId, readText }) {
  if (typeof home !== 'string' || !home || typeof conversationId !== 'string' || !SAFE_ID_RE.test(conversationId)) {
    return null
  }
  const connectionId = parseJson(await readText(bondPath(home, conversationId)))?.connection_id
  return typeof connectionId === 'string' && UUID_RE.test(connectionId) ? connectionId : null
}

/** conversation-project.mjs keys this file by sha256(conversation id), in hex. */
export function conversationProjectPath(home, conversationDigestHex) {
  return `${home}/${REMOTE_DIR}/local/${AGENT_DIR}/projects/${conversationDigestHex}.json`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Conversation ids become file names; the bond writer keeps only these characters.
const SAFE_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/

/**
 * A title the line may show as the room's name. Generated titles arrive after the
 * first real message, and "New session" is the placeholder before that, the same
 * rule the web UI and the Pi footer use (item 23f4665f).
 */
export function isRealSessionTitle(title) {
  if (typeof title !== 'string') return false
  const trimmed = title.trim()
  return trimmed.length > 0 && trimmed !== 'New session'
}

/**
 * One line of plain text. Room titles and codenames are written by people and by
 * the server, so control characters (which a terminal would act on) and line
 * breaks are removed rather than drawn.
 */
export function cleanLabel(text) {
  if (typeof text !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** DevSpec's short code for an item: the first eight characters of its id. */
export function shortCode(id) {
  return typeof id === 'string' ? id.slice(0, 8).toLowerCase() : ''
}

function parseJson(text) {
  if (typeof text !== 'string') return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/**
 * How this conversation stands with DevSpec, from the files above.
 *
 * `readText(path)` resolves a file's text or null; `sha256Hex(text)` resolves the
 * digest the project file is named by. Resolves null when this conversation has no
 * connection at all, which draws no line: a folder that is not a DevSpec project
 * says nothing about DevSpec.
 */
export async function readConnectionView({ home, conversationId, readText, sha256Hex }) {
  if (typeof home !== 'string' || !home || typeof conversationId !== 'string' || !SAFE_ID_RE.test(conversationId)) {
    return null
  }
  const bond = parseJson(await readText(bondPath(home, conversationId)))
  const connectionId = bond?.connection_id
  if (typeof connectionId !== 'string' || !UUID_RE.test(connectionId)) return null
  const connection = parseJson(await readText(connectionStatePath(home, connectionId)))
  if (!connection || connection.connection_id !== connectionId) return null

  const codename = cleanLabel(connection.session_codename || connection.codename || bond.session_codename || '')
  const endReason = typeof connection.end_reason === 'string' ? connection.end_reason : null
  // The server's word for an Agents-page End is 'ui'; the poller's own older label
  // is 'ended_from_ui'. Either, or the flag, is a person ending it from DevSpec.
  const endedFromUi = connection.ended_from_ui === true || endReason === 'ui' || endReason === 'ended_from_ui'
  const state = endedFromUi ? 'ended_from_devspec' : connection.enabled === false ? 'disconnected' : 'connected'

  let projectName = ''
  try {
    const project = parseJson(await readText(conversationProjectPath(home, await sha256Hex(conversationId))))
    if (project?.status === 'selected' && project.local_id === conversationId) projectName = cleanLabel(project.project?.name || '')
  } catch {
    /* no project name is a shorter line, not a missing one */
  }

  const sessionId = state === 'connected' && typeof connection.session_id === 'string' && connection.session_id
    ? connection.session_id
    : null
  // The title belongs to the room it was read for. A title the poller has not
  // re-read since a reattach would name the previous room.
  const sessionTitle = sessionId && connection.session_title_for === sessionId && isRealSessionTitle(connection.session_title)
    ? cleanLabel(connection.session_title)
    : ''

  return { connectionId, state, codename, projectName, sessionId, sessionTitle }
}

/**
 * The line itself, or undefined for none. Claude Code leads a plugin's line with
 * the plugin's name, so it shows as:
 *
 *   devspec: Cosmic Raven · DevSpec · “Fix the login redirect” · working on c6dcb524
 *   devspec: Cosmic Raven · ended from DevSpec
 *
 * `work` is the item ids this conversation holds claimed, oldest first.
 */
export function formatStatusLine(view, work = []) {
  if (!view) return undefined
  const name = view.codename || 'connected'
  if (view.state === 'ended_from_devspec') return `${name} · ended from DevSpec`
  if (view.state === 'disconnected') return `${name} · disconnected`
  const parts = [name]
  if (view.projectName) parts.push(view.projectName)
  if (view.sessionId) parts.push(view.sessionTitle ? `“${view.sessionTitle}”` : 'untitled session')
  if (work.length > 0) {
    const latest = work[work.length - 1]
    parts.push(`working on ${shortCode(latest)}${work.length > 1 ? ` +${work.length - 1}` : ''}`)
  }
  return parts.join(' · ')
}

/**
 * A one-off notice for a change worth interrupting for, or undefined.
 *
 * Only a change this module SAW is announced: the first reading after a launch
 * sets the baseline silently, so reopening a terminal whose connection was
 * already ended does not announce it again (the line already says so).
 */
export function transitionToast(previous, view) {
  if (previous === undefined) return undefined
  const was = previous?.state ?? null
  const now = view?.state ?? null
  if (was === now && previous?.connectionId === view?.connectionId) return undefined
  const name = view?.codename || 'This terminal'
  if (now === 'connected' && (was !== 'connected' || previous?.connectionId !== view.connectionId)) {
    return `Connected to DevSpec as ${name}.`
  }
  if (was === 'connected' && now === 'ended_from_devspec') {
    return `${name} was ended from DevSpec. Run ${CONNECT_COMMAND} to connect again.`
  }
  if (was === 'connected' && now === 'disconnected') {
    return `${name} disconnected from DevSpec. Run ${CONNECT_COMMAND} to connect again.`
  }
  return undefined
}

const CLAIM_VERB = 'claim_work_item'
const RELEASE_VERBS = new Set(['record_implementation', 'fail_work_item', 'release_work_item'])

/** The DevSpec verb a tool name calls (`mcp__plugin_devspec_devspec__claim_work_item`
 * from this plugin's server, `mcp__devspec__claim_work_item` from a hand-configured
 * one), or null for any other tool. */
export function devspecVerb(toolName) {
  const match = /^mcp__(?:plugin_devspec_)?devspec__([a-z_]+)$/.exec(String(toolName || ''))
  return match ? match[1] : null
}

/**
 * How a finished tool call changes the items this conversation holds claimed:
 * `{ add: id }`, `{ remove: id }`, or null. Only a call DevSpec answered without
 * an error counts, so a refused claim never shows as work in hand.
 */
export function workChange({ tool, input, resultText, isError }) {
  const verb = devspecVerb(tool)
  if (verb !== CLAIM_VERB && !RELEASE_VERBS.has(verb)) return null
  if (isError === true) return null
  const answer = parseJson(resultText)
  if (!answer || answer.error || answer.success === false || answer.ok === false) return null
  const requested = typeof input?.action_item_id === 'string' ? input.action_item_id.toLowerCase() : null
  if (verb === CLAIM_VERB) {
    if (answer.claim_success === false) return null
    const id = typeof answer.id === 'string' ? answer.id.toLowerCase() : requested
    return id && UUID_RE.test(id) ? { add: id } : null
  }
  return requested && UUID_RE.test(requested) ? { remove: requested } : null
}

/** Apply a workChange to the ordered list of claimed ids. */
export function applyWorkChange(work, change) {
  if (!change) return work
  if (change.add) return [...work.filter((id) => id !== change.add), change.add]
  if (change.remove) return work.filter((id) => id !== change.remove)
  return work
}
