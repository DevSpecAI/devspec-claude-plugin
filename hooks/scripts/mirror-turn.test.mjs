#!/usr/bin/env node
/**
 * Unit tests for conversation-scoped, CONNECTION-NATIVE remote-control turn mirroring.
 * Run: node --test hooks/scripts/mirror-turn.test.mjs
 *
 * These encode the cross-session-bleed regression: a machine-newer connection that
 * belongs to a DIFFERENT conversation must never be selected for mirroring.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  resolveHookConversationId,
  selectBoundState,
  stripRemoteControlBanner,
  isOperationalChrome,
  prepareAgentMirrorText,
  explicitReplyMarkerPath,
  consumeExplicitReplyMarker,
  isListenerArmed,
  countUnreadOwnerCommands,
  parseStopHookActive,
  decideStopBlock,
  listenerArmedWithGrace,
  stopBondDiagnostic,
  backgroundHoldDecision,
  parseTranscriptPath,
  recordOwnedLaunch,
  readOwnedIds,
  recordBackgroundLaunch,
  turnMarkerPath,
  ownedWorkPath,
} from './mirror-turn.mjs'

/** A pid above any plausible pid_max — guaranteed ESRCH, i.e. provably dead. */
const DEAD_PID = 2147483646

function canonicalCommands(messages) {
  const ids = messages.map((message) => message.id)
  return {
    type: 'canonical_commands',
    execute_message_ids: ids,
    ingress: { command_message_ids: ids, commands: messages },
  }
}

function withConnDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-listener-'))
  const conn = 'c0ffee00-0000-4000-8000-000000000001'
  try {
    return fn({
      dir,
      conn,
      writePid: (pid) => fs.writeFileSync(path.join(dir, `${conn}.wait.pid`), String(pid)),
      writeInbox: (lines) =>
        fs.writeFileSync(path.join(dir, `${conn}.inbox.jsonl`), lines.map((l) => JSON.stringify(l) + '\n').join('')),
      appendRaw: (raw) => fs.appendFileSync(path.join(dir, `${conn}.inbox.jsonl`), raw),
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('resolveHookConversationId', () => {
  it('prefers CLAUDE_CODE_SESSION_ID env (the value write stamps)', () => {
    assert.equal(
      resolveHookConversationId('{"session_id":"stdin-conv"}', {
        CLAUDE_CODE_SESSION_ID: 'env-conv',
      }),
      'env-conv',
    )
  })

  it('falls back to CLAUDE_SESSION_ID', () => {
    assert.equal(resolveHookConversationId('{}', { CLAUDE_SESSION_ID: 'alt-conv' }), 'alt-conv')
  })

  it('does NOT resolve another host\'s env id', () => {
    // REVERSED from "resolves a non-Claude tool env id via the shared
    // detectLocalId" (memory f90e2ff9, superseded 2026-09-20 by Ali).
    //
    // That assertion came from a real regression — Claude's resolver had been
    // hardcoded to CLAUDE_CODE_SESSION_ID and so fail-closed every other
    // plugin's mirror — and the fix made the shared function probe every host's
    // variable. It solved a too-narrow resolver with a too-wide one. Inside the
    // CLAUDE CODE plugin, a Grok or Codex id is not our conversation: it is a
    // real id for a real conversation belonging to somebody else, which arrives
    // whenever one agent launches another and the child inherits the
    // environment (item 75f65461).
    //
    // The lesson that survives is the shape, not this assertion: the function
    // stays shared and tool-agnostic, and each host supplies its own names.
    assert.equal(resolveHookConversationId('{}', { GROK_SESSION_ID: 'grok-conv' }), null)
    assert.equal(resolveHookConversationId('{}', { CODEX_THREAD_ID: 'codex-conv' }), null)
    assert.equal(resolveHookConversationId('{}', { CURSOR_CONVERSATION_ID: 'cursor-conv' }), null)
  })

  it('still reaches the hook stdin id when only a foreign env id is present', () => {
    // The foreign id must not merely be rejected, it must not shadow the real
    // one either — the same shape as the SHELL_SESSION_ID regression below.
    assert.equal(
      resolveHookConversationId('{"session_id":"stdin-conv"}', { GROK_SESSION_ID: 'grok-conv' }),
      'stdin-conv',
    )
  })

  it('falls back to hook stdin session_id when no env id', () => {
    assert.equal(resolveHookConversationId('{"session_id":"stdin-conv"}', {}), 'stdin-conv')
  })

  it('reaches the stdin session_id even when the host shell exports a shell id', () => {
    // THE Working-stuck regression (Grok a6b3f881, Claude 87117120). SHELL_SESSION_ID
    // is set in real Claude Code environments. While detectLocalId still probed it,
    // it won the env leg and this fallback never ran, so Stop resolved a bond that
    // matched no connection — and with 2+ live connections of the same agent
    // selectBoundState fails closed, leaving the turn marker (and Working) forever.
    assert.equal(
      resolveHookConversationId('{"session_id":"stdin-conv"}', {
        SHELL_SESSION_ID: 'w0t0p0:AAAA-BBBB',
        TERM_SESSION_ID: 'term-1',
      }),
      'stdin-conv',
    )
  })

  it('returns null when nothing identifies the conversation (fail closed)', () => {
    assert.equal(resolveHookConversationId('{}', {}), null)
    assert.equal(resolveHookConversationId('not json', {}), null)
    assert.equal(resolveHookConversationId('', {}), null)
  })
})

describe('selectBoundState (connection-native)', () => {
  const conv = 'conv-A'
  const mk = (raw, mtime) => ({ raw, mtime })
  const own = {
    enabled: true,
    connection_id: 'conn-A',
    session_id: 'sess-A',
    local_id: 'conv-A',
    agent_name: 'Claude Code',
  }
  const foreignNewer = {
    enabled: true,
    connection_id: 'conn-B',
    session_id: 'sess-B',
    local_id: 'conv-B',
    agent_name: 'Grok Build',
  }

  it('returns null when no conversation id (fail closed)', () => {
    assert.equal(selectBoundState([mk(own, 1)], null), null)
  })

  it('binds to THIS conversation, never the machine-newest foreign connection', () => {
    const r = selectBoundState([mk(own, 1), mk(foreignNewer, 9999)], conv)
    assert.equal(r?.connection_id, 'conn-A')
  })

  it('returns null when only a foreign conversation has state (fail closed)', () => {
    assert.equal(selectBoundState([mk(foreignNewer, 9999)], conv), null)
  })

  it('ignores disabled state for this conversation', () => {
    assert.equal(selectBoundState([mk({ ...own, enabled: false }, 1)], conv), null)
  })

  it('ignores state missing a connection_id', () => {
    assert.equal(selectBoundState([mk({ ...own, connection_id: null }, 1)], conv), null)
  })

  it('binds a SESSIONLESS connection (session_id null) — the connection is the unit', () => {
    const sessionless = { ...own, session_id: null }
    const r = selectBoundState([mk(sessionless, 1)], conv)
    assert.equal(r?.connection_id, 'conn-A')
    assert.equal(r?.session_id, null)
  })

  it("prefers the newest among THIS conversation's own states", () => {
    const older = { ...own, connection_id: 'conn-A-old' }
    const newer = { ...own, connection_id: 'conn-A-new' }
    const r = selectBoundState([mk(older, 1), mk(newer, 2)], conv)
    assert.equal(r?.connection_id, 'conn-A-new')
  })

  it('tolerates null/garbage candidates', () => {
    const r = selectBoundState([null, undefined, mk(own, 5)], conv)
    assert.equal(r?.connection_id, 'conn-A')
  })

  // Fallback for tools that expose NO per-conversation id to hooks (Cursor,
  // Antigravity): the single enabled connection for THIS agent is unambiguous.
  it('falls back to the single enabled connection for THIS agent when no conversation id', () => {
    const cur = { enabled: true, connection_id: 'conn-C', session_id: null, local_id: null, agent_name: 'Cursor' }
    assert.equal(selectBoundState([mk(cur, 1)], null, 'Cursor')?.connection_id, 'conn-C')
  })

  it('fails closed with two concurrent connections of the same agent (cannot disambiguate)', () => {
    const a = { enabled: true, connection_id: 'conn-1', local_id: null, agent_name: 'Cursor' }
    const b = { enabled: true, connection_id: 'conn-2', local_id: null, agent_name: 'Cursor' }
    assert.equal(selectBoundState([mk(a, 1), mk(b, 2)], null, 'Cursor'), null)
  })

  it('the single-agent fallback ignores other agents; a precise bond still wins', () => {
    const cur = { enabled: true, connection_id: 'conn-CU', session_id: null, local_id: null, agent_name: 'Cursor' }
    assert.equal(selectBoundState([mk(own, 5), mk(cur, 1)], null, 'Cursor')?.connection_id, 'conn-CU')
    assert.equal(
      selectBoundState([mk(own, 5), mk(cur, 1)], 'conv-A', 'Claude Code')?.connection_id,
      'conn-A',
    )
  })
})

const BANNER = `━━━ DevSpec Remote Control ━━━
Agent:      Claude Code · Climbing Toucan
Connection: 7b3a74ae…
Session:    46ef72c0… | attached
Status:     registered + attached
Open:       Agents page
Stop with:  /devspec.remote-stop
─────────────────────────────`

describe('operational chrome filtering', () => {
  it('strips the remote-control status banner', () => {
    const out = stripRemoteControlBanner(`${BANNER}\n\n2`)
    assert.equal(out, '2')
  })

  it('treats banner-only Stop text as chrome', () => {
    assert.equal(isOperationalChrome(BANNER), true)
    assert.equal(prepareAgentMirrorText(BANNER), null)
  })

  it('treats banner + waiting spiel as chrome', () => {
    const t = `${BANNER}\nConnected and waiting for your next command from the session — I already replied to your "Hi" there.`
    assert.equal(isOperationalChrome(t), true)
    assert.equal(prepareAgentMirrorText(t), null)
  })

  it('skips connect / disconnect one-liners', () => {
    assert.equal(
      isOperationalChrome("You're connected to Brandon's Cursor agent on their local machine."),
      true,
    )
    assert.equal(isOperationalChrome('🔌 **Local agent disconnected**.'), true)
    assert.equal(prepareAgentMirrorText('🔌 **Local agent disconnected**.'), null)
  })

  it('keeps a real reply (fail open)', () => {
    const reply = '1 + 1 is 2.'
    assert.equal(isOperationalChrome(reply), false)
    assert.equal(prepareAgentMirrorText(reply), reply)
  })

  it('keeps a real reply after stripping a leading banner', () => {
    const mixed = `${BANNER}\n\nQueue same-tab Dev sends while streaming — done on staging.`
    assert.equal(isOperationalChrome(mixed), false)
    assert.equal(
      prepareAgentMirrorText(mixed),
      'Queue same-tab Dev sends while streaming — done on staging.',
    )
  })
})

describe('explicit-reply marker (double-post guard, item b9fb49a9)', () => {
  // Use a non-UUID test id so this can never collide with a real connection's
  // marker file under the shared ~/.devspec state dir.
  const testConnectionId = 'test-conn-explicit-reply-marker'

  function cleanup() {
    try {
      fs.rmSync(explicitReplyMarkerPath(testConnectionId), { force: true })
    } catch {
      /* ignore */
    }
  }

  it('reports absent when no marker was written', () => {
    cleanup()
    try {
      assert.equal(consumeExplicitReplyMarker(testConnectionId), false)
    } finally {
      cleanup()
    }
  })

  it('reports present once, then absent (single-consume — cannot leak into a later turn)', () => {
    cleanup()
    try {
      fs.mkdirSync(path.dirname(explicitReplyMarkerPath(testConnectionId)), { recursive: true })
      fs.writeFileSync(explicitReplyMarkerPath(testConnectionId), `${Date.now()}\n`)
      assert.equal(fs.existsSync(explicitReplyMarkerPath(testConnectionId)), true)
      assert.equal(consumeExplicitReplyMarker(testConnectionId), true)
      // Consumed — gone, and a second read never re-reports it.
      assert.equal(fs.existsSync(explicitReplyMarkerPath(testConnectionId)), false)
      assert.equal(consumeExplicitReplyMarker(testConnectionId), false)
    } finally {
      cleanup()
    }
  })

  it('returns false for a missing/empty connection id rather than throwing', () => {
    assert.equal(consumeExplicitReplyMarker(null), false)
    assert.equal(consumeExplicitReplyMarker(undefined), false)
    assert.equal(consumeExplicitReplyMarker(''), false)
  })

  it('marker path is scoped under the shared connections dir, keyed by connection id', () => {
    const p = explicitReplyMarkerPath(testConnectionId)
    assert.equal(path.basename(p), `${testConnectionId}.explicit-reply`)
    assert.equal(path.dirname(p), path.join(os.homedir(), '.devspec', 'remote-control', 'connections'))
  })
})

/*
 * Listener enforcement — items 8b4ceaa3 (a missed re-arm silently stops delivery)
 * and d655b2a4 (exit 1 conflates "re-arm me" with "connection is over").
 *
 * The guarantee under test: a turn cannot end leaving this connection deaf. These
 * encode the 2026-07-30 incident — poller alive, Agents page Live, two owner
 * commands sitting in the inbox, and nothing listening.
 */
describe('isListenerArmed', () => {
  it('is false with no pidfile at all — nothing has ever armed', () => {
    withConnDir(({ dir, conn }) => {
      assert.equal(isListenerArmed(conn, dir), false)
    })
  })

  it('is TRUE for a live pid', () => {
    withConnDir(({ dir, conn, writePid }) => {
      writePid(process.pid)
      assert.equal(isListenerArmed(conn, dir), true)
    })
  })

  it('is false for a STALE pidfile — a SIGKILLed wait never cleans up after itself', () => {
    // The critical case: believing a stale file would recreate the exact bug this
    // check exists to catch (something claiming the connection can hear when it
    // cannot). Liveness must be proved by the pid, never by the file existing.
    withConnDir(({ dir, conn, writePid }) => {
      writePid(DEAD_PID)
      assert.equal(isListenerArmed(conn, dir), false)
    })
  })

  it('is false for garbage in the pidfile', () => {
    withConnDir(({ dir, conn, writePid }) => {
      writePid('not-a-pid')
      assert.equal(isListenerArmed(conn, dir), false)
    })
  })

  it('is false without a connection id', () => {
    assert.equal(isListenerArmed(null), false)
  })
})

describe('countUnreadOwnerCommands', () => {
  it('counts owner commands past the wait cursor', () => {
    withConnDir(({ dir, conn, writeInbox }) => {
      writeInbox([
        canonicalCommands([{ id: 'm1' }, { id: 'm2' }]),
      ])
      assert.equal(countUnreadOwnerCommands(conn, 0, dir), 2)
    })
  })

  it('ignores advisory context — it never warranted a wake, so it must not hold a turn open', () => {
    withConnDir(({ dir, conn, writeInbox }) => {
      writeInbox([
        { type: 'canonical_context', ingress: { commands: [], context: [{ id: 'a1' }, { id: 'a2' }] } },
        canonicalCommands([{ id: 'm1' }]),
      ])
      assert.equal(countUnreadOwnerCommands(conn, 0, dir), 1)
    })
  })

  it('counts only what is PAST the offset — already-consumed mail is not unread', () => {
    withConnDir(({ dir, conn, writeInbox }) => {
      const consumed = JSON.stringify(canonicalCommands([{ id: 'old' }])) + '\n'
      writeInbox([
        canonicalCommands([{ id: 'old' }]),
        canonicalCommands([{ id: 'new' }]),
      ])
      assert.equal(countUnreadOwnerCommands(conn, Buffer.byteLength(consumed, 'utf8'), dir), 1)
    })
  })

  it('is 0 when the cursor is at the end — the healthy steady state', () => {
    withConnDir(({ dir, conn, writeInbox }) => {
      writeInbox([canonicalCommands([{ id: 'm1' }])])
      const size = fs.statSync(path.join(dir, `${conn}.inbox.jsonl`)).size
      assert.equal(countUnreadOwnerCommands(conn, size, dir), 0)
    })
  })

  it('ignores an incomplete trailing line the poller is still writing', () => {
    withConnDir(({ dir, conn, writeInbox, appendRaw }) => {
      writeInbox([canonicalCommands([{ id: 'm1' }])])
      appendRaw('{"type":"canonical_commands","ingress":{"commands":[{"id":"hal')
      assert.equal(countUnreadOwnerCommands(conn, 0, dir), 1)
    })
  })

  it('treats an unknown offset as "all read" rather than inventing a backlog', () => {
    withConnDir(({ dir, conn, writeInbox }) => {
      writeInbox([canonicalCommands([{ id: 'm1' }])])
      assert.equal(countUnreadOwnerCommands(conn, undefined, dir), 0)
    })
  })

  it('is 0 when no inbox file exists yet', () => {
    withConnDir(({ dir, conn }) => {
      assert.equal(countUnreadOwnerCommands(conn, 0, dir), 0)
    })
  })
})

describe('parseStopHookActive', () => {
  it('reads the harness loop guard', () => {
    assert.equal(parseStopHookActive('{"stop_hook_active":true}'), true)
    assert.equal(parseStopHookActive('{"stop_hook_active":false}'), false)
  })

  it('defaults to false on absent or unparseable input', () => {
    assert.equal(parseStopHookActive('{}'), false)
    assert.equal(parseStopHookActive('not json'), false)
    assert.equal(parseStopHookActive(''), false)
  })
})

describe('decideStopBlock', () => {
  it('BLOCKS a turn ending with no listener and stranded owner mail', () => {
    withConnDir(({ dir, conn, writeInbox }) => {
      writeInbox([canonicalCommands([{ id: 'm1' }, { id: 'm2' }])])
      const reason = decideStopBlock({ connectionId: conn, inboxOffset: 0, armed: false, dir })
      assert.ok(reason, 'must refuse the stop')
      assert.match(reason, /2 owner command/)
      // Must tell the agent the connection is FINE — the harmful reflex this bug
      // provokes is concluding a disconnect and re-registering.
      assert.match(reason, /Nothing is broken/)
      assert.match(reason, /--pending/)
    })
  })

  it('BLOCKS a turn ending with no listener even when no mail has arrived yet', () => {
    withConnDir(({ dir, conn }) => {
      const reason = decideStopBlock({ connectionId: conn, inboxOffset: 0, armed: false, dir })
      assert.ok(reason)
      assert.match(reason, /NO wake listener armed/)
      assert.match(reason, /--pending/)
    })
  })

  it('does NOT block when a listener is armed — unread mail is that listener\'s job', () => {
    withConnDir(({ dir, conn, writeInbox }) => {
      writeInbox([canonicalCommands([{ id: 'm1' }])])
      assert.equal(decideStopBlock({ connectionId: conn, inboxOffset: 0, armed: true, dir }), null)
    })
  })

  it('does NOT block twice — stop_hook_active wins over everything', () => {
    withConnDir(({ dir, conn, writeInbox }) => {
      writeInbox([canonicalCommands([{ id: 'm1' }])])
      assert.equal(
        decideStopBlock({ connectionId: conn, inboxOffset: 0, armed: false, stopHookActive: true, dir }),
        null,
      )
    })
  })

  it('does nothing without a connection — a non-remote session must never be held open', () => {
    assert.equal(decideStopBlock({ connectionId: null, armed: false }), null)
    assert.equal(decideStopBlock({}), null)
  })

  it('points the way out at Monitor on either schema, and never at a background task', () => {
    withConnDir(({ dir, conn }) => {
      const reason = decideStopBlock({ connectionId: conn, inboxOffset: 0, armed: false, dir })
      // Item be0a929a: the block was correct, but its remediation named a TURN-scoped
      // arm. On a host that reaps at turn end the agent complied, got reaped, and was
      // blocked again — one model turn per lap, with no exit. The way out has to be the
      // arm that outlives the turn.
      assert.match(reason, /--stream/)
      // Both Monitor schemas must be covered: `persistent` where the host offers it, and
      // a capped `timeout_ms` re-armed at expiry where it does not — on that one
      // `persistent: true` is accepted and silently discarded, so naming it alone would
      // leave the agent believing it holds a session-scoped arm it does not have.
      assert.match(reason, /persistent: true/)
      assert.match(reason, /timeout_ms/)
      // The regression this pins. The remediation used to offer a background task as the
      // fallback "if this host has no persistent monitor" — which is verbatim the
      // be0a929a configuration, on the host where it loops.
      assert.doesNotMatch(reason, /fall back[^.]*background/i)
    })
  })

  it('never blocks the healthy steady state (armed, cursor at end)', () => {
    withConnDir(({ dir, conn, writeInbox }) => {
      writeInbox([canonicalCommands([{ id: 'm1' }])])
      const size = fs.statSync(path.join(dir, `${conn}.inbox.jsonl`)).size
      assert.equal(decideStopBlock({ connectionId: conn, inboxOffset: size, armed: true, dir }), null)
    })
  })
})

describe('listenerArmedWithGrace', () => {
  it('tolerates the spawn race — a listener that appears on a later probe counts', async () => {
    // The agent arms the wait as a background task and can finish its turn before
    // that process writes its pidfile. A single probe would block a turn that did
    // everything right.
    let calls = 0
    const armed = await listenerArmedWithGrace('conn', {
      attempts: 4,
      delayMs: 1,
      probe: () => ++calls >= 3,
    })
    assert.equal(armed, true)
    assert.equal(calls, 3)
  })

  it('gives up after its attempts and reports genuinely unarmed', async () => {
    let calls = 0
    const armed = await listenerArmedWithGrace('conn', {
      attempts: 3,
      delayMs: 1,
      probe: () => {
        calls++
        return false
      },
    })
    assert.equal(armed, false)
    assert.equal(calls, 3)
  })

  it('returns immediately on the first probe when already armed', async () => {
    let calls = 0
    const armed = await listenerArmedWithGrace('conn', {
      delayMs: 10_000,
      probe: () => {
        calls++
        return true
      },
    })
    assert.equal(armed, true)
    assert.equal(calls, 1)
  })
})

describe('stopBondDiagnostic — a turn that will not end says why (item 3b88955e)', () => {
  const CONNECTION = '6218f6fa-798e-4b5e-a98b-d440e3f61f57'

  function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-stop-diag-'))
  }

  it('says nothing for an ordinary unconnected conversation', () => {
    const dir = tempDir()
    try {
      assert.equal(stopBondDiagnostic(dir), null)
      fs.writeFileSync(
        path.join(dir, `${CONNECTION}.json`),
        JSON.stringify({ connection_id: CONNECTION, local_id: 'someone-else', enabled: true }),
      )
      assert.equal(stopBondDiagnostic(dir), null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names a state file it could not read', () => {
    const dir = tempDir()
    try {
      fs.writeFileSync(path.join(dir, `${CONNECTION}.json`), '{"connection_id":"x","tok')
      const reason = stopBondDiagnostic(dir)
      assert.match(reason ?? '', /unreadable/)
      assert.match(reason ?? '', new RegExp(CONNECTION))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names a wiped bond only while a live poller still holds the turn open', () => {
    const dir = tempDir()
    try {
      // The exact residue of the clobber: cursor fields, no local_id.
      fs.writeFileSync(
        path.join(dir, `${CONNECTION}.json`),
        JSON.stringify({ connection_id: CONNECTION, inbox_byte_offset: 12, cursor_v2: 'x' }),
      )
      // No marker yet: nothing is stuck, so nothing to say.
      fs.writeFileSync(path.join(dir, `${CONNECTION}.poll.pid`), String(process.pid))
      assert.equal(stopBondDiagnostic(dir), null)

      // Marker + live poller: a turn is being held open by a connection nobody can end.
      fs.writeFileSync(path.join(dir, `${CONNECTION}.turn`), JSON.stringify({ startedAt: Date.now() }))
      const reason = stopBondDiagnostic(dir)
      assert.match(reason ?? '', /lost its bond/)
      assert.match(reason ?? '', new RegExp(CONNECTION))

      // Dead poller: the wiped file harms nobody, so stay quiet.
      fs.writeFileSync(path.join(dir, `${CONNECTION}.poll.pid`), String(DEAD_PID))
      assert.equal(stopBondDiagnostic(dir), null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('backgroundHoldDecision — a Stop that only waits on background work keeps the command open (item f4a79327)', () => {
  const NOW = Date.parse('2026-10-04T17:30:52.000Z')
  const startedAt = NOW - 10_000
  const job = { toolUseId: 'toolu_A', taskId: 'bxhtqls7l', tool: 'Bash', description: 'Sleep 40 seconds' }

  it('holds while a job launched during this command is still running', () => {
    const seen = []
    const hold = backgroundHoldDecision({
      marker: { startedAt },
      transcriptPath: '/t.jsonl',
      now: NOW,
      readOutstanding: (file, since) => { seen.push([file, since]); return [job] },
    })
    assert.deepEqual(hold, [job])
    // The window is the command's own start: earlier jobs belong to earlier work.
    assert.deepEqual(seen, [['/t.jsonl', startedAt]])
  })

  it('ends the turn when nothing is left running', () => {
    assert.equal(backgroundHoldDecision({ marker: { startedAt }, transcriptPath: '/t.jsonl', now: NOW, readOutstanding: () => [] }), null)
  })

  it('never holds once the agent closed the turn itself (no marker)', () => {
    assert.equal(backgroundHoldDecision({ marker: null, transcriptPath: '/t.jsonl', now: NOW, readOutstanding: () => [job] }), null)
  })

  it('never holds a turn the poller has already let go (marker older than an hour)', () => {
    const hold = backgroundHoldDecision({
      marker: { startedAt: NOW - 60 * 60 * 1000 },
      transcriptPath: '/t.jsonl',
      now: NOW,
      readOutstanding: () => [job],
    })
    assert.equal(hold, null)
  })
})

describe('parseTranscriptPath', () => {
  it('reads transcript_path from the hook input', () => {
    assert.equal(parseTranscriptPath(JSON.stringify({ transcript_path: '/home/u/.claude/projects/p/s.jsonl' })), '/home/u/.claude/projects/p/s.jsonl')
  })
  it('returns null for missing or malformed input', () => {
    assert.equal(parseTranscriptPath('{}'), null)
    assert.equal(parseTranscriptPath('not json'), null)
    assert.equal(parseTranscriptPath(''), null)
  })
})

/**
 * Item beb0e005: the host's own in-flight list decides. Shapes are the ones Claude Code
 * 2.1.289 sent a probe on 2026-10-05, when one run started a background command and a
 * subagent and then ended its turn. The DevSpec listener is in the list as `shell`.
 */
describe('backgroundHoldDecision — Claude Code says what is still running (item beb0e005)', () => {
  const NOW = Date.parse('2026-10-05T15:30:00.000Z')
  const marker = { startedAt: NOW - 30_000 }
  const LISTENER = {
    id: 'bjc8wt84h',
    type: 'shell',
    status: 'running',
    description: 'DevSpec: messages sent to this agent (load the devspec-remote-command skill once per conversation, then answer each)',
  }
  const SHELL = { id: 'bvem1pf78', type: 'shell', status: 'running', description: 'Background sleep probe' }
  const SUBAGENT = { id: 'a9f2b562e4a5fba8e', type: 'subagent', status: 'running', description: 'sleep probe' }
  const neverTranscript = () => { throw new Error('the transcript must not be read when the host sends its list') }

  it('holds while a subagent this command launched is running, which the transcript reader never saw', () => {
    const hold = backgroundHoldDecision({
      marker,
      now: NOW,
      backgroundTasks: [LISTENER, SUBAGENT],
      ownedIds: [SUBAGENT.id],
      readOutstanding: neverTranscript,
    })
    assert.deepEqual(hold, [{ id: SUBAGENT.id, kind: 'subagent', description: 'sleep probe', status: 'running' }])
  })

  it('keeps holding after one job finishes while another is still running', () => {
    const hold = backgroundHoldDecision({
      marker,
      now: NOW,
      backgroundTasks: [LISTENER, SUBAGENT],
      ownedIds: [SHELL.id, SUBAGENT.id],
      readOutstanding: neverTranscript,
    })
    assert.deepEqual(hold.map((job) => job.id), [SUBAGENT.id])
  })

  it('never holds for the DevSpec listener, which is always running and never launched by the turn', () => {
    const hold = backgroundHoldDecision({
      marker,
      now: NOW,
      backgroundTasks: [LISTENER],
      ownedIds: [SHELL.id, SUBAGENT.id],
      readOutstanding: neverTranscript,
    })
    assert.equal(hold, null)
  })

  it('never holds for work an earlier command started', () => {
    const hold = backgroundHoldDecision({
      marker,
      now: NOW,
      backgroundTasks: [LISTENER, SHELL, SUBAGENT],
      ownedIds: [],
      readOutstanding: neverTranscript,
    })
    assert.equal(hold, null)
  })

  it('falls back to the transcript only when the host sends no list', () => {
    const job = { toolUseId: 'toolu_A', taskId: 'bxhtqls7l', tool: 'Bash', description: 'Sleep 40 seconds' }
    const hold = backgroundHoldDecision({
      marker,
      now: NOW,
      backgroundTasks: null,
      ownedIds: [],
      readOutstanding: () => [job],
    })
    assert.deepEqual(hold, [job])
  })
})

describe('recordOwnedLaunch / readOwnedIds — a turn owns the background work its tool calls start (item beb0e005)', () => {
  const CONNECTION = '11111111-2222-4333-8444-555555555555'
  const NOW = Date.parse('2026-10-05T15:30:00.000Z')
  function withDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-owned-'))
    try {
      return fn(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  const openTurn = (dir, startedAt) => fs.writeFileSync(turnMarkerPath(CONNECTION, dir), JSON.stringify({ startedAt }), { mode: 0o600 })

  it('records nothing when no turn is open', () => withDir((dir) => {
    assert.equal(recordOwnedLaunch(CONNECTION, { id: 'bx1', kind: 'shell' }, { dir, now: NOW }), false)
    assert.equal(fs.existsSync(ownedWorkPath(CONNECTION, dir)), false)
  }))

  it('records launches against the open turn, and a new command does not inherit them', () => withDir((dir) => {
    openTurn(dir, NOW - 5_000)
    assert.equal(recordOwnedLaunch(CONNECTION, { id: 'bx1', kind: 'shell' }, { dir, now: NOW }), true)
    assert.equal(recordOwnedLaunch(CONNECTION, { id: 'a1', kind: 'subagent' }, { dir, now: NOW }), true)
    assert.deepEqual(readOwnedIds(CONNECTION, { startedAt: NOW - 5_000 }, dir), ['bx1', 'a1'])
    // The poller picks up the next command by writing a new start.
    openTurn(dir, NOW + 1_000)
    assert.deepEqual(readOwnedIds(CONNECTION, { startedAt: NOW + 1_000 }, dir), [])
  }))

  it('keeps every id when launches finish together in separate processes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-owned-'))
    try {
      openTurn(dir, NOW - 5_000)
      const { spawn } = await import('node:child_process')
      const script = `import { recordOwnedLaunch } from ${JSON.stringify(new URL('./mirror-turn.mjs', import.meta.url).href)}
        recordOwnedLaunch(process.argv[1], { id: process.argv[2], kind: 'shell' }, { dir: process.argv[3], now: ${NOW} })`
      const ids = Array.from({ length: 12 }, (_, i) => `b${i}`)
      await Promise.all(ids.map((id) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, CONNECTION, id, dir], { stdio: 'ignore' })
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
      })))
      assert.deepEqual(readOwnedIds(CONNECTION, { startedAt: NOW - 5_000 }, dir).sort(), [...ids].sort())
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records the id from the tool result Claude Code hands PostToolUse', () => {
    // The conversation is resolved the way every hook resolves it (resolveHookConversationId);
    // which id that is depends on the environment the test runs in, so the stub accepts any.
    const recorded = []
    const load = () => ({ connection_id: CONNECTION })
    const record = (connectionId, launch) => { recorded.push([connectionId, launch]); return true }
    const post = (tool_name, tool_response) => JSON.stringify({ session_id: 'conv-1', hook_event_name: 'PostToolUse', tool_name, tool_response })
    assert.ok(recordBackgroundLaunch(post('Agent', { agentId: 'a9f2b562e4a5fba8e', status: 'async_launched', isAsync: true }), { load, record }))
    assert.equal(recordBackgroundLaunch(post('Bash', { stdout: '', stderr: '', interrupted: false }), { load, record }), false)
    assert.deepEqual(recorded, [[CONNECTION, { id: 'a9f2b562e4a5fba8e', kind: 'subagent' }]])
    // A conversation with no connection records nothing.
    assert.equal(recordBackgroundLaunch(post('Bash', { backgroundTaskId: 'bx9' }), { load: () => null, record }), false)
  })
})
