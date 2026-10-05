/**
 * The delegation group in a session's Activity (item d2cbd4c6).
 *
 * When Claude hands work to subagents (or starts a workflow), a person watching the
 * room should see what the agent is waiting on, nested under its Activity the way Pi
 * shows it (decision 0c496777: subagents are nested Activity, never speech). This
 * module builds that one `subagent` trail event and posts it with `phase: trail`.
 *
 * It is the Claude Code plugin's first mechanical trail writer, so its shape is the
 * one later rows build on: a per-turn trail state (identity + seq) and a single-flight
 * poster that always sends the newest picture.
 *
 * IDENTITY IS THE DANGEROUS PART. A trail post names the exact command turn it belongs
 * to. Several of the server's refusals release the attempt they matched, so a trail
 * sent under the wrong identity can end a live turn. Every post therefore carries the
 * identity recorded when the turn's first delegation started, and nothing is posted
 * when that identity cannot be established.
 *
 * Imports only Node built-ins (DEVELOPMENT.md).
 */
import fs from 'node:fs'
import path from 'node:path'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Work the delegation group lists: subagents Claude started in the background. These
 * are what leave the agent "waiting" with nothing to show, and the host reports each
 * one's end (SubagentStop). A background command is a tool row (step 3), so it never
 * inflates "Reviewing with N agents"; a workflow's end has no hook of its own, so it
 * joins the group when its end can be observed honestly.
 */
export const DELEGATED_KINDS = new Set(['subagent'])

/**
 * The command turn this conversation's open turn belongs to, as the server knows it.
 *
 * - A turn typed at this terminal (`state.local_turn`, admitted for this room) is a
 *   local turn: `command_turn_unbound` + `local_turn`.
 * - Otherwise the newest command the poller delivered, when it is the one that
 *   opened this turn: its `received_at` must sit within `PICKUP_WINDOW_MS` of the
 *   turn marker's start, which the poller writes at that same pickup.
 * - Anything else is unknown, and an unknown identity posts nothing.
 */
const PICKUP_WINDOW_MS = 15_000

export function turnIdentity({ state, marker, latestCommand }) {
  const sessionId = typeof state?.session_id === 'string' ? state.session_id : null
  if (!sessionId || typeof marker?.startedAt !== 'number') return null
  const local = state.local_turn
  if (local && typeof local.attempt_id === 'string' && local.session_id === sessionId) {
    return { command_turn_unbound: true, local_turn: true }
  }
  if (
    latestCommand &&
    UUID_RE.test(latestCommand.turnId || '') &&
    UUID_RE.test(latestCommand.messageId || '') &&
    Math.abs(latestCommand.receivedAt - marker.startedAt) <= PICKUP_WINDOW_MS
  ) {
    return { command_turn_id: latestCommand.turnId, command_message_id: latestCommand.messageId }
  }
  return null
}

/**
 * The newest canonical command in an inbox, `{ turnId, messageId, receivedAt }`, or
 * null. The primary command of the newest batch is the one a reply answers.
 */
export function latestDeliveredCommand(inboxText) {
  const lines = String(inboxText || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('canonical_commands')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry?.type !== 'canonical_commands') continue
    const commands = Array.isArray(entry.ingress?.commands) ? entry.ingress.commands : []
    const primary = commands.find((c) => c?.delivery?.is_primary === true) || commands[0]
    const receivedAt = Date.parse(entry.received_at || '')
    if (!primary || !Number.isFinite(receivedAt)) return null
    return { turnId: primary.delivery?.turn_id ?? null, messageId: primary.message_id ?? null, receivedAt }
  }
  return null
}

/**
 * The delegated work of one turn, in launch order, from the owned-work lines
 * (mirror-turn.mjs ownedWorkPath): launches `{ id, kind, turn, at, label?, model? }`
 * and ends `{ id, turn, ended, status }`.
 */
export function delegatedChildren(lines, turn) {
  const children = new Map()
  const ends = new Map()
  for (const entry of lines) {
    if (!entry || entry.turn !== turn || typeof entry.id !== 'string') continue
    if (typeof entry.ended === 'string') {
      ends.set(entry.id, entry)
    } else if (DELEGATED_KINDS.has(entry.kind) && !children.has(entry.id)) {
      children.set(entry.id, entry)
    }
  }
  return [...children.values()].map((launch) => {
    const end = ends.get(launch.id)
    return {
      id: launch.id,
      kind: launch.kind,
      label: launch.label || null,
      model: launch.model || null,
      startedAt: launch.at,
      endedAt: end ? end.ended : null,
      status: end ? end.status : 'running',
    }
  })
}

/** Child statuses the Activity contract knows; anything else reads as ended work. */
const CHILD_STATUS = new Set(['pending', 'running', 'completed', 'failed', 'detached', 'stopped', 'paused'])

/** One line of text, at most `max` characters, nothing a terminal would act on. */
function label(text, max) {
  // eslint-disable-next-line no-control-regex
  const flat = String(text || '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * The one `subagent` trail event for a turn's delegation, or null when it has none.
 *
 * Children carry a position key, never Claude Code's own ids (privacy: no internal
 * ids leave the machine), the label Claude gave the work, the model the host
 * resolved, and honest times: `durationMs` from launch to end for finished work, and
 * `lastActivityAt` = launch time for running work (we hold no later observation).
 */
export function delegationEvent(children, { seq }) {
  if (!Array.isArray(children) || children.length === 0) return null
  const running = children.filter((c) => c.status === 'running').length
  const first = children.reduce((min, c) => (Date.parse(c.startedAt) < Date.parse(min) ? c.startedAt : min), children[0].startedAt)
  const lastEnd = running === 0
    ? children.reduce((max, c) => (c.endedAt && Date.parse(c.endedAt) > Date.parse(max || 0) ? c.endedAt : max), null)
    : null
  const event = {
    seq,
    kind: 'subagent',
    name: 'delegation',
    status: running > 0 ? 'running' : children.some((c) => c.status === 'failed') ? 'error' : 'ok',
    occurredAt: first,
    children: children.map((child, index) => {
      const row = {
        key: `child-${index + 1}`,
        agent: label(child.label || (child.kind === 'workflow' ? 'workflow' : 'subagent'), 120),
        status: CHILD_STATUS.has(child.status) ? child.status : 'completed',
      }
      if (child.model) row.model = label(child.model, 160)
      const started = Date.parse(child.startedAt)
      const ended = child.endedAt ? Date.parse(child.endedAt) : NaN
      if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) row.durationMs = ended - started
      else if (child.status === 'running' && Number.isFinite(started)) row.lastActivityAt = new Date(started).toISOString()
      return row
    }),
    summary: running > 0
      ? `${running} of ${children.length} ${children.length === 1 ? 'agent' : 'agents'} active`
      : `${children.length} ${children.length === 1 ? 'agent' : 'agents'} finished`,
  }
  if (lastEnd) {
    event.completedAt = lastEnd
    const span = Date.parse(lastEnd) - Date.parse(first)
    if (Number.isFinite(span) && span >= 0) event.durationMs = span
  }
  return event
}

/**
 * The plain-text companion every trail post must carry: one line per launch and end,
 * in the order they happened. The server folds successive trail texts by prefix, so
 * it only ever grows; the panel shows it only when no structured events render.
 */
export function delegationText(lines, turn) {
  const labels = new Map()
  const out = []
  for (const entry of lines) {
    if (!entry || entry.turn !== turn || typeof entry.id !== 'string') continue
    if (typeof entry.ended !== 'string') {
      if (!DELEGATED_KINDS.has(entry.kind) || labels.has(entry.id)) continue
      const name = label(entry.label || 'subagent', 120)
      labels.set(entry.id, { name, at: Date.parse(entry.at) })
      out.push(`- Started ${name}${entry.model ? ` (${label(entry.model, 160)})` : ''}`)
    } else if (labels.has(entry.id)) {
      const { name, at } = labels.get(entry.id)
      const seconds = Math.round((Date.parse(entry.ended) - at) / 1000)
      out.push(`- ${name} ${entry.status === 'failed' ? 'failed' : 'finished'}${Number.isFinite(seconds) && seconds >= 0 ? ` after ${seconds}s` : ''}`)
    }
  }
  return out.length ? ['Delegated work', ...out].join('\n') : ''
}

/* ------------------------------------------------------------------ *
 * Per-turn trail state and the single-flight poster                    *
 * ------------------------------------------------------------------ */

export function trailStatePath(connectionId, dir) {
  return path.join(dir, `${connectionId}.turn-trail.json`)
}

/**
 * This turn's trail state `{ turn, identity, delegationSeq, nextSeq }`, created on
 * first use. A state for another turn is replaced: a new command is a new trail.
 * Returns null when the identity is unknown, so nothing is posted.
 */
export function ensureTrailState(connectionId, { dir, turn, resolveIdentity }) {
  const file = trailStatePath(connectionId, dir)
  let current = null
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    current = null
  }
  if (current?.turn === turn && current.identity) return current
  const identity = resolveIdentity()
  if (!identity) return null
  const next = { turn, identity, delegationSeq: 1, nextSeq: 2 }
  try {
    fs.writeFileSync(file, JSON.stringify(next), { mode: 0o600 })
  } catch {
    return null
  }
  return next
}

/**
 * Post the newest picture, at most one post in flight per connection.
 *
 * Several hooks can fire together (parallel launches, a SubagentStop beside a Stop).
 * Whoever holds the lock posts; a hook that finds it held marks the picture dirty and
 * leaves, and the holder posts again before releasing, so the last post always
 * reflects the last change. The holder keeps going while changes keep arriving; the
 * hook's own timeout is what bounds it.
 *
 * A lock older than the hook timeout (hooks.json gives these hooks 10 s) belongs to a
 * holder Claude Code has already killed, so it is taken over.
 */
const LOCK_STALE_MS = 15_000

export async function postLatest(connectionId, { dir, build, post, now = () => Date.now() }) {
  const lock = path.join(dir, `${connectionId}.turn-trail.lock`)
  const dirty = path.join(dir, `${connectionId}.turn-trail.dirty`)
  try {
    fs.writeFileSync(lock, String(now()), { flag: 'wx', mode: 0o600 })
  } catch {
    let held = 0
    try {
      held = Number(fs.readFileSync(lock, 'utf8'))
    } catch {
      /* gone between our attempt and the read: treat as held, mark dirty */
    }
    if (held && now() - held > LOCK_STALE_MS) {
      try {
        fs.rmSync(lock, { force: true })
        fs.writeFileSync(lock, String(now()), { flag: 'wx', mode: 0o600 })
      } catch {
        fs.writeFileSync(dirty, '1', { mode: 0o600 })
        return { posted: 0, deferred: true }
      }
    } else {
      fs.writeFileSync(dirty, '1', { mode: 0o600 })
      return { posted: 0, deferred: true }
    }
  }
  let posted = 0
  try {
    for (;;) {
      fs.rmSync(dirty, { force: true })
      const payload = build()
      if (payload) {
        const ok = await post(payload)
        if (!ok) break
        posted++
      }
      if (!fs.existsSync(dirty)) break
    }
  } finally {
    fs.rmSync(lock, { force: true })
  }
  return { posted, deferred: false }
}
