/**
 * The requests this connection is carrying, and which one each turn and write
 * serves (item 7a4d04fd, DevSpec design "the request chain").
 *
 * A request is something a person asked this agent for: a room command, or a
 * prompt its owner typed at this terminal. Work the agent does when something it
 * started wakes it — a background command, a subagent, a workflow, a monitor, a
 * scheduled wake or a loop — continues the request that started it. Two people's
 * work on one agent is never credited to each other, and a wake that continues
 * nobody's request is the agent's own initiative.
 *
 * DevSpec cannot tell these apart from the connection's state, which holds one
 * current request, so every DevSpec write names the request it serves
 * (`request_ref`, stamped by devspec-tool-input.mjs) and the server keeps which
 * requests are open (`report_request`, opened and closed here with the
 * connection's capability). A write naming nothing is refused by DevSpec when
 * several people's requests are open.
 *
 * One append-only log per connection, `<connection>.requests.jsonl`, written by
 * the poller (commands) and the hooks (prompts, launches, wakes, Stop). Appended,
 * never rewritten, for the reason the turn-owned log is: parallel tool calls
 * finish together, and a read-modify-write would drop one of them.
 *
 * Imports only Node built-ins (DEVELOPMENT.md).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY = /^[A-Za-z0-9_-]{1,128}$/

/** A status the host reports once a background job has ended (background-work.mjs). */
const ENDED_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error'])

/** The ref a turn that continues nobody's request carries. */
export const NO_REQUEST = 'none'

/**
 * A turn whose request is not known here (a command or a prompt DevSpec did not
 * open a request for): its writes name nothing, so DevSpec resolves who asked as
 * it did before requests existed, never as an earlier request's.
 */
export const UNSTATED = 'unstated'

export function requestLogPath(connectionId, dir) {
  return path.join(dir, `${connectionId}.requests.jsonl`)
}

/** Append one event. Returns false when it could not be written. */
export function appendRequestEvent(connectionId, event, { dir, now = Date.now() } = {}) {
  if (!connectionId || !event?.op) return false
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(requestLogPath(connectionId, dir), `${JSON.stringify({ ...event, at: new Date(now).toISOString() })}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * The connection's requests as the log describes them. Pure over the log's text,
 * so tests run it directly.
 *
 * @returns {{
 *   open: Map<string, { kind: string, message_id?: string, provenance_ref?: string }>,
 *   launches: Map<string, { request: string, kind: string, notifies: boolean, notified: boolean, alias?: string }>,
 *   schedules: Array<{ prompt: string, request: string, id: string|null }>,
 *   current: string|null,
 *   joined: Set<string>,
 *   chosen: boolean,
 * }}
 *
 * `joined` holds the requests that reached the agent during the current turn
 * besides the one it was woken for, and `chosen` says the agent itself named the
 * current one (`serve`), which settles which of them its writes serve.
 */
export function reduceRequestLog(text) {
  const open = new Map()
  const launches = new Map()
  const aliases = new Map()
  const schedules = []
  let current = null
  let joined = new Set()
  let chosen = false
  for (const line of String(text || '').split('\n')) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue // a torn line is not an event
    }
    switch (event?.op) {
      case 'open':
        if (UUID.test(event.id ?? '')) {
          open.set(event.id, {
            kind: event.kind,
            ...(event.message_id ? { message_id: event.message_id } : {}),
            ...(event.provenance_ref ? { provenance_ref: event.provenance_ref } : {}),
            ...(event.requested_by ? { requested_by: event.requested_by } : {}),
          })
        }
        break
      case 'close':
        open.delete(event.id)
        joined.delete(event.id)
        if (current === event.id) current = null
        break
      case 'joined':
        if (UUID.test(event.id ?? '') && event.id !== current) {
          joined.add(event.id)
          chosen = false
        }
        break
      case 'serve':
        // The agent named the request its writes now serve, until something else
        // reaches it.
        if (event.ref === NO_REQUEST || UUID.test(event.ref ?? '')) {
          current = event.ref
          chosen = true
        }
        break
      case 'launch':
        if (KEY.test(event.key ?? '') && launchedFor(event.request)) {
          launches.set(event.key, { request: event.request, also: uuids(event.also), kind: String(event.kind || 'unknown'), notifies: event.notifies !== false, notified: false })
          if (KEY.test(event.alias ?? '')) aliases.set(event.alias, event.key)
        }
        break
      case 'notified': {
        const key = launches.has(event.key) ? event.key : aliases.get(event.key)
        const launch = key ? launches.get(key) : null
        if (launch) launch.notified = true
        break
      }
      case 'schedule':
        if (typeof event.prompt === 'string' && event.prompt.trim() && launchedFor(event.request)) {
          schedules.push({ prompt: event.prompt.trim(), request: event.request, also: uuids(event.also), id: KEY.test(event.id ?? '') ? event.id : null })
        }
        break
      case 'current':
        // A new turn: what it carries starts again from the request that woke it.
        current = event.ref === NO_REQUEST || UUID.test(event.ref ?? '') ? event.ref : null
        joined = new Set()
        chosen = false
        break
      default:
        break
    }
  }
  // An alias (the launching tool call's id) finds the same launch as its job id.
  for (const [alias, key] of aliases) if (!launches.has(alias) && launches.has(key)) launches.set(alias, launches.get(key))
  return { open, launches, schedules, current, joined, chosen }
}

/** What a launch can be recorded as serving: a request, nobody's, or not known. */
function launchedFor(request) {
  return request === NO_REQUEST || request === UNSTATED || UUID.test(request ?? '')
}

function uuids(value) {
  return Array.isArray(value) ? value.filter((id) => UUID.test(id ?? '')) : []
}

export function readRequestState(connectionId, { dir } = {}) {
  let text = ''
  try {
    text = fs.readFileSync(requestLogPath(connectionId, dir), 'utf8')
  } catch {
    /* no log yet: nothing open */
  }
  return reduceRequestLog(text)
}

/**
 * Open a request on DevSpec and record it. `call(args)` performs report_request
 * with the connection capability and returns the parsed result. A command already
 * open here (or, on DevSpec, under another id) is the request it already is.
 *
 * @returns {Promise<string|null>} the request id, or null when DevSpec refused it
 */
export async function openRequest({ connectionId, kind, provenanceRef = null, messageId = null, call, dir, id = randomUUID() }) {
  if (!connectionId || (kind !== 'command' && kind !== 'typed_prompt')) return null
  if (kind === 'command') {
    if (!UUID.test(provenanceRef ?? '')) return null
    for (const [existing, info] of readRequestState(connectionId, { dir }).open) {
      if (info.provenance_ref === provenanceRef) return existing
    }
  }
  let result
  try {
    result = await call({
      connection_id: connectionId,
      action: 'open',
      request_id: id,
      kind,
      ...(kind === 'command' ? { provenance_ref: provenanceRef } : {}),
    })
  } catch {
    return null
  }
  const requestId = UUID.test(result?.request_id ?? '') ? result.request_id : null
  if (!requestId || result.status !== 'open') return null
  appendRequestEvent(connectionId, {
    op: 'open', id: requestId, kind,
    ...(kind === 'command' ? { provenance_ref: provenanceRef } : {}),
    ...(UUID.test(messageId ?? '') ? { message_id: messageId } : {}),
    ...(UUID.test(result.requested_by_user_id ?? '') ? { requested_by: result.requested_by_user_id } : {}),
  }, { dir })
  // A request that arrives while another is being worked joins the turn: the agent
  // may act on it before the turn ends, so the turn now carries both (turnAmbiguity).
  appendRequestEvent(connectionId, { op: 'joined', id: requestId }, { dir })
  return requestId
}

/**
 * Close a request whose work is finished. It is recorded closed here whether or
 * not DevSpec answered: a request this host no longer carries must never be
 * stamped on a write again, and DevSpec closes every open request with the
 * connection anyway.
 */
export async function closeRequest({ connectionId, requestId, reason = 'host_finished', call, dir }) {
  if (!connectionId || !UUID.test(requestId ?? '')) return false
  try {
    await call({ connection_id: connectionId, action: 'close', request_id: requestId, reason })
  } catch {
    /* recorded closed below regardless */
  }
  return appendRequestEvent(connectionId, { op: 'close', id: requestId }, { dir })
}

export function setCurrentRequest(connectionId, ref, { dir } = {}) {
  if (ref === UNSTATED) return appendRequestEvent(connectionId, { op: 'current', ref: null }, { dir })
  if (ref !== NO_REQUEST && !UUID.test(ref ?? '')) return false
  return appendRequestEvent(connectionId, { op: 'current', ref }, { dir })
}

function tag(text, name) {
  const match = String(text || '').match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`))
  return match ? match[1] : null
}

/** The DevSpec command message ids a listener wake carries, oldest first. */
function ownerMessageIds(text) {
  const ids = []
  for (const line of String(text || '').split('\n')) {
    const start = line.indexOf('{')
    if (start < 0 || !line.includes('owner_message')) continue
    try {
      const event = JSON.parse(line.slice(start))
      if (event?.type === 'owner_message' && UUID.test(event.message_id ?? '')) ids.push(event.message_id)
    } catch {
      const match = line.match(/"message_id":"([0-9a-f-]{36})"/i)
      if (match && UUID.test(match[1])) ids.push(match[1])
    }
  }
  return ids
}

/**
 * Which request a turn that something woke continues, from Claude Code's own
 * stamp of where the prompt came from (`e.origin`) and its text.
 *
 * - A DevSpec command (the listener's owner_message) is that command's request.
 * - An automation run DevSpec dispatched is nobody's request: the run's.
 * - A background job's notification is the request that launched it.
 * - A scheduled firing is the request whose ScheduleWakeup, CronCreate or /loop
 *   recorded that prompt.
 * - A notification or firing nothing here launched continues nobody's request.
 *
 * `also` is the other open requests the wake carries: the other commands in one
 * wake, or the requests a job's launching turn was carrying without saying which
 * it served. They join the turn, so a write that could serve more than one
 * person's request is refused until the agent names one (turnAmbiguity).
 *
 * @returns {{ ref: string|null, also: string[] }} ref is a request id,
 *   NO_REQUEST, UNSTATED, or null when this kind of turn does not change which
 *   request is current
 */
export function requestForWake({ origin, text, state }) {
  const kind = typeof origin === 'string' ? origin : origin?.kind
  // Nobody's request only when the launch was positively made for nobody; a launch
  // whose request has finished or was never known is unstated, never guessed.
  const carried = (entry) => ({
    ref: state.open.has(entry.request) || entry.request === NO_REQUEST ? entry.request : UNSTATED,
    also: (entry.also ?? []).filter((id) => state.open.has(id) && id !== entry.request),
  })
  if (kind === 'task-notification') {
    const commands = commandRequestsInWake(text, state)
    if (commands.length > 0) return { ref: commands.at(-1), also: commands.slice(0, -1) }
    // A command not opened here: DevSpec resolves it from the turn.
    if (ownerMessageIds(text).length > 0) return { ref: UNSTATED, also: [] }
    // An automation run DevSpec dispatched is positively nobody's request: DevSpec
    // credits the run while it is running, never a command that happens to be live.
    if (/"type"\s*:\s*"automation_run"/.test(String(text || ''))) return { ref: NO_REQUEST, also: [] }
    for (const key of [tag(text, 'task-id'), tag(text, 'tool-use-id')]) {
      const launch = key ? state.launches.get(key) : null
      if (launch) return carried(launch)
    }
    // Nothing recorded launching it (a job started before this plugin was, or one
    // whose launch could not be written): not known, so not stated.
    return { ref: UNSTATED, also: [] }
  }
  if (kind === 'scheduled-trigger') {
    const prompt = String(text || '').trim()
    for (const schedule of [...state.schedules].reverse()) {
      if (schedule.prompt === prompt) return carried(schedule)
    }
    return { ref: UNSTATED, also: [] }
  }
  return { ref: null, also: [] }
}

/** The open requests of the DevSpec commands a wake carries, oldest first. */
export function commandRequestsInWake(text, state) {
  const refs = []
  for (const messageId of ownerMessageIds(text)) {
    for (const [id, info] of state.open) if (info.message_id === messageId && !refs.includes(id)) refs.push(id)
  }
  return refs
}

/** The job ids a wake's notification names, to mark their launches notified. */
export function notifiedKeys(text) {
  return [tag(text, 'task-id'), tag(text, 'tool-use-id')].filter((key) => key && KEY.test(key))
}

/**
 * The request a write made now serves: a subagent's is the request that launched
 * it, anything else the current one. Null when nothing is known, which leaves the
 * write unstamped for DevSpec to resolve as it always has.
 */
export function requestRefForWrite(state, agentId = null) {
  if (agentId) {
    const launch = state.launches.get(agentId)
    if (launch) return state.open.has(launch.request) || launch.request === NO_REQUEST ? launch.request : null
  }
  if (state.current === NO_REQUEST) return NO_REQUEST
  return state.current && state.open.has(state.current) ? state.current : null
}

/**
 * Who a request is from, as a write would record it: a person, and whether they
 * asked at this terminal or in a room.
 */
function attributionOf(info) {
  return `${info.requested_by ?? 'unknown'}:${info.kind === 'typed_prompt' ? 'terminal' : 'room'}`
}

/**
 * The open requests the current turn carries when they would not all be recorded
 * the same way (different people, or a person here and in a room), and the agent
 * has not named which one it is working on. A turn woken for nobody's request
 * (NO_REQUEST) that a request then reaches carries both. Null when any write
 * this turn makes has one answer. A subagent's write is never ambiguous: its
 * launch says.
 *
 * @returns {Array<{ id: string, kind: string, message_id?: string, current: boolean }>|null}
 *   with `id: NO_REQUEST, kind: 'none'` for the turn's own nobody's-request part
 */
export function turnAmbiguity(state, agentId = null) {
  if (state.chosen || state.joined.size === 0) return null
  if (agentId && state.launches.has(agentId)) return null
  const carried = []
  if (state.current && state.open.has(state.current)) carried.push(state.current)
  for (const id of state.joined) if (state.open.has(id) && !carried.includes(id)) carried.push(id)
  const attributions = new Set(carried.map((id) => attributionOf(state.open.get(id))))
  const nobody = state.current === NO_REQUEST && carried.length > 0
  if (attributions.size + (nobody ? 1 : 0) < 2) return null
  return [
    ...(nobody ? [{ id: NO_REQUEST, kind: 'none', current: true }] : []),
    ...carried.map((id) => {
      const info = state.open.get(id)
      return { id, kind: info.kind, ...(info.message_id ? { message_id: info.message_id } : {}), current: id === state.current }
    }),
  ]
}

/**
 * The open request the agent names with `serve`: the command with this message
 * id, (`terminal`) the newest prompt typed here, or (`none`) nobody's request.
 * Null when none is open.
 */
export function requestToServe(state, { messageId = null, terminal = false, none = false } = {}) {
  if (none) return NO_REQUEST
  let found = null
  for (const [id, info] of state.open) {
    if (terminal ? info.kind === 'typed_prompt' : info.message_id === messageId) found = id
  }
  return found
}

/**
 * The request a job launched now belongs to: the launching subagent's when a
 * subagent launched it, else the current one, with the other requests an
 * undecided turn was carrying.
 */
export function requestForLaunch(state, agentId = null) {
  // Every launch is recorded, so its wake is never mistaken for one nothing here
  // started: for a request, for nobody's (the turn positively served nobody's), or
  // not known.
  const ref = requestRefForWrite(state, agentId) ?? UNSTATED
  // Launched while the turn carried several people's requests and the agent had
  // not named one: its wake carries them all again.
  const also = (turnAmbiguity(state, agentId) ?? []).map((entry) => entry.id).filter((id) => UUID.test(id) && id !== ref)
  return { request: ref, also }
}

/**
 * The open requests that still have work running or a wake still to come, at a
 * Stop. A job counts while the host still lists it, or, once it has ended, until
 * its notification has reached the agent (a job that ends with no notification is
 * done when it leaves the list). A scheduled prompt counts while the host still
 * lists it among the session's crons.
 */
export function requestsWithWorkPending(state, { backgroundTasks = null, sessionCrons = null } = {}) {
  const pending = new Set()
  const listed = new Map()
  for (const task of Array.isArray(backgroundTasks) ? backgroundTasks : []) {
    if (task && typeof task.id === 'string') listed.set(task.id, String(task.status || '').toLowerCase())
  }
  const hold = (entry) => {
    for (const id of [entry.request, ...(entry.also ?? [])]) if (state.open.has(id)) pending.add(id)
  }
  for (const [key, launch] of state.launches) {
    const status = listed.get(key)
    // Still running, or ended with its wake not yet seen. A host that sends no
    // list leaves only the second test, which never closes work still running.
    if (status !== undefined && !ENDED_STATUSES.has(status)) hold(launch)
    else if (launch.notifies && !launch.notified) hold(launch)
  }
  const crons = new Set((Array.isArray(sessionCrons) ? sessionCrons : [])
    .map((cron) => (typeof cron?.prompt === 'string' ? cron.prompt.trim() : null)).filter(Boolean))
  for (const schedule of state.schedules) {
    if (crons.has(schedule.prompt)) hold(schedule)
  }
  return pending
}

/**
 * The background job, wait or loop a finished tool call set up, for the request
 * log: its key (the id the host lists it under or names in its notification), the
 * launching tool call's id, whether its end arrives as a notification, and for a
 * schedule the prompt it will fire with. Null when the call left nothing running.
 * Measured shapes: Claude Code's tool result types (`.claude-plugin/types`).
 */
export function launchForRequest(toolName, toolInput, toolResponse, toolUseId = null) {
  const res = toolResponse && typeof toolResponse === 'object' ? toolResponse : null
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {}
  const id = (value) => (typeof value === 'string' && KEY.test(value) ? value : null)
  const alias = id(toolUseId)
  if (!res) return null
  switch (String(toolName || '')) {
    case 'Bash': {
      const key = id(res.backgroundTaskId)
      return key ? { key, alias, kind: 'shell', notifies: res.backgroundEndsWithFinalResponse !== true } : null
    }
    case 'Agent': {
      if (res.status === 'async_launched' && id(res.agentId)) return { key: res.agentId, alias, kind: 'subagent', notifies: true }
      if (res.status === 'remote_launched' && id(res.taskId)) return { key: res.taskId, alias, kind: 'subagent', notifies: true }
      return null
    }
    case 'Workflow': {
      const key = id(res.taskId)
      return key ? { key, alias, kind: 'workflow', notifies: true } : null
    }
    case 'Monitor': {
      // The DevSpec listener carries every request and belongs to none: its wakes
      // are commands, each its own request.
      if (typeof input.command === 'string' && input.command.includes('devspec-remote-wait.mjs')) return null
      const key = id(res.taskId)
      return key ? { key, alias, kind: 'monitor', notifies: false } : null
    }
    case 'ScheduleWakeup': {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
      return prompt && !res.stopped ? { schedule: true, prompt, id: null } : null
    }
    case 'CronCreate': {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
      return prompt ? { schedule: true, prompt, id: id(res.id) } : null
    }
    default:
      return null
  }
}

export const REQUESTS_SCRIPT = fileURLToPath(import.meta.url)

/** The command the agent runs to name the request its writes serve. */
export function serveCommand(connectionId) {
  return `node ${JSON.stringify(REQUESTS_SCRIPT)} serve --connection-id ${connectionId}`
}

/**
 * `serve --connection-id <id> (--message-id <command message id> | --terminal | --none)`:
 * the agent says which request the writes it makes next serve, when its turn
 * carries more than one person's. Prints what it recorded, as one JSON line.
 */
export function serveMain(argv, { dir = path.join(os.homedir(), '.devspec', 'remote-control', 'connections') } = {}) {
  const value = (flag) => {
    const at = argv.indexOf(flag)
    return at >= 0 && typeof argv[at + 1] === 'string' ? argv[at + 1] : null
  }
  const connectionId = value('--connection-id')
  if (!UUID.test(connectionId ?? '')) return { ok: false, error: 'serve needs --connection-id <your connection id>' }
  const messageId = value('--message-id')
  const terminal = argv.includes('--terminal')
  const none = argv.includes('--none')
  if ([Boolean(messageId), terminal, none].filter(Boolean).length !== 1) {
    return { ok: false, error: 'serve needs exactly one of --message-id <id>, --terminal or --none' }
  }
  const ref = requestToServe(readRequestState(connectionId, { dir }), { messageId, terminal, none })
  if (!ref) {
    return { ok: false, error: messageId
      ? `no open request here is for message ${messageId}; name one the refusal listed`
      : 'no prompt typed at this terminal is open here' }
  }
  if (!appendRequestEvent(connectionId, { op: 'serve', ref }, { dir })) return { ok: false, error: 'could not record it' }
  return { ok: true, serving: ref === NO_REQUEST ? 'nobody\'s request: your own initiative' : ref }
}

let isMain = false
try {
  isMain = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
} catch {
  /* imported */
}
if (isMain && process.argv[2] === 'serve') {
  const result = serveMain(process.argv.slice(3))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exit(result.ok ? 0 : 1)
}
