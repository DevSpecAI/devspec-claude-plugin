/**
 * Claude Code's runtime telemetry for DevSpec: which model is running, at what effort,
 * how full the context is, and what the last turn used (item 2382364d).
 *
 * DevSpec shows an agent's model in the composer's To list, the session's agent lists
 * and the Agents page, and freezes it onto the work an agent claims. Pi reports it in
 * code on every beat. Claude Code used to report it only when the agent remembered to
 * name its model on a post, so 74 of 171 Claude Code connections over the fortnight to
 * 2026-10-06 had none at all.
 *
 * The plugin's function-hooks module can see the model directly: every model request
 * raises `turn.step` with the model and effort the engine resolved for it, and
 * `turn.complete` carries the API-reported model and the turn's token counts. So the
 * module (hooks/devspec-telemetry.ts) writes a report to one small file and runs
 * devspec-telemetry.mjs, which sends it as `agent_stats` on heartbeat_connection, the
 * same wire shape Pi sends:
 *
 *   module ── <cid>.telemetry.json ──▶ devspec-telemetry.mjs send ── heartbeat_connection ──▶ DevSpec
 *            (a turn's first request, and its end)
 *
 * Sent straight away rather than on the poller's next poll, because the first thing a
 * turn often does is claim work, and the claim freezes the model DevSpec holds at that
 * moment; a poll can be held for 25 seconds. The file keeps the session's totals across
 * a reload of the module.
 *
 * The connection's model is a different field from a message's model: a hook cannot
 * stamp the message (the agent posts its own answers; ADR b98a39a9), but the
 * connection's heartbeat is already the plugin's to send, so nothing here is a second
 * writer.
 *
 * Every value is something Claude Code measured. `at` is when the module read it, so
 * a report refreshed on a turn's first request says the model is current at that
 * moment, which is what DevSpec's 30-minute freshness rule for frozen work snapshots
 * asks. Nothing is guessed: no model is named until a request has named one.
 *
 * Pure: no Node built-ins, because the module imports it too.
 */

const REMOTE_DIR = '.devspec/remote-control'

/** The vendor of every model Claude Code runs. DevSpec shows it as the route. */
export const MODEL_PROVIDER = 'anthropic'

/** Claude Code's effort levels, as DevSpec's thinking levels name them. */
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/** The module's report for one connection, read by the poller. */
export function telemetryPath(home, connectionId) {
  return `${home}/${REMOTE_DIR}/connections/${connectionId}.telemetry.json`
}

function parseJson(text) {
  if (typeof text !== 'string' || !text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function dollars(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value * 1_000_000) / 1_000_000 : 0
}

function modelId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** A level DevSpec can show, or null: a numeric thinking budget is not a level. */
export function effortLevel(effort) {
  return typeof effort === 'string' && EFFORT_LEVELS.has(effort) ? effort : null
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }
}

/** `$.session.usage().context` as the report carries it, or null when absent. */
export function contextFigures(context) {
  if (!context || typeof context !== 'object') return null
  const window = count(context.window) || null
  const tokens = typeof context.tokens === 'number' && Number.isFinite(context.tokens) && context.tokens >= 0
    ? Math.round(context.tokens)
    : null
  const percent = typeof context.percent === 'number' && Number.isFinite(context.percent)
    ? Math.max(0, Math.min(100, Math.round(context.percent * 10) / 10))
    : null
  if (window === null && tokens === null && percent === null) return null
  return { tokens, window, percent }
}

/**
 * The record on file: the report and the conversation it counts for. A report from
 * another conversation (before a /clear moved this connection) is not this one's, so
 * its session totals are not carried on.
 */
export function parseTelemetryRecord(text) {
  const value = parseJson(text)
  if (!value || typeof value !== 'object' || value.v !== 1) return null
  const report = value.report
  if (!report || typeof report !== 'object' || report.v !== 1) return null
  return {
    conversationId: typeof value.conversation_id === 'string' ? value.conversation_id : null,
    report,
  }
}

function previousFor(previous, conversationId) {
  return previous && previous.conversationId === conversationId ? previous.report : null
}

function record(conversationId, report) {
  return JSON.stringify({ v: 1, conversation_id: conversationId, report })
}

/**
 * On a turn's first model request: the model and effort it was sent with, and the
 * context as it stands. The last turn's usage is kept as it was; nothing settled.
 */
export function refreshedRecord({ previous, conversationId, model, effort, context, nowIso }) {
  const before = previousFor(previous, conversationId)
  const id = modelId(model)
  return record(conversationId, {
    v: 1,
    model: id ? { provider: MODEL_PROVIDER, id } : before?.model ?? null,
    thinkingLevel: id ? effortLevel(effort) : before?.thinkingLevel ?? null,
    context: contextFigures(context) ?? before?.context ?? null,
    turn: before?.turn ?? { ...emptyUsage(), messages: 0 },
    session: before?.session ?? { ...emptyUsage(), turns: 0 },
    at: nowIso,
  })
}

/**
 * At a main-loop turn's end: what the turn used, folded into this conversation's
 * session totals. `usage` is `turn.complete`'s (absent for an interrupt or an API
 * error, when nothing counted); its `model` is the id the API reported, which wins
 * over the one the request named. Cost comes from Claude Code's own ledger, the
 * figure /cost shows: the session's total, and the turn's as the difference since
 * the turn began.
 */
export function settledRecord({
  previous,
  conversationId,
  usage,
  stepModel,
  effort,
  context,
  requests,
  sessionTurns,
  sessionCostUsd,
  turnCostUsd,
  nowIso,
}) {
  const before = previousFor(previous, conversationId)
  const id = modelId(usage?.model) ?? modelId(stepModel)
  const turn = {
    input: count(usage?.input_tokens),
    output: count(usage?.output_tokens),
    cacheRead: count(usage?.cache_read_input_tokens),
    cacheWrite: count(usage?.cache_creation_input_tokens),
    costUsd: dollars(turnCostUsd),
    messages: count(requests),
  }
  const earlier = before?.session ?? { ...emptyUsage(), turns: 0 }
  const session = {
    input: count(earlier.input) + turn.input,
    output: count(earlier.output) + turn.output,
    cacheRead: count(earlier.cacheRead) + turn.cacheRead,
    cacheWrite: count(earlier.cacheWrite) + turn.cacheWrite,
    costUsd: sessionCostUsd === undefined ? dollars(dollars(earlier.costUsd) + turn.costUsd) : dollars(sessionCostUsd),
    turns: sessionTurns === undefined ? count(earlier.turns) + 1 : count(sessionTurns),
  }
  return record(conversationId, {
    v: 1,
    model: id ? { provider: MODEL_PROVIDER, id } : before?.model ?? null,
    // The effort rides the request, so it is known only when a request was seen.
    thinkingLevel: modelId(stepModel) ? effortLevel(effort) : before?.thinkingLevel ?? null,
    context: contextFigures(context) ?? before?.context ?? null,
    turn,
    session,
    at: nowIso,
  })
}
