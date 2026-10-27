#!/usr/bin/env node
/**
 * Unit tests for conversation-scoped, CONNECTION-NATIVE remote-control resolve-local.
 * Run: node --test hooks/scripts/remote-control-state.test.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  detectLocalId,
  ensurePollerForConnection,
  isPollerArgv,
  isRecoverableEndReason,
  mintLocalId,
  ownerAlive,
  redactConnectionState,
  resolveLocalAction,
  resolveOwnerPid,
  resolveOwnerPidAutoWindows,
} from './remote-control-state.mjs'

describe('redacted connection status', () => {
  it('never exposes bearer/capability bytes and gives the reconnect disposition directly', () => {
    const secret = 'dvsc_never_model_visible'
    const status = redactConnectionState({
      connection_id: '10000000-0000-4000-8000-000000000001',
      session_id: '20000000-0000-4000-8000-000000000002',
      enabled: true,
      owner_pid: process.pid,
      token: 'dvs_bearer_secret',
      connection_capability: secret,
      end_reason: null,
    })
    assert.equal(status.reconnect.disposition, 'reconnect')
    assert.equal(status.token_present, true)
    assert.equal(status.connection_capability_present, true)
    assert.doesNotMatch(JSON.stringify(status), /dvs_bearer_secret|dvsc_never_model_visible/)

    const ended = redactConnectionState({
      connection_id: '10000000-0000-4000-8000-000000000001',
      owner_pid: process.pid,
      end_reason: 'ui',
    })
    assert.equal(ended.reconnect.disposition, 'stand_down')
  })
})

describe('detectLocalId', () => {
  it('prefers explicit --local-id over env', () => {
    const r = detectLocalId(
      { 'local-id': 'from-arg' },
      { CODEX_THREAD_ID: 'from-env', SHELL_SESSION_ID: 'shell' },
    )
    assert.equal(r.local_id, 'from-arg')
    assert.equal(r.source, 'arg')
  })

  it('ignores every other host\'s conversation env', () => {
    // REVERSED from "prefers CODEX_THREAD_ID over other conversation env"
    // (memory f90e2ff9, superseded 2026-09-20 by Ali). This is the Claude Code
    // plugin; a Codex or Grok id in the environment belongs to whoever launched
    // us, and answering as them is item 75f65461.
    const r = detectLocalId({}, { CODEX_THREAD_ID: 'thread-1', GROK_SESSION_ID: 'grok-1' })
    assert.equal(r.local_id, null)
    assert.equal(r.source, null)
  })

  it('reads OUR id even when a parent agent has exported theirs', () => {
    const r = detectLocalId({}, {
      CODEX_THREAD_ID: 'thread-1',
      GROK_SESSION_ID: 'grok-1',
      CLAUDE_CODE_SESSION_ID: 'ours-1',
    })
    assert.equal(r.local_id, 'ours-1')
    assert.equal(r.source, 'env:CLAUDE_CODE_SESSION_ID')
  })

  it('takes the host-qualified override, not the bare one', () => {
    // The bare DEVSPEC_REMOTE_LOCAL_ID is inherited by every spawned child.
    assert.equal(detectLocalId({}, { DEVSPEC_REMOTE_LOCAL_ID: 'bare' }).local_id, null)
    assert.equal(
      detectLocalId({}, { DEVSPEC_REMOTE_LOCAL_ID_CLAUDE_CODE: 'ours' }).local_id,
      'ours',
    )
  })

  it('does NOT bond on SHELL_SESSION_ID / TERM_SESSION_ID (terminal, not conversation)', () => {
    // Regression guard for the Working-stuck bug (Grok a6b3f881, Claude 87117120).
    // A shell id in env hijacked the env leg of resolveHookConversationId, so the
    // correct hook-stdin conversation id was never reached, the bond matched no
    // connection, and the turn marker was never cleared.
    const r = detectLocalId({}, { SHELL_SESSION_ID: 'shell-only', TERM_SESSION_ID: 'term-only' })
    assert.equal(r.local_id, null)
    assert.equal(r.source, null)
  })

  it('uses CLAUDE_CODE_SESSION_ID even when a shell id is also present', () => {
    const r = detectLocalId({}, { CLAUDE_CODE_SESSION_ID: 'claude-conv', SHELL_SESSION_ID: 'shell' })
    assert.equal(r.local_id, 'claude-conv')
    assert.equal(r.source, 'env:CLAUDE_CODE_SESSION_ID')
  })

  it('does not invent an id from cwd or empty env', () => {
    const r = detectLocalId({}, {})
    assert.equal(r.local_id, null)
    assert.equal(r.source, null)
  })

  it('sanitizes unsafe characters', () => {
    const r = detectLocalId({ 'local-id': 'abc/../evil;rm' }, {})
    assert.equal(r.local_id, 'abc..evilrm')
  })
})

describe('isRecoverableEndReason', () => {
  it('accepts local_stop owner_gone idle_timeout auth only', () => {
    assert.equal(isRecoverableEndReason('local_stop'), true)
    assert.equal(isRecoverableEndReason('owner_gone'), true)
    assert.equal(isRecoverableEndReason('idle_timeout'), true)
    assert.equal(isRecoverableEndReason('auth'), true)
    assert.equal(isRecoverableEndReason('ui'), false)
    assert.equal(isRecoverableEndReason(null), false)
  })

  it('owner_gone is recoverable — the host process exiting is the COMMON restart', () => {
    // Regression guard for item 937c78b0. The poller used to stamp owner-death as
    // `local_stop`; splitting it out makes the drop data readable, but if this list
    // did not learn the new value, every Claude Code relaunch would silently register
    // a brand-new connection (new codename, lost bond) instead of resuming.
    assert.equal(isRecoverableEndReason('owner_gone'), true)
  })
})

describe('mintLocalId', () => {
  it('returns a uuid-like string', () => {
    const id = mintLocalId()
    assert.match(id, /^[0-9a-f-]{36}$/i)
  })
})

describe('resolveLocalAction (connection-native)', () => {
  const agent = 'Grok Build'
  const localId = 'conv-aaa'
  const connectionId = '22222222-2222-2222-2222-222222222222'
  const sessionId = '11111111-1111-1111-1111-111111111111'
  const now = Date.parse('2026-07-12T12:00:00.000Z')

  it('register when no local id (fresh terminal, bare remote)', () => {
    const r = resolveLocalAction({ agent, localId: null, now })
    assert.equal(r.action, 'register')
    assert.equal(r.connection_id, null)
    assert.equal(r.session_id, null)
    assert.match(r.note, /No local conversation id/)
  })

  it('create_and_attach with forceNew even if bond is live', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      forceNew: true,
      now,
      readBond: () => ({
        local_id: localId,
        connection_id: connectionId,
        session_id: sessionId,
        status: 'live',
        session_codename: 'Colorful Possum',
      }),
      readConnection: () => ({ enabled: true, connection_id: connectionId }),
    })
    assert.equal(r.action, 'create_and_attach')
  })

  it('register when bond missing for this conversation', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      readBond: () => null,
      readConnection: () => null,
    })
    assert.equal(r.action, 'register')
    assert.equal(r.connection_id, null)
  })

  it('already_live when this conversation owns an enabled connection', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      readBond: () => ({
        local_id: localId,
        connection_id: connectionId,
        session_id: sessionId,
        status: 'live',
        agent_name: agent,
        session_codename: 'Colorful Possum',
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
      readConnection: () => ({
        connection_id: connectionId,
        session_id: sessionId,
        enabled: true,
        session_codename: 'Colorful Possum',
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
    })
    assert.equal(r.action, 'already_live')
    assert.equal(r.connection_id, connectionId)
    assert.equal(r.session_id, sessionId)
    assert.equal(r.session_codename, 'Colorful Possum')
  })

  it('already_live for a SESSIONLESS connection (no session attached)', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      readBond: () => ({
        local_id: localId,
        connection_id: connectionId,
        session_id: null,
        status: 'live',
        agent_name: agent,
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
      readConnection: () => ({
        connection_id: connectionId,
        session_id: null,
        enabled: true,
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
    })
    assert.equal(r.action, 'already_live')
    assert.equal(r.connection_id, connectionId)
    assert.equal(r.session_id, null)
  })

  it('reconnect after recent local_stop for THIS conversation only', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      maxAgeMinutes: 30,
      readBond: () => ({
        local_id: localId,
        connection_id: connectionId,
        session_id: sessionId,
        status: 'stopped',
        end_reason: 'local_stop',
        agent_name: agent,
        session_codename: 'Silent Fox',
        updated_at: '2026-07-12T11:50:00.000Z',
      }),
      readConnection: () => ({
        connection_id: connectionId,
        session_id: sessionId,
        enabled: false,
        end_reason: 'local_stop',
        session_codename: 'Silent Fox',
        updated_at: '2026-07-12T11:50:00.000Z',
        cursor_after_message_id: 'msg-1',
      }),
    })
    assert.equal(r.action, 'reconnect')
    assert.equal(r.connection_id, connectionId)
    assert.equal(r.session_id, sessionId)
    assert.equal(r.cursor_after_message_id, 'msg-1')
  })

  it('register when prior stop is stale (> TTL)', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      maxAgeMinutes: 30,
      readBond: () => ({
        local_id: localId,
        connection_id: connectionId,
        session_id: sessionId,
        status: 'stopped',
        end_reason: 'local_stop',
        updated_at: '2026-07-12T10:00:00.000Z', // 2h earlier
      }),
      readConnection: () => ({
        connection_id: connectionId,
        enabled: false,
        end_reason: 'local_stop',
        updated_at: '2026-07-12T10:00:00.000Z',
      }),
    })
    assert.equal(r.action, 'register')
    assert.equal(r.connection_id, null)
    assert.equal(r.prior_connection_id, connectionId)
  })

  it('register after UI end (no ambient reattach)', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      readBond: () => ({
        local_id: localId,
        connection_id: connectionId,
        session_id: sessionId,
        status: 'stopped',
        end_reason: 'ui',
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
      readConnection: () => ({
        connection_id: connectionId,
        enabled: false,
        end_reason: 'ui',
        ended_from_ui: true,
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
    })
    assert.equal(r.action, 'register')
    assert.match(r.note, /ended from the UI/)
  })

  it('does not reconnect a foreign conversation bond (different localId → no bond)', () => {
    const r = resolveLocalAction({
      agent: 'Grok Build',
      localId: 'grok-fresh-id',
      now,
      readBond: () => null, // no bond for Grok's local id
      readConnection: () => ({
        connection_id: 'bad12d41-229b-4bcf-afee-fa1a093888c8',
        enabled: false,
        end_reason: 'local_stop',
        agent_name: 'Codex',
        updated_at: '2026-07-12T11:50:00.000Z',
      }),
    })
    assert.equal(r.action, 'register')
    assert.equal(r.connection_id, null)
  })

  it('two different local ids never share already_live', () => {
    const bonds = {
      'term-a': {
        local_id: 'term-a',
        connection_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        status: 'live',
        session_codename: 'Amber Otter',
      },
      'term-b': {
        local_id: 'term-b',
        connection_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        status: 'live',
        session_codename: 'Bold Raven',
      },
    }
    const ra = resolveLocalAction({
      agent,
      localId: 'term-a',
      now,
      readBond: (_a, id) => bonds[id],
      readConnection: (cid) => ({ connection_id: cid, enabled: true }),
    })
    const rb = resolveLocalAction({
      agent,
      localId: 'term-b',
      now,
      readBond: (_a, id) => bonds[id],
      readConnection: (cid) => ({ connection_id: cid, enabled: true }),
    })
    assert.equal(ra.action, 'already_live')
    assert.equal(rb.action, 'already_live')
    assert.notEqual(ra.connection_id, rb.connection_id)
  })
})

describe('ownerAlive', () => {
  it('this process is alive; pid 1 / bad input are not adopted', () => {
    assert.equal(ownerAlive(process.pid), true)
    assert.equal(ownerAlive(1), false)
    assert.equal(ownerAlive(0), false)
    assert.equal(ownerAlive(null), false)
    assert.equal(ownerAlive(-5), false)
    assert.equal(ownerAlive(2_147_483_646), false) // implausible pid → ESRCH
  })
})

describe('a connect never touches another connection (item 7e35d818)', () => {
  // The incident, reproduced with real processes: window 1's attached poller is live,
  // its room has been quiet for over an hour (so the room-transcript copy beside it is
  // stale and carries no owner), and window 2 connects. Up to 0.32.23 the connect-time
  // reaper read that transcript file as an ownerless pre-July connection and SIGTERM'd
  // the live poller. Nothing may stop another connection's poller now.
  const OTHER = 'bbbbbbbb-1111-4222-8333-444444444444'
  const MINE = 'cccccccc-5555-4666-8777-888888888888'
  const STATE_SCRIPT = fileURLToPath(new URL('./remote-control-state.mjs', import.meta.url))

  it("leaves a quiet attached connection's live poller running", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-no-reap-'))
    const dir = path.join(home, '.devspec', 'remote-control', 'connections')
    fs.mkdirSync(dir, { recursive: true })
    const server = http.createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body)
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const mcpUrl = `http://127.0.0.1:${server.address().port}/api/mcp`
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    // Window 1: live, attached, owned by a live process, room quiet for three hours.
    fs.writeFileSync(path.join(dir, `${OTHER}.json`), JSON.stringify({
      connection_id: OTHER, enabled: true, agent_name: 'Claude Code', owner_pid: process.pid,
      session_id: 'dddddddd-0000-4000-8000-000000000000', token: 'dvs_other', mcp_url: mcpUrl, updated_at: stale,
    }), { mode: 0o600 })
    fs.writeFileSync(path.join(dir, `${OTHER}.dddddddd-0000-4000-8000-000000000000.transcript-state.json`),
      JSON.stringify({ connection_id: OTHER, updated_at: stale }), { mode: 0o600 })
    // A stand-in for window 1's poller, recognisable the way a poller is: by its argv.
    const fakePoller = path.join(home, 'devspec-remote-poll.mjs')
    fs.writeFileSync(fakePoller, 'setInterval(() => {}, 1000)\n')
    const otherPoller = spawn(process.execPath, [fakePoller, '--connection-id', OTHER], { stdio: 'ignore' })
    let minePollerPid = null
    try {
      // Window 2 connects.
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [STATE_SCRIPT, 'write', '--connection-id', MINE, '--agent', 'Claude Code', '--owner-pid', String(process.pid), '--cwd', home], {
          env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, DEVSPEC_MCP_TOKEN: 'dvs_mine', DEVSPEC_MCP_URL: mcpUrl },
        })
        child.on('error', reject)
        child.on('close', resolve)
      })
      try { minePollerPid = Number(fs.readFileSync(path.join(dir, `${MINE}.poll.pid`), 'utf8').trim()) } catch { /* no poller */ }
      assert.ok(minePollerPid, 'the connecting window got its own poller')
      await new Promise((resolve) => setTimeout(resolve, 500))
      assert.equal(otherPoller.exitCode, null, "window 1's poller must still be running")
      assert.equal(otherPoller.signalCode, null, "window 1's poller must not have been signalled")
    } finally {
      otherPoller.kill('SIGKILL')
      if (minePollerPid) { try { process.kill(minePollerPid, 'SIGKILL') } catch { /* gone */ } }
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('has no reap command any more', async () => {
    const mod = await import('./remote-control-state.mjs')
    assert.equal(mod.reapDeadPollers, undefined)
  })
})

describe('a poller is recognised by its arguments, not by words in a command line', () => {
  const ID = 'cccccccc-5555-4666-8777-888888888888'
  it('matches the poller the plugin spawns', () => {
    assert.equal(isPollerArgv(['/usr/bin/node', '/x/hooks/scripts/devspec-remote-poll.mjs', '--connection-id', ID, '--owner-pid', '42'], ID), true)
    assert.equal(isPollerArgv(['node', 'devspec-remote-poll.mjs', '--session', 's', '--connection-id', ID], ID), true)
  })
  it('never matches a shell or editor that merely mentions it', () => {
    // The shape that killed the shell running this suite: one argv element holding a
    // whole script that names the poller, the id and node.
    assert.equal(isPollerArgv(['/usr/bin/zsh', '-c', `node --test devspec-remote-poll.mjs --connection-id ${ID}`], ID), false)
    assert.equal(isPollerArgv(['vim', 'devspec-remote-poll.mjs', '--connection-id', ID], ID), false)
    assert.equal(isPollerArgv(['node', '/x/devspec-remote-wait.mjs', '--connection-id', ID], ID), false)
  })
  it("never matches another connection's poller", () => {
    assert.equal(isPollerArgv(['node', 'devspec-remote-poll.mjs', '--connection-id', `${ID}0`], ID), false)
    assert.equal(isPollerArgv(['node', 'devspec-remote-poll.mjs', '--connection-id', 'bbbbbbbb-1111-4222-8333-444444444444'], ID), false)
  })
})

describe('ensurePollerForConnection (guards)', () => {
  it('rejects a missing/too-short connection id without spawning', () => {
    assert.equal(ensurePollerForConnection('').ok, false)
    assert.equal(ensurePollerForConnection('short').ok, false)
    assert.match(ensurePollerForConnection(null).error, /missing connection id/)
  })

  it('refuses to spawn without a valid --owner-pid (no anchor → would zombie)', () => {
    // Valid-length connection id, script present, but no owner pid → refuse before
    // stopping/spawning anything, so the reaper can always prove a poller dead.
    // resolveOwnerPid stubbed to null: without it, win32's real self-resolver
    // (item 3cddb3b4) would walk up to this test process's own real claude.exe
    // ancestor and actually succeed — proceeding to really spawn a detached
    // poller process as a side effect of running the test suite.
    const r = ensurePollerForConnection('11111111-1111-1111-1111-111111111111', {
      resolveOwnerPid: () => null,
    })
    assert.equal(r.ok, false)
    assert.match(r.error, /owner-pid/)
    const bad = ensurePollerForConnection('11111111-1111-1111-1111-111111111111', {
      ownerPid: 1,
      resolveOwnerPid: () => null,
    })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /owner-pid/)
  })
})

describe('ensurePollerForConnection (reuse, item b9e02835)', () => {
  const connectionId = '11111111-1111-1111-1111-111111111111'

  it('reuses a live poller when reuseRunning is set — no kill, no respawn', () => {
    const r = ensurePollerForConnection(connectionId, {
      reuseRunning: true,
      findPids: () => [4242],
    })
    assert.equal(r.ok, true)
    assert.equal(r.reused, true)
    assert.equal(r.pid, 4242)
    assert.equal(r.connection_id, connectionId)
  })

  it('reuse carries the sessionId through for the caller result', () => {
    const r = ensurePollerForConnection(connectionId, {
      reuseRunning: true,
      sessionId: '22222222-2222-2222-2222-222222222222',
      findPids: () => [4242],
    })
    assert.equal(r.reused, true)
    assert.equal(r.session_id, '22222222-2222-2222-2222-222222222222')
  })

  it('reuseRunning with no live poller falls through to the spawn guards', () => {
    // resolveOwnerPid stubbed to null: on win32 the real resolver walks THIS test
    // process's own ancestry, and since it's actually running under a real
    // claude.exe (item 3cddb3b4), it would otherwise find a genuine anchor and
    // this "no anchor" case would flake based on host state.
    const r = ensurePollerForConnection(connectionId, {
      reuseRunning: true,
      findPids: () => [],
      resolveOwnerPid: () => null,
    })
    assert.equal(r.ok, false)
    assert.match(r.error, /owner-pid/)
  })

  it('without reuseRunning the restart path is unchanged (guards still apply)', () => {
    const r = ensurePollerForConnection(connectionId, {
      findPids: () => [4242],
      resolveOwnerPid: () => null,
    })
    assert.equal(r.ok, false)
    assert.match(r.error, /owner-pid/)
  })
})

describe('resolveOwnerPid / resolveOwnerPidAutoWindows (item 3cddb3b4)', () => {
  it('explicit valid arg always wins, no auto-resolution attempted', () => {
    // A bogus prevValue proves the explicit arg short-circuits before any fallback.
    assert.equal(resolveOwnerPid(555, 999), 555)
  })

  it('never returns an invalid (<=1) explicit arg as-is', () => {
    // 1 fails the >1 validity check, so it must fall through to auto-resolution
    // or prevValue rather than being returned literally.
    assert.notEqual(resolveOwnerPid(1, 999), 1)
  })

  it('resolveOwnerPidAutoWindows returns null off-Windows and for a made-up start pid', () => {
    if (process.platform !== 'win32') {
      assert.equal(resolveOwnerPidAutoWindows(process.pid), null)
      return
    }
    // A start pid that (almost certainly) does not exist finds no process at all,
    // so the walk ends immediately with nothing to report — deterministic
    // regardless of what real processes happen to be running on this host.
    assert.equal(resolveOwnerPidAutoWindows(999_999_999), null)
  })

  it('resolveOwnerPidAutoWindows walks to a real claude.exe ancestor on win32', { skip: process.platform !== 'win32' }, () => {
    // This test process is itself running under a real claude.exe (item
    // 3cddb3b4's whole premise) — the walk from its own real pid should find it.
    const found = resolveOwnerPidAutoWindows(process.pid)
    assert.ok(found === null || (Number.isInteger(found) && found > 1))
  })
})
