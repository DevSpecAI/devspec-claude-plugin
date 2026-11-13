#!/usr/bin/env node
/**
 * Automatic conversational recall, at the turn's tail (item 08f036e5; host delivery
 * contract 7c87f509; decision 3ea02bd2).
 *
 * Before a substantive turn starts, this asks DevSpec which of the project's records
 * bear on what was just asked: standing documents, memories, plans and rejected
 * ideas, past shipped work, and every requirement that applies. DevSpec chooses and
 * writes the cards (`POST <server>/turn-recall`); this file never looks inside them.
 * It hands the block over verbatim, so a kind of record DevSpec adds later reaches
 * the model with no change here.
 *
 * ## Where it runs, and why there are two callers
 *
 * - `prompt-submit`: from the plugin's hooks module (`hooks/turn-recall.ts`), on
 *   `prompt.submit`. The module adds the block as the prompt's `context`: text after
 *   the prompt, at the turn's tail, so everything before it stays byte-identical and
 *   the provider's prompt cache keeps working. It knows where the prompt came from
 *   (`e.origin`), so a /loop firing or another session's message is never mistaken
 *   for a request.
 * - `user-prompt-submit`: the `UserPromptSubmit` command hook, for Claude Code builds
 *   that run no hooks module. On a build that does, the module runs first (its `next`
 *   runs the settings hooks) and leaves a stamp, and this stands down: one prompt,
 *   one recall.
 *
 * ## What counts as a turn worth recalling
 *
 * A prompt a person submitted (typed, from Claude Code's own Remote Control, or an
 * SDK turn) of at least 18 characters that is not a slash command, and a DevSpec
 * command delivered by this plugin's listener (`owner_message`, `automation_run`).
 * Never a check job, system notice, answer or any other wake, a scheduled firing,
 * another session's message, or a tool call: there is no file-edit hook.
 *
 * Claude Code shows the model at most 500 characters of each listener line (item
 * 725d18b2), so a long command's body is cut. The whole text is on the room
 * transcript's line for that `message_id`, and that is what is recalled on. Each
 * command id is recalled once per conversation, however many notifications carry it.
 *
 * ## Seen cards
 *
 * DevSpec leaves out any card whose `kind:id:vN` this conversation was already shown,
 * so an unchanged record appears once and an edited one (a new version) appears
 * again. The keys live in `~/.devspec/recall/claude-code/<conversation>.json`: 0600 in
 * a 0700 directory, replaced atomically, at most 512 keys and 32 KB (oldest dropped
 * first), files untouched for 30 days swept away. Compaction summarises the shown
 * cards out of the conversation, so it clears them (`compacted`, from SessionStart
 * with source `compact`); `/clear` starts a new conversation id and a new file.
 *
 * ## Never in the way
 *
 * Every failure injects nothing and lets the prompt through: signed out, no project
 * for this folder, DevSpec slow or down, a bad answer. The request is abandoned at
 * 2.8 s and the process exits by itself at 3 s, inside the host's limits. The sign-in
 * is read, never renewed here: a renewal cut off by that exit could lose the rotated
 * renewal key, so one that is due runs in its own detached process.
 *
 * The bearer token stays in this process's memory: never on a command line, in the
 * environment of a child, on stdout or in a log.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { activeLogin, loginPrincipal, needsRenewal, readStore, TOKEN_ENV_VAR } from './auth-store.mjs'
import { readConversationProject } from './conversation-project.mjs'
import { findProjectPin, gitRemoteOrigin, workTreeRootFrom } from './devspec-scope.mjs'
import { isEntryPoint } from './entry-point.mjs'
import { PLUGIN_HEADER, pluginHeaderValue } from './mcp-call.mjs'
import { resourceKey } from './oauth.mjs'
import { DEFAULT_PLUGIN_MCP_URL, pluginSettingsFromEnv, readSessionSettings } from './plugin-settings.mjs'
import { readPrivateJsonResult, STATE_OK, writePrivateJson } from './private-state.mjs'

/** Shortest prompt worth a recall: anything shorter is an acknowledgement (7c87f509 minQueryChars; the server skips it too). */
export const MIN_PROMPT_CHARS = 18
/** The request is abandoned here, inside the server's own 2.4 s recall budget plus the trip (7c87f509). */
export const RECALL_HTTP_TIMEOUT_MS = 2_800
/** The process ends itself here whatever is in flight, printing `{}` (7c87f509). */
export const RECALL_HARD_EXIT_MS = 3_000
/** How long the module's stamp tells the command hook the prompt was already handled (7c87f509). */
export const MODULE_STAMP_WINDOW_MS = 10_000
/** Seen keys kept per conversation: the most DevSpec accepts in one request (7c87f509, RECALL_LIMITS.seenKeysPerRequest). */
export const SEEN_MAX_ENTRIES = 512
/** The seen file's size ceiling; the oldest keys go first (7c87f509). */
export const SEEN_MAX_BYTES = 32_768
/** A conversation's file untouched this long is swept away (7c87f509). */
export const SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Command ids remembered as recalled: far more than one notification ever carries. */
const HANDLED_IDS_KEPT = 32
/** Folder scopes DevSpec said have no project, remembered for this conversation. */
const SCOPE_MISSES_KEPT = 8
/** The longest seen key DevSpec accepts (RECALL_LIMITS.seenKeyChars). */
const SEEN_KEY_MAX_CHARS = 120

const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk'])
/** DevSpec's answers that a folder names no single project it can recall for. */
const NO_PROJECT_CODES = new Set(['project_required', 'project_choice_required'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAFE_ID = /^[a-zA-Z0-9._-]{1,128}$/
const SELF = fileURLToPath(import.meta.url)

export function recallDir(home = os.homedir()) {
  return path.join(home, '.devspec', 'recall', 'claude-code')
}

function connectionsDir(home) {
  return path.join(home, '.devspec', 'remote-control', 'connections')
}

export function recallStatePath(conversationId, home = os.homedir()) {
  const id = String(conversationId ?? '').trim()
  const stem = SAFE_ID.test(id) && id !== '.' && id !== '..'
    ? id
    : `conv-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`
  return path.join(recallDir(home), `${stem}.json`)
}

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// The conversation's recall state
// ---------------------------------------------------------------------------

function emptyState(conversationId) {
  return {
    version: 1,
    host: 'claude_code',
    conversation_id: conversationId,
    updated_at: 0,
    module_stamp: null,
    handled_message_ids: [],
    scope_misses: [],
    entries: [],
  }
}

/** The conversation's state, or a fresh one: an unreadable file is never a reason to skip the turn. */
export function loadRecallState(conversationId, { home = os.homedir() } = {}) {
  const read = readPrivateJsonResult(recallStatePath(conversationId, home))
  const value = read.status === STATE_OK ? read.value : null
  if (!value || value.version !== 1 || !Array.isArray(value.entries)) {
    return { ...emptyState(conversationId), fresh: read.status !== STATE_OK }
  }
  const strings = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x) : [])
  return {
    ...emptyState(conversationId),
    updated_at: Number.isFinite(value.updated_at) ? value.updated_at : 0,
    module_stamp: value.module_stamp && Number.isFinite(value.module_stamp.at) ? value.module_stamp : null,
    handled_message_ids: strings(value.handled_message_ids).slice(-HANDLED_IDS_KEPT),
    scope_misses: strings(value.scope_misses).slice(-SCOPE_MISSES_KEPT),
    entries: value.entries.filter((e) => e && typeof e.key === 'string' && e.key && Number.isFinite(e.at)),
    fresh: false,
  }
}

/** Write the state back, bounded: newest keys kept, oldest dropped until it fits. Never throws. */
export function saveRecallState(state, { home = os.homedir(), now = Date.now() } = {}) {
  const { fresh, ...rest } = state
  const out = { ...rest, updated_at: now }
  out.entries = out.entries.slice(-SEEN_MAX_ENTRIES)
  out.handled_message_ids = out.handled_message_ids.slice(-HANDLED_IDS_KEPT)
  out.scope_misses = out.scope_misses.slice(-SCOPE_MISSES_KEPT)
  while (out.entries.length > 0 && Buffer.byteLength(JSON.stringify(out, null, 2), 'utf8') > SEEN_MAX_BYTES) {
    out.entries = out.entries.slice(Math.max(1, Math.floor(out.entries.length / 5)))
  }
  try {
    writePrivateJson(recallStatePath(state.conversation_id, home), out)
    try {
      fs.chmodSync(recallDir(home), 0o700)
    } catch {
      /* the file's own 0600 still applies */
    }
    if (fresh) sweepExpiredRecallFiles({ home, now })
  } catch {
    /* recall state is a convenience: a turn that cannot record it still goes ahead */
  }
}

/** Remove conversations' files untouched for SEEN_TTL_MS. Runs when a conversation's file is first written. */
export function sweepExpiredRecallFiles({ home = os.homedir(), now = Date.now() } = {}) {
  let removed = 0
  let names = []
  try {
    names = fs.readdirSync(recallDir(home))
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(recallDir(home), name)
    try {
      if (now - fs.statSync(file).mtimeMs > SEEN_TTL_MS) {
        fs.rmSync(file, { force: true })
        removed++
      }
    } catch {
      /* gone already, or not ours to judge */
    }
  }
  return removed
}

/** The keys a recall answer shows, in its own words: `seen_keys`, else each card's `dedupe_key`. */
export function shownKeys(payload) {
  const raw = Array.isArray(payload?.seen_keys) && payload.seen_keys.length > 0
    ? payload.seen_keys
    : (Array.isArray(payload?.cards) ? payload.cards.map((card) => card?.dedupe_key ?? card?.seenKey) : [])
  return [...new Set(raw.filter((key) => typeof key === 'string' && key && key.length <= SEEN_KEY_MAX_CHARS))]
}

/** Record keys as shown now: a key seen again moves to the newest end. */
export function recordShown(state, keys, now = Date.now()) {
  const byKey = new Map(state.entries.map((entry) => [entry.key, entry]))
  for (const key of keys) {
    byKey.delete(key)
    byKey.set(key, { key, at: now })
  }
  state.entries = [...byKey.values()]
  return state
}

// ---------------------------------------------------------------------------
// Which turns recall
// ---------------------------------------------------------------------------

function decodeJsonString(fragment) {
  try {
    return JSON.parse(`"${fragment}"`)
  } catch {
    return fragment
  }
}

/**
 * The DevSpec commands in a task notification from this plugin's listener: the
 * `owner_message` and `automation_run` lines, read whole when the line fit, and by
 * their leading fields when Claude Code cut it at 500 characters. Lines from any
 * other background job carry none of these and are ignored.
 */
export function parseDevspecNotification(text) {
  const messageIds = []
  const inlineBodies = []
  const automations = []
  let transcript = null
  let devspecOther = false
  for (const rawLine of String(text ?? '').split('\n')) {
    const start = rawLine.indexOf('{"type":')
    if (start < 0) continue
    const line = rawLine.slice(start).replace(/<\/[a-z-]+>\s*$/i, '').trim()
    let event = null
    try {
      event = JSON.parse(line)
    } catch {
      event = null
    }
    const type = event?.type ?? /^\{"type":"([a-z_]+)"/.exec(line)?.[1] ?? null
    if (type === 'owner_message') {
      const id = event ? event.message_id : /"message_id":"([0-9a-f-]{36})"/i.exec(line)?.[1]
      if (typeof id === 'string' && UUID.test(id) && !messageIds.includes(id)) messageIds.push(id)
      const body = event ? event.body : (() => {
        const match = /"body":"((?:\\.|[^"\\])*)/.exec(line)
        return match ? decodeJsonString(match[1]) : null
      })()
      if (typeof body === 'string' && body.trim()) inlineBodies.push({ id: id ?? null, body: body.trim() })
    } else if (type === 'automation_run') {
      const name = event ? event.dispatch?.automation_name : /"automation_name":"((?:\\.|[^"\\])*)"/.exec(line)?.[1]
      if (typeof name === 'string' && name.trim()) automations.push(event ? name.trim() : decodeJsonString(name).trim())
      else automations.push('')
    } else if (type === 'wake') {
      const pointer = event ? event.transcript : /"transcript":"((?:\\.|[^"\\])+)"/.exec(line)?.[1]
      if (typeof pointer === 'string' && path.isAbsolute(pointer)) transcript = pointer
    } else if (type) {
      devspecOther = true
    }
  }
  const kind = messageIds.length > 0 || inlineBodies.length > 0
    ? 'command'
    : automations.length > 0
      ? 'automation'
      : devspecOther
        ? 'devspec_other'
        : 'foreign'
  return { kind, messageIds, inlineBodies, automations: automations.filter(Boolean), transcript }
}

/**
 * The whole text of each command, from the room transcript's line for its id. Only a
 * file inside the plugin's own connections directory is read.
 */
export function commandBodiesFromTranscript(transcriptFile, messageIds, { home = os.homedir() } = {}) {
  if (!transcriptFile || messageIds.length === 0) return new Map()
  const resolved = path.resolve(transcriptFile)
  if (!resolved.startsWith(`${path.resolve(connectionsDir(home))}${path.sep}`)) return new Map()
  const wanted = new Set(messageIds)
  const found = new Map()
  let raw = ''
  try {
    raw = fs.readFileSync(resolved, 'utf8')
  } catch {
    return found
  }
  for (const line of raw.split('\n')) {
    if (!line.includes('"message_id"')) continue
    try {
      const row = JSON.parse(line)
      if (wanted.has(row?.message_id) && typeof row.text === 'string' && row.text.trim()) found.set(row.message_id, row.text.trim())
    } catch {
      /* a torn line is skipped */
    }
  }
  return found
}

function personDecision(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return { recall: false, reason: 'empty_prompt' }
  if (trimmed.startsWith('/')) return { recall: false, reason: 'slash_command' }
  if (trimmed.length < MIN_PROMPT_CHARS) return { recall: false, reason: 'short_prompt' }
  return { recall: true, reason: 'person_prompt', query: trimmed, messageIds: [] }
}

function notificationDecision(text, state, { transcriptFor, home }) {
  const parsed = parseDevspecNotification(text)
  if (parsed.kind === 'automation') {
    const query = parsed.automations.join('\n\n').trim()
    if (query.length < MIN_PROMPT_CHARS) return { recall: false, reason: 'short_prompt' }
    return { recall: true, reason: 'automation_run', query, messageIds: [] }
  }
  if (parsed.kind !== 'command') return { recall: false, reason: parsed.kind === 'devspec_other' ? 'not_a_command' : 'not_devspec' }
  const fresh = parsed.messageIds.filter((id) => !state.handled_message_ids.includes(id))
  if (parsed.messageIds.length > 0 && fresh.length === 0) return { recall: false, reason: 'command_already_recalled' }
  const transcript = parsed.transcript ?? transcriptFor()
  const whole = commandBodiesFromTranscript(transcript, fresh, { home })
  const bodies = parsed.messageIds.length > 0
    ? fresh.map((id) => whole.get(id) ?? parsed.inlineBodies.find((entry) => entry.id === id)?.body ?? '')
    : parsed.inlineBodies.map((entry) => entry.body)
  const query = bodies.filter(Boolean).join('\n\n').trim()
  if (!query || query.startsWith('/') || query.length < MIN_PROMPT_CHARS) {
    return { recall: false, reason: 'short_prompt', messageIds: fresh }
  }
  return { recall: true, reason: 'devspec_command', query, messageIds: fresh }
}

/**
 * Should this prompt recall, and on what text?
 *
 * `origin` is Claude Code's own stamp from `prompt.submit` (`null` from the command
 * hook, which cannot see it: there a `<task-notification>` is read as a notification
 * and anything else as a person's prompt, which is all an older build can tell).
 */
export function classifyTurn({ origin, text, state, transcriptFor = () => null, home = os.homedir() }) {
  const raw = String(text ?? '')
  if (origin === null || origin === undefined) {
    if (raw.includes('<task-notification>')) return notificationDecision(raw, state, { transcriptFor, home })
    return personDecision(raw)
  }
  if (PERSON_ORIGINS.has(origin)) return personDecision(raw)
  if (origin === 'task-notification') return notificationDecision(raw, state, { transcriptFor, home })
  return { recall: false, reason: `origin_${origin}` }
}

// ---------------------------------------------------------------------------
// Which project, which server, which credential
// ---------------------------------------------------------------------------

function readJsonFile(file) {
  const read = readPrivateJsonResult(file)
  return read.status === STATE_OK && read.value && typeof read.value === 'object' ? read.value : null
}

/** The live connection this conversation is bound to, with its state, or null. */
export function boundConnection(conversationId, { home = os.homedir() } = {}) {
  if (!SAFE_ID.test(String(conversationId ?? ''))) return null
  const bond = readJsonFile(path.join(home, '.devspec', 'remote-control', 'local', 'claude-code', `${conversationId}.json`))
  const connectionId = bond?.connection_id
  if (typeof connectionId !== 'string' || !UUID.test(connectionId)) return null
  const state = readJsonFile(path.join(connectionsDir(home), `${connectionId}.json`))
  if (!state || state.enabled !== true || state.connection_id !== connectionId) return null
  if (state.local_id && state.local_id !== conversationId) return null
  return { connectionId, state }
}

/** The configured DevSpec server for this conversation, without its query string. */
export function configuredServer(conversationId, env = process.env) {
  const fromEnv = env?.[TOKEN_ENV_VAR]?.trim() ? env.DEVSPEC_MCP_URL?.trim() : null
  const url = fromEnv || pluginSettingsFromEnv(env)?.mcp_url || readSessionSettings(conversationId)?.mcp_url || DEFAULT_PLUGIN_MCP_URL
  return stripQuery(url)
}

function stripQuery(url) {
  try {
    const parsed = new URL(url)
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

/** The turn-recall endpoint beside the MCP endpoint: `<server>/api/mcp/turn-recall`. */
export function turnRecallUrl(mcpUrl) {
  const base = stripQuery(mcpUrl)
  return base ? `${base}/turn-recall` : null
}

/**
 * What the recall is for. A bound connection decides it (its capability names the
 * connection, its room and its project); otherwise the conversation's chosen project;
 * otherwise the folder's pin and repository remote for DevSpec to resolve. Null when
 * nothing names a project, or the conversation's project choice is blocked.
 */
export function recallScope({ conversationId, cwd, home = os.homedir(), env = process.env, gitRemote = gitRemoteOrigin, pin = findProjectPin }) {
  const bound = boundConnection(conversationId, { home })
  if (bound) {
    return {
      kind: 'connection',
      connection: bound,
      body: {
        connection_id: bound.connectionId,
        ...(UUID.test(bound.state.session_id ?? '') ? { session_id: bound.state.session_id } : {}),
      },
      capability: typeof bound.state.connection_capability === 'string' && bound.state.connection_capability
        ? bound.state.connection_capability
        : null,
      mcpUrl: stripQuery(bound.state.mcp_url) || configuredServer(conversationId, env),
    }
  }
  const mcpUrl = configuredServer(conversationId, env)
  let choice = null
  try {
    choice = readConversationProject(conversationId, { home })
  } catch {
    return null
  }
  if (choice?.status === 'blocked') return null
  if (choice?.status === 'selected') return { kind: 'project', body: { project_id: choice.project.id }, capability: null, mcpUrl }
  if (!cwd) return null
  const root = workTreeRootFrom(cwd, { home })
  const pinned = root ? pin(cwd, { home, root }) : pin(cwd, { home })
  const remote = root ? gitRemote(cwd) : null
  if (!pinned && !remote) return null
  return {
    kind: 'folder',
    body: { ...(pinned ? { pinned_project_id: pinned.project_id } : {}), ...(remote ? { git_remote: remote } : {}) },
    capability: null,
    mcpUrl,
  }
}

/** A scope's identity, for remembering that DevSpec found no project for it. */
export function scopeFingerprint(scope) {
  return sha256(JSON.stringify({ kind: scope.kind, body: scope.body, server: scope.mcpUrl }))
}

/** Any credential at all on this computer: the environment token or a sign-in that has not ended. Offline. */
export function signedInAnywhere(env = process.env) {
  if (env?.[TOKEN_ENV_VAR]?.trim()) return true
  try {
    return Object.values(readStore().logins ?? {}).some((login) => login && !login.endedAt)
  } catch {
    return false
  }
}

function currentLogin(mcpUrl) {
  const key = resourceKey(mcpUrl)
  const login = key ? readStore().logins?.[key] : null
  return login && !login.endedAt ? login : null
}

/**
 * The token to send, read and never renewed (see the header). `renew` is set when the
 * sign-in is past half its life, so the caller starts the renewal on its own.
 */
export function recallCredential(scope, { env = process.env, now = Date.now() } = {}) {
  const fromEnv = env?.[TOKEN_ENV_VAR]?.trim()
  const state = scope.connection?.state ?? null
  if (state?.auth_source === 'login' && typeof state.principal === 'string' && state.principal) {
    const login = currentLogin(state.mcp_url)
    if (!login || loginPrincipal(login) !== state.principal) return null
    return loginToken(login, scope.mcpUrl, now)
  }
  if (state && typeof state.token === 'string' && state.token.trim()) return { token: state.token.trim(), renew: null }
  if (fromEnv) return { token: fromEnv, renew: null }
  const login = currentLogin(scope.mcpUrl)
  return login ? loginToken(login, scope.mcpUrl, now) : null
}

function loginToken(login, mcpUrl, now) {
  const renew = needsRenewal(login, now) ? mcpUrl : null
  const expires = Date.parse(login.expiresAt)
  if (Number.isFinite(expires) && now >= expires) return { token: null, renew }
  return { token: login.accessToken, renew }
}

/** Renew the sign-in in a process of its own that finishes whatever happens to this one. */
export function startDetachedRenewal(mcpUrl) {
  try {
    const child = spawn(process.execPath, [SELF, 'renew', '--server', mcpUrl], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    /* the next turn tries again */
  }
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/** One POST, abandoned at RECALL_HTTP_TIMEOUT_MS. Resolves `{ ok, status, payload }`; never rejects. */
export async function requestRecall({ url, token, capability, body, fetchImpl = fetch, timeoutMs = RECALL_HTTP_TIMEOUT_MS }) {
  const header = pluginHeaderValue()
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(header ? { [PLUGIN_HEADER]: header } : {}),
        ...(capability ? { 'x-devspec-connection-capability': capability } : {}),
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const refusal = await res.json().catch(() => null)
      return { ok: false, status: res.status, code: typeof refusal?.code === 'string' ? refusal.code : null, payload: null }
    }
    return { ok: true, status: res.status, code: null, payload: await res.json() }
  } catch {
    return { ok: false, status: null, code: null, payload: null }
  }
}

/**
 * One turn's recall. Resolves `{ block }` (the text to add at the turn's tail) or
 * `{ block: null, reason }`; never rejects.
 *
 * `source` is `module` (prompt.submit, with `origin`) or `command_hook`
 * (UserPromptSubmit). `deps` exists for the tests.
 */
export async function runTurnRecall({
  source,
  conversationId,
  text,
  origin = null,
  cwd = process.cwd(),
  home = os.homedir(),
  env = process.env,
  now = Date.now(),
  fetchImpl = fetch,
  timeoutMs = RECALL_HTTP_TIMEOUT_MS,
  renew = startDetachedRenewal,
  gitRemote = gitRemoteOrigin,
  pin = findProjectPin,
} = {}) {
  if (typeof conversationId !== 'string' || !conversationId.trim()) return { block: null, reason: 'no_conversation' }
  // Signed in nowhere and not connected: both callers reach the same answer, so nothing is written either.
  if (!signedInAnywhere(env) && !boundConnection(conversationId, { home })) return { block: null, reason: 'signed_out' }
  const state = loadRecallState(conversationId, { home })

  if (source === 'command_hook') {
    if (state.module_stamp && now - state.module_stamp.at >= 0 && now - state.module_stamp.at <= MODULE_STAMP_WINDOW_MS) {
      return { block: null, reason: 'handled_by_module' }
    }
  } else {
    // Written before anything slow, so the command hook beneath always finds it.
    state.module_stamp = { prompt_hash: sha256(text ?? ''), at: now }
  }

  const decision = classifyTurn({
    origin: source === 'command_hook' ? null : origin,
    text,
    state,
    home,
    transcriptFor: () => {
      const bound = boundConnection(conversationId, { home })
      const sessionId = bound?.state?.session_id
      return bound && UUID.test(sessionId ?? '') ? path.join(connectionsDir(home), `${bound.connectionId}.${sessionId}.transcript.jsonl`) : null
    },
  })
  if (decision.messageIds?.length) {
    state.handled_message_ids = [...state.handled_message_ids, ...decision.messageIds]
  }
  saveRecallState(state, { home, now })
  if (!decision.recall) return { block: null, reason: decision.reason }

  const scope = recallScope({ conversationId, cwd, home, env, gitRemote, pin })
  if (!scope?.mcpUrl) return { block: null, reason: 'no_project' }
  const fingerprint = scopeFingerprint(scope)
  if (state.scope_misses.includes(fingerprint)) return { block: null, reason: 'no_project' }

  const credential = recallCredential(scope, { env, now })
  if (credential?.renew) renew(credential.renew)
  if (!credential?.token) return { block: null, reason: 'signed_out' }

  const url = turnRecallUrl(scope.mcpUrl)
  if (!url) return { block: null, reason: 'no_server' }
  const answer = await requestRecall({
    url,
    token: credential.token,
    capability: scope.capability,
    fetchImpl,
    timeoutMs,
    body: {
      query: decision.query,
      host: 'claude_code',
      conversation_id: conversationId,
      ...scope.body,
      seen_versions: state.entries.map((entry) => entry.key).slice(-SEEN_MAX_ENTRIES),
    },
  })
  if (!answer.ok) {
    // DevSpec found no project for this folder: don't ask again in this conversation.
    // Anything else (a retryable lookup, a bad request, auth, an outage) is asked again next turn.
    if (answer.status === 400 && scope.kind === 'folder' && NO_PROJECT_CODES.has(answer.code)) {
      const latest = loadRecallState(conversationId, { home })
      latest.scope_misses = [...latest.scope_misses.filter((miss) => miss !== fingerprint), fingerprint]
      saveRecallState(latest, { home, now })
    }
    return { block: null, reason: answer.status ? `http_${answer.status}` : 'unreachable' }
  }
  const block = typeof answer.payload?.formatted_block === 'string' ? answer.payload.formatted_block.trim() : ''
  if (!block) return { block: null, reason: 'nothing_relevant' }
  const latest = loadRecallState(conversationId, { home })
  saveRecallState(recordShown(latest, shownKeys(answer.payload), now), { home, now })
  return { block, reason: 'recalled' }
}

/** Compaction summarised the shown cards away: let them be shown again. */
export function clearShownOnCompaction(conversationId, { home = os.homedir(), now = Date.now() } = {}) {
  if (typeof conversationId !== 'string' || !conversationId.trim()) return false
  const state = loadRecallState(conversationId, { home })
  if (state.fresh) return false
  state.entries = []
  saveRecallState(state, { home, now })
  return true
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function finish(out) {
  process.stdout.write(`${JSON.stringify(out)}\n`)
  process.exit(0)
}

async function main(argv) {
  const command = argv[0]
  if (command === 'renew') {
    const server = argv[argv.indexOf('--server') + 1]
    if (argv.includes('--server') && server) await activeLogin(server, { lockWaitMs: 15_000 }).catch(() => null)
    process.exit(0)
  }

  // Whatever is still in flight at RECALL_HARD_EXIT_MS, the prompt goes ahead without recall.
  const hardExit = setTimeout(() => finish({}), RECALL_HARD_EXIT_MS)
  hardExit.unref()
  const input = readStdinJson()

  if (command === 'compacted') {
    if (input?.source === 'compact') clearShownOnCompaction(input.session_id)
    finish({})
  }
  if (command === 'prompt-submit') {
    const result = await runTurnRecall({
      source: 'module',
      conversationId: input.conversation_id,
      text: input.text,
      origin: typeof input.origin === 'string' ? input.origin : null,
    }).catch(() => ({ block: null }))
    finish(result.block ? { context: result.block } : {})
  }
  if (command === 'user-prompt-submit') {
    const result = await runTurnRecall({
      source: 'command_hook',
      conversationId: input.session_id,
      text: input.prompt,
      cwd: typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd(),
    }).catch(() => ({ block: null }))
    finish(result.block
      ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: result.block } }
      : {})
  }
  finish({})
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => finish({}))
}
