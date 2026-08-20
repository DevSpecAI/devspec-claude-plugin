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
} from './mirror-turn.mjs'

/** A pid above any plausible pid_max — guaranteed ESRCH, i.e. provably dead. */
const DEAD_PID = 2147483646

function canonicalCommands(messages) {
  return { type: 'canonical_commands', ingress: { commands: messages } }
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

  it('resolves a non-Claude tool env id via the shared detectLocalId', () => {
    assert.equal(resolveHookConversationId('{}', { GROK_SESSION_ID: 'grok-conv' }), 'grok-conv')
    assert.equal(resolveHookConversationId('{}', { CODEX_THREAD_ID: 'codex-conv' }), 'codex-conv')
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

  it('points the way out at the SESSION-scoped stream, not a reapable background task', () => {
    withConnDir(({ dir, conn }) => {
      const reason = decideStopBlock({ connectionId: conn, inboxOffset: 0, armed: false, dir })
      // Item be0a929a: the block was correct, but its remediation named a TURN-scoped
      // arm. On a host that reaps at turn end the agent complied, got reaped, and was
      // blocked again — one model turn per lap, with no exit. The way out has to be the
      // arm that outlives the turn.
      assert.match(reason, /--stream/)
      assert.match(reason, /persistent: true/)
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
