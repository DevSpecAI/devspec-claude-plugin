#!/usr/bin/env node
/**
 * The local room transcript (item 1a4f0246) and the 1.6.0 wire it is built from.
 *
 * Every page here is a legal remote-ingress 1.6.0 envelope, checked by the real
 * validator before the store sees it, and every assertion is about what ends up in
 * the copy on disk — not about what a function returned.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  normalizeRemoteIngressV1,
  REMOTE_INGRESS_ROOM_CONTEXT_CONTRACT_VERSION,
  REMOTE_INGRESS_ROOM_CONTEXT_POLICY_VERSION,
  REMOTE_INGRESS_SENDER_STYLE_CONTRACT_VERSION,
  REMOTE_INGRESS_SENDER_STYLE_POLICY_VERSION,
} from './remote-ingress-v1.mjs'
import {
  applyIngressToStore,
  beginDrain,
  completeEmptyDrain,
  createTranscriptStore,
  loadTranscriptStore,
  MAX_REPAIRS_PER_DAY,
  observeSessionActivity,
  persistTranscriptStore,
  sessionActivityView,
  takePendingRedrain,
  transcriptPaths,
  transcriptPollArguments,
  transcriptSummary,
} from './room-transcript.mjs'
import { appendCanonicalInbox, scanPersistedInboxRecords, writeRoomState } from './devspec-remote-poll.mjs'

const CONN = '10000000-0000-4000-8000-000000000001'
const OTHER_AGENT = '10000000-0000-4000-8000-000000000099'
const OWNER = '20000000-0000-4000-8000-000000000002'
const SESSION = 'a0000000-0000-4000-8000-00000000000a'
const SESSION_2 = 'b0000000-0000-4000-8000-00000000000b'
const RESOURCE = '70000000-0000-4000-8000-000000000007'
const ME_LABEL = 'Claude Code · Careful Moth'

const id = (n) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const at = (n) => new Date(Date.UTC(2026, 8, 24, 8, 0, 0) + n * 1000).toISOString()
const order = (n) => ({ sequence: n, created_at: at(n), message_id: id(n) })
let envelopeCounter = 0
const envelopeId = () => `60000000-0000-4000-8000-${String(++envelopeCounter).padStart(12, '0')}`

function entry(n, { kind = 'human', name = 'Ali Price', tool = null, text = `message ${n}` } = {}) {
  return {
    message_id: id(n),
    order: order(n),
    actor: { kind, user_id: kind === 'human' ? OWNER : null, display_name: name, agent_tool: tool, model: null },
    source_type: kind === 'human' ? 'user' : kind === 'agent' ? 'external_agent' : kind === 'ai' ? 'assistant' : 'system',
    relationship: 'before_window',
    content: text,
    advisory: true,
  }
}

function command(n, { text = `please do ${n}` } = {}) {
  return {
    message_id: id(n),
    order: order(n),
    content: { mode: 'full', body: text, complete: true },
    attachments: [],
    requester: { user_id: OWNER, display_name: 'Ali Price' },
    authority: {
      kind: 'owner', mode: 'owner', requested_by_user_id: OWNER, connection_owner_user_id: OWNER, decision_source: 'server',
    },
    project_scope: null,
    addressee: { connection_id: CONN, agent_name: 'Claude Code', codename: 'Careful Moth', label: ME_LABEL },
    delivery: {
      provenance_ref: '40000000-0000-4000-8000-000000000004',
      turn_id: '50000000-0000-4000-8000-000000000005',
      primary_provenance_ref: '40000000-0000-4000-8000-000000000004',
      is_primary: true,
    },
  }
}

const BUCKET = { human: 'human_context', agent: 'agent_context', ai: 'ai_context', system: 'system_context' }

/**
 * A legal 1.6.0 page. `described` overrides the room message for an id; `room`
 * adds coverage / open_check / deletions; `history` makes it a drain page.
 */
function page({ entries = [], commands = [], described = {}, room = {}, window = {}, history = false, extra = {} } = {}) {
  const context = { human_context: [], agent_context: [], ai_context: [], system_context: [] }
  for (const e of [...entries].sort((a, b) => a.order.sequence - b.order.sequence)) context[BUCKET[e.actor.kind]].push(e)
  const rows = [...commands, ...entries].sort((a, b) => a.order.sequence - b.order.sequence)
  const first = rows[0]?.order ?? null
  const last = rows.at(-1)?.order ?? null
  const live = commands.length > 0
  return {
    kind: 'devspec.remote_ingress',
    schema_version: 1,
    contract_version: REMOTE_INGRESS_ROOM_CONTEXT_CONTRACT_VERSION,
    policy_version: REMOTE_INGRESS_ROOM_CONTEXT_POLICY_VERSION,
    envelope_id: envelopeId(),
    connection: { connection_id: CONN, agent_name: 'Claude Code', codename: 'Careful Moth', label: ME_LABEL },
    wake: history
      ? { kind: 'history_reseed', active: false, reason_id: 'history' }
      : live
        ? { kind: 'conversational_command', active: true, reason_id: 'command_available' }
        : { kind: 'advisory_update', active: false, reason_id: 'advisory_context_changed' },
    delivery_state: history ? 'reseed' : 'live',
    command_message_ids: commands.map((c) => c.message_id),
    commands,
    control: null,
    context,
    system_notices: [],
    room_context: {
      version: 1,
      messages: rows.map((row) => ({
        message_id: row.message_id,
        addressee: { kind: 'room' },
        attachments: [],
        state: 'final',
        ...(commands.includes(row) ? { addressee: { kind: 'connection', connection_id: CONN, label: ME_LABEL } } : {}),
        ...(described[row.message_id] ?? {}),
      })),
      coverage: room.coverage === undefined ? null : room.coverage,
      ...(room.open_check !== undefined ? { open_check: room.open_check } : {}),
      ...(room.deletions !== undefined ? { deletions: room.deletions } : {}),
    },
    window: {
      policy_version: REMOTE_INGRESS_ROOM_CONTEXT_POLICY_VERSION,
      returned: rows.length,
      total_known: null,
      source_window: { start: first, end: last },
      truncated: false,
      has_more: false,
      next_cursor: null,
      fetch_id: null,
      omission_reason: null,
      ...window,
    },
    ...extra,
  }
}

function coverage(through, eligible, deleted = 0, open = []) {
  return { through: order(through), eligible_count: eligible, deleted_count: deleted, open_message_ids: open }
}

/** Validate like the poller does, then apply to the store. */
function apply(store, ingress, options = {}) {
  const normalized = normalizeRemoteIngressV1(ingress, CONN)
  assert.equal(normalized.ok, true, normalized.error)
  return applyIngressToStore(store, normalized.envelope, { sessionId: SESSION, ...options })
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'room-transcript-'))
}

function linesOnDisk(dir, sessionId = SESSION) {
  const text = fs.readFileSync(transcriptPaths(CONN, sessionId, dir).transcript, 'utf8')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

describe('remote-ingress 1.6.0 on the wire', () => {
  it('accepts a legal room-context page and keeps 1.5.0 exactly as strict as before', () => {
    const legal = page({ entries: [entry(1)], commands: [command(2)], room: { coverage: coverage(2, 2) } })
    assert.equal(normalizeRemoteIngressV1(legal, CONN).ok, true)
    // An older lane never accepts the new section, and 1.6.0 always requires it.
    const asOld = { ...legal, contract_version: REMOTE_INGRESS_SENDER_STYLE_CONTRACT_VERSION, policy_version: REMOTE_INGRESS_SENDER_STYLE_POLICY_VERSION, window: { ...legal.window, policy_version: REMOTE_INGRESS_SENDER_STYLE_POLICY_VERSION } }
    assert.equal(normalizeRemoteIngressV1(asOld, CONN).ok, false)
    const { room_context: _gone, ...withoutRoom } = legal
    assert.equal(normalizeRemoteIngressV1(withoutRoom, CONN).ok, false)
  })

  it('rejects pages that would poison a copy', () => {
    const bad = [
      // a tombstone delivered as a command
      page({ commands: [command(1)], described: { [id(1)]: { state: 'deleted' } } }),
      // coverage that contradicts the page's own description
      page({ entries: [entry(1)], described: { [id(1)]: { state: 'in_progress' } }, room: { coverage: coverage(1, 1) } }),
      // a settled row without its record
      page({ entries: [entry(1)], room: { coverage: coverage(1, 1), open_check: [{ message_id: id(9), state: 'final' }] } }),
      // acknowledging a total while pages remain
      page({ entries: [entry(1)], room: { deletions: { message_ids: [id(5)], truncated: true, total: 900, seen: { through: { deleted_at: at(5), message_id: id(5) }, total: 900 } } } }),
      // an unavailable inventory that still asserts entries
      page({ entries: [entry(1)], extra: { session_activity: { version: 1, advisory: true, status: 'unavailable', as_of: at(1), revision: null, entries: [{ kind: 'memory', id: id(7), title: 'x', status: null, relation: 'produced', creator: null }], truncated: false } } }),
    ]
    for (const ingress of bad) assert.equal(normalizeRemoteIngressV1(ingress, CONN).ok, false)
  })
})

describe('a room with more than 60 messages', () => {
  it('is drained to the start, verified against coverage, and keeps merging newer arrivals', () => {
    const dir = tmpDir()
    const store = createTranscriptStore(CONN, SESSION)
    beginDrain(store)
    // The seed page: the newest 60 of 100, with older history still to come.
    let result = apply(store, page({
      entries: range(41, 100).map((n) => entry(n)),
      history: true,
      room: { coverage: coverage(100, 100) },
      window: { has_more: true, next_cursor: 'older-1' },
    }), { drainPoll: true })
    // Partial backfill is progress, never a mismatch.
    assert.equal(result.verdict, 'unverified')
    assert.equal(takePendingRedrain(store), null)
    result = apply(store, page({ entries: range(1, 40).map((n) => entry(n)), history: true, room: { coverage: coverage(40, 40) } }), { drainPoll: true })
    assert.equal(result.verdict, 'consistent')
    // Newer messages arrive after the drain and merge in order.
    result = apply(store, page({ entries: range(101, 103).map((n) => entry(n)), room: { coverage: coverage(103, 103) } }))
    assert.equal(result.verdict, 'consistent')
    persistTranscriptStore(store, { dir })
    const lines = linesOnDisk(dir)
    assert.equal(lines.length, 103)
    assert.deepEqual(lines.map((line) => line.seq), range(1, 103))
    assert.equal(new Set(lines.map((line) => line.message_id)).size, 103)
    assert.equal(transcriptSummary(store, { dir }).status, 'complete')
    assert.equal(transcriptSummary(store, { dir }).complete, true)
  })

  it('is not declared complete while the drain is unfinished, and an empty room completes at once', () => {
    const store = createTranscriptStore(CONN, SESSION)
    beginDrain(store)
    apply(store, page({ entries: [entry(61)], history: true, room: { coverage: coverage(61, 61) }, window: { has_more: true, next_cursor: 'older' } }), { drainPoll: true })
    assert.equal(transcriptSummary(store).status, 'backfilling')
    const empty = createTranscriptStore(CONN, SESSION)
    beginDrain(empty)
    completeEmptyDrain(empty)
    assert.equal(empty.backfill.complete, true)
  })
})

describe("another agent's screenshot", () => {
  it('keeps who it was for and the file reference, and downloads nothing', () => {
    const dir = tmpDir()
    const store = createTranscriptStore(CONN, SESSION)
    const shot = {
      materialization: 'metadata', filename: 'screen.png', mime_type: 'image/png', type: 'image', size_bytes: 2048, resource_id: RESOURCE,
    }
    apply(store, page({
      entries: [entry(1, { text: 'Here is the screenshot' })],
      described: { [id(1)]: { addressee: { kind: 'connection', connection_id: OTHER_AGENT, label: 'Pi · Racing Gecko' }, attachments: [shot] } },
    }))
    persistTranscriptStore(store, { dir })
    const [line] = linesOnDisk(dir)
    assert.equal(line.to, 'Pi · Racing Gecko')
    assert.deepEqual(line.attachments, [{ filename: 'screen.png', mime_type: 'image/png', size_bytes: 2048, resource_id: RESOURCE }])
    // Only the transcript and its state exist: no file was fetched.
    assert.deepEqual(fs.readdirSync(dir).sort(), [
      path.basename(transcriptPaths(CONN, SESSION, dir).state),
      path.basename(transcriptPaths(CONN, SESSION, dir).transcript),
    ].sort())
  })
})

describe('a crash at every write boundary', () => {
  // The poller's order: inbox record → transcript → transcript state → cursor.
  // The cursor only moves last, so after a crash the same page is polled again.
  const inboxWrites = []
  const writeRecord = (_connection, record) => { inboxWrites.push(record); return true }

  function deliver({ dir, index, crashAt, ingress }) {
    const persisted = appendCanonicalInbox(CONN, ingress, index, { sessionId: SESSION, channel: ingress.commands.length ? 'command' : 'context', writeRecord })
    if (crashAt === 'after_inbox') return persisted
    const store = loadTranscriptStore(CONN, SESSION, { dir })
    applyIngressToStore(store, ingress, { sessionId: SESSION })
    if (crashAt === 'during_transcript') {
      persistTranscriptStore(store, { dir, writeText: () => { throw new Error('killed') } })
      return persisted
    }
    if (crashAt === 'between_transcript_and_state') {
      persistTranscriptStore(store, { dir, writeJson: () => { throw new Error('killed') } })
      return persisted
    }
    persistTranscriptStore(store, { dir })
    return persisted
  }

  for (const crashAt of ['after_inbox', 'during_transcript', 'between_transcript_and_state', 'before_cursor']) {
    it(`recovers from a crash ${crashAt.replaceAll('_', ' ')} without gaps, duplicates or a replayed command`, () => {
      const dir = tmpDir()
      inboxWrites.length = 0
      const index = scanPersistedInboxRecords('')
      const first = page({ entries: [entry(1), entry(2)], commands: [command(3)], room: { coverage: coverage(3, 3) } })
      const firstDelivery = deliver({ dir, index, crashAt, ingress: first })
      assert.deepEqual(firstDelivery.executeMessageIds, [id(3)])
      // Restart: the inbox index is rebuilt from what reached disk, and the same
      // rows arrive again in a new envelope because the cursor never moved.
      const restartedIndex = scanPersistedInboxRecords(inboxWrites.map((record) => JSON.stringify(record)).join('\n') + '\n')
      const again = page({ entries: [entry(1), entry(2)], commands: [command(3)], room: { coverage: coverage(3, 3) } })
      const replay = deliver({ dir, index: restartedIndex, crashAt: null, ingress: again })
      // The historical command is never executed twice.
      assert.equal(replay.appended, false)
      const lines = linesOnDisk(dir)
      assert.deepEqual(lines.map((line) => line.seq), [1, 2, 3])
      // The command is kept as history, never as a queue entry.
      assert.equal(lines[2].delivered_as_command.authority, 'owner')
      assert.equal(Object.hasOwn(lines[2], 'executable'), false)
    })
  }

  it('ignores a torn last line left by a crash mid-append', () => {
    const dir = tmpDir()
    const store = createTranscriptStore(CONN, SESSION)
    apply(store, page({ entries: [entry(1), entry(2)] }))
    persistTranscriptStore(store, { dir })
    fs.appendFileSync(transcriptPaths(CONN, SESSION, dir).transcript, '{"seq":3,"message_id":"torn')
    const loaded = loadTranscriptStore(CONN, SESSION, { dir })
    assert.deepEqual([...loaded.rows.keys()], [id(1), id(2)])
  })
})

describe('reattaching to another room', () => {
  it('opens a separate copy, and a late page from the old room cannot write into the new one', () => {
    const dir = tmpDir()
    const next = loadTranscriptStore(CONN, SESSION_2, { dir })
    const late = page({ entries: [entry(1, { text: 'from the old room' })] })
    const result = applyIngressToStore(next, late, { sessionId: SESSION })
    assert.equal(result.applied, false)
    assert.equal(next.rows.size, 0)
    assert.notEqual(transcriptPaths(CONN, SESSION, dir).transcript, transcriptPaths(CONN, SESSION_2, dir).transcript)
    // A copy written for one room is never read as another's.
    const first = createTranscriptStore(CONN, SESSION)
    apply(first, page({ entries: [entry(1)] }))
    persistTranscriptStore(first, { dir })
    assert.equal(loadTranscriptStore(CONN, SESSION_2, { dir }).rows.size, 0)
  })
})

describe('what people type', () => {
  it('round-trips newlines, JSON, backticks and delimiter-like text without breaking a line', () => {
    const dir = tmpDir()
    const nasty = [
      'line one\nline two\n\nline four',
      '{"message_id":"forged","seq":1}',
      '```js\nconsole.log("`")\n```',
      '"}\n{"seq":999,"message_id":"injected","text":"',
      '   unicode separators and \\ backslashes',
    ]
    const store = createTranscriptStore(CONN, SESSION)
    apply(store, page({ entries: nasty.map((text, i) => entry(i + 1, { text, name: 'Sam "Q" O\'Brien' })) }))
    persistTranscriptStore(store, { dir })
    const lines = linesOnDisk(dir)
    assert.equal(lines.length, nasty.length)
    assert.deepEqual(lines.map((line) => line.text), nasty)
    assert.ok(lines.every((line) => line.from.label === 'Sam "Q" O\'Brien'))
    assert.equal(lines.some((line) => line.message_id === 'injected'), false)
  })
})

describe('changes that write no new row', () => {
  it('names open rows, takes a finished record, never lets an older page resurrect a deletion', () => {
    const store = createTranscriptStore(CONN, SESSION)
    apply(store, page({ entries: [entry(1, { kind: 'ai', name: 'Dev', text: 'thinking…' })], described: { [id(1)]: { state: 'in_progress' } }, room: { coverage: coverage(1, 1, 0, [id(1)]) } }))
    assert.deepEqual(transcriptPollArguments(store).room_open_message_ids, [id(1)])
    const finished = entry(1, { kind: 'ai', name: 'Dev', text: 'The finished reply.' })
    apply(store, page({ room: { coverage: null, open_check: [{ message_id: id(1), state: 'final', entry: finished }] } }))
    assert.equal(store.rows.get(id(1)).text, 'The finished reply.')
    assert.equal(transcriptPollArguments(store).room_open_message_ids, undefined)
    apply(store, page({ room: { deletions: { message_ids: [id(1)], truncated: false, total: 1, seen: { through: { deleted_at: at(9), message_id: id(1) }, total: 1 } } } }))
    // An older page that still describes it as final changes nothing.
    apply(store, page({ entries: [finished] }))
    assert.equal(store.rows.get(id(1)).state, 'deleted')
    assert.equal(store.rows.get(id(1)).text, null)
    assert.deepEqual(transcriptPollArguments(store).room_deletions_seen, { through: { deleted_at: at(9), message_id: id(1) }, total: 1 })
  })

  it('relists deletions when the room holds more than the copy was told about', () => {
    const store = createTranscriptStore(CONN, SESSION)
    apply(store, page({ entries: [entry(1), entry(2)] }))
    const late = apply(store, page({ room: { deletions: { message_ids: [], truncated: false, total: 1, seen: { through: null, total: 1 } } } }))
    assert.equal(late.verdict, 'relist_deletions')
    assert.equal(transcriptPollArguments(store).room_deletions_seen, null)
  })
})

describe('the room state file', () => {
  it('says what each section is — present, none, unavailable or not sent — and never prints anything', () => {
    const writes = []
    const printed = []
    const realWrite = process.stdout.write
    process.stdout.write = (chunk) => { printed.push(String(chunk)); return true }
    try {
      const store = createTranscriptStore(CONN, SESSION)
      const ingress = page({
        entries: [entry(1), entry(2, { kind: 'agent', name: `${ME_LABEL} (Ali Price)`, tool: ME_LABEL, text: 'my reply' }), entry(3)],
        extra: { session_activity: { version: 1, advisory: true, status: 'unavailable', as_of: at(3), revision: null, entries: [], truncated: false } },
      })
      apply(store, ingress)
      observeSessionActivity(store, ingress.session_activity)
      persistTranscriptStore(store, { dir: tmpDir() })
      writeRoomState(CONN, { session_id: SESSION, ingress }, {}, {
        write: (file, value) => writes.push(value),
        transcript: transcriptSummary(store),
        activity: sessionActivityView(store),
      })
    } finally {
      process.stdout.write = realWrite
    }
    assert.deepEqual(printed, [])
    const [doc] = writes
    assert.equal(doc.sections.session_activity, 'unavailable')
    assert.equal(doc.sections.session_polls, 'none_or_unavailable')
    assert.equal(doc.sections.active_session_plans, 'none')
    assert.equal(doc.sections.system_notices, 'none')
    // Never drained, so it cannot claim to be the whole room yet.
    assert.equal(doc.sections.transcript, 'backfilling')
    assert.equal(doc.transcript.complete, false)
    assert.equal(doc.transcript.messages, 3)
    assert.equal(doc.transcript.approx_tokens_is_estimate, true)
    // Navigation only: one message came after this connection's own last post.
    assert.equal(doc.transcript.since_my_last_reply, 1)
    assert.equal(doc.transcript.has_my_reply, true)
  })
})

describe('what the session produced and referenced', () => {
  const item = (status, over = {}) => ({ kind: 'action_item', id: id(500), title: 'Detach asks first', status, relation: 'produced', creator: { kind: 'agent', label: 'Pi · Racing Gecko · Ali Price' }, ...over })
  const list = (entries, status = 'available') => ({
    version: 1, advisory: true, status, as_of: at(1), revision: status === 'available' ? `sha256:${'a'.repeat(64)}` : null, entries: status === 'available' ? entries : [], truncated: false,
  })

  it('is kept as references plus the changes this copy saw, never as a claim about now', () => {
    const dir = tmpDir()
    const store = createTranscriptStore(CONN, SESSION)
    observeSessionActivity(store, list([item('open')]), new Date(at(10)))
    observeSessionActivity(store, list([item('implemented')]), new Date(at(20)))
    // A failed read is not evidence of anything: no event, the history stands.
    observeSessionActivity(store, list([], 'unavailable'), new Date(at(25)))
    observeSessionActivity(store, list([]), new Date(at(30)))
    const view = sessionActivityView(store)
    assert.match(view.note, /not the current state/)
    assert.deepEqual(view.changes.map((change) => change.event), ['listed', 'status_changed', 'unlisted'])
    assert.deepEqual(view.changes[1], { seen_at: at(20), event: 'status_changed', kind: 'action_item', id: id(500), title: 'Detach asks first', from: 'open', to: 'implemented' })
    // References carry no status at all.
    observeSessionActivity(store, list([item('done')]), new Date(at(40)))
    assert.deepEqual(Object.keys(sessionActivityView(store).items[0]).sort(), ['creator', 'id', 'kind', 'relation', 'title'])
    // The history survives a restart.
    persistTranscriptStore(store, { dir })
    assert.equal(sessionActivityView(loadTranscriptStore(CONN, SESSION, { dir })).changes.length, 4)
  })
})

describe('when the copy disagrees with the room', () => {
  function completeCopy(n) {
    const store = createTranscriptStore(CONN, SESSION)
    beginDrain(store)
    apply(store, page({ entries: range(1, n).map((i) => entry(i)), history: true, room: { coverage: coverage(n, n) } }), { drainPoll: true })
    return store
  }

  it('detects a missing row after a complete drain and asks, within a daily budget, to re-read', () => {
    const store = completeCopy(5)
    // The room has 7 rows up to 7; the copy only ever saw 6 of them.
    const result = apply(store, page({ entries: [entry(7)], room: { coverage: coverage(7, 7) } }))
    assert.equal(result.verdict, 'redrain')
    assert.equal(takePendingRedrain(store), 'mismatch')
    for (let i = 1; i < MAX_REPAIRS_PER_DAY; i++) {
      apply(store, page({ entries: [entry(7)], room: { coverage: coverage(7, 7) } }))
      assert.equal(takePendingRedrain(store), 'mismatch')
    }
    // Budget spent: it stops asking, and says so rather than looping.
    apply(store, page({ entries: [entry(7)], room: { coverage: coverage(7, 7) } }))
    assert.equal(takePendingRedrain(store), null)
    assert.equal(transcriptSummary(store).status, 'mismatch')
  })

  it('repairs by re-draining: the missing row is filled and a row the room no longer has is dropped', () => {
    const store = completeCopy(5)
    // A stray row the room does not hold (a hard delete, which no product path makes).
    apply(store, page({ entries: [entry(4, { text: 'stray' })] }))
    store.rows.set(id(99), { ...store.rows.get(id(4)), seq: 3.5, message_id: id(99) })
    beginDrain(store)
    const result = apply(store, page({ entries: [...range(1, 5), 6].map((i) => entry(i)), history: true, room: { coverage: coverage(6, 6) } }), { drainPoll: true })
    assert.equal(result.verdict, 'consistent')
    assert.equal(store.rows.has(id(99)), false)
    assert.equal(store.rows.has(id(6)), true)
  })

  it('never mistakes partial backfill or a reply settling between reads for a mismatch', () => {
    const store = createTranscriptStore(CONN, SESSION)
    beginDrain(store)
    const partial = apply(store, page({ entries: [entry(50)], history: true, room: { coverage: coverage(50, 50) }, window: { has_more: true, next_cursor: 'older' } }), { drainPoll: true })
    assert.equal(partial.verdict, 'unverified')
    assert.equal(takePendingRedrain(store), null)
    const settled = completeCopy(2)
    apply(settled, page({ entries: [entry(3, { kind: 'ai', name: 'Dev' })], described: { [id(3)]: { state: 'in_progress' } }, room: { coverage: coverage(3, 3, 0, [id(3)]) } }))
    // Coverage (read first) still lists 3 open; open_check (read after) says final.
    const result = apply(settled, page({ room: { coverage: coverage(3, 3, 0, [id(3)]), open_check: [{ message_id: id(3), state: 'final', entry: entry(3, { kind: 'ai', name: 'Dev', text: 'done' }) }] } }))
    assert.notEqual(result.verdict, 'redrain')
    assert.equal(takePendingRedrain(settled), null)
  })
})
