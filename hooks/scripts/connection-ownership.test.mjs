#!/usr/bin/env node
/**
 * A connection lasts until a person ends it, and only its owner acts on it
 * (item 7e35d818). Run: node --test hooks/scripts/connection-ownership.test.mjs
 *
 * Ownership is the connection state's `owner_pid`, written by connect. Resuming a
 * conversation in another window connects it from there, which moves it; the window it
 * moved away from must then stand back — no second reader, no mirroring, and closing it
 * must not end the connection it handed over.
 *
 * The process tests stand up fake Claude Code processes (a symlink to node named
 * `claude`), so they hold whether or not the suite itself runs under Claude Code.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

import { listenerHoldsWake, wakeHeldByThisProcess } from './devspec-remote-connect.mjs'
import { classifyConnection, POLLER_MISSES_BEFORE_REPAIR, reconcileStep } from './devspec-remote-listen.mjs'
import { EXIT_SUPERSEDED } from './devspec-remote-wait.mjs'
import { withoutConnectionsOwnedElsewhere } from './mirror-turn.mjs'
import {
  claudeProcessOf,
  ownedByAnotherProcess,
  ownedByProcess,
  readOwnedConnectionPointer,
  readOwnerListenerStatus,
  removeOwnerListenerFiles,
  writeOwnedConnectionPointer,
  writeOwnerListenerStatus,
} from './startup-listener.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LINUX = process.platform === 'linux'
const tmp = []
const children = []
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmp.push(dir)
  return dir
}
after(() => {
  for (const child of children) {
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }
  for (const dir of tmp) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

/**
 * The system shell, copied under the name `claude`, so the kernel reports it as Claude
 * Code exactly as it reports the real one. A symlink to node will not do (node renames
 * its own main thread), and neither will a multicall coreutils binary (it refuses to
 * run under a name it does not know).
 */
const SHELL = fs.realpathSync('/bin/sh')
function claudeBinary(dir) {
  const bin = path.join(dir, 'claude')
  fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(bin)) {
    fs.copyFileSync(SHELL, bin)
    fs.chmodSync(bin, 0o755)
  }
  return bin
}

/** A live process the plugin recognises as a Claude Code process. */
async function fakeClaude(dir, name = 'claude') {
  const bin = claudeBinary(path.join(dir, path.dirname(name)))
  // A loop, not a bare `sleep`: a shell may exec its last command, which would replace
  // the process this test needs to stay named `claude`.
  const child = spawn(bin, ['-c', 'while :; do sleep 1; done'], { stdio: 'ignore' })
  children.push(child)
  await new Promise((resolve) => setTimeout(resolve, 150))
  return child
}

const CONN = 'abcdef01-2345-4678-89ab-cdef01234567'

describe('who owns a connection', () => {
  // Injected world: pids 100 and 200 are two Claude Code processes; 101 is a shell
  // under 100; 300 is dead.
  const alive = (pid) => [100, 101, 200].includes(pid)
  const claudeOf = (pid) => ({ 100: 100, 101: 100, 200: 200 })[pid] ?? null
  const opts = { isAlive: alive, claudeOf }

  it('another live Claude Code process owns it after a resume elsewhere', () => {
    assert.equal(ownedByAnotherProcess({ owner_pid: 200 }, 100, opts), true)
    assert.equal(ownedByProcess({ owner_pid: 200 }, 100, opts), false)
  })

  it('a wrapper shell under the same Claude Code process is the same owner', () => {
    assert.equal(ownedByAnotherProcess({ owner_pid: 100 }, 101, opts), false)
    assert.equal(ownedByProcess({ owner_pid: 101 }, 100, opts), true)
  })

  it('a dead or unrecorded owner owns nothing, so nobody stands down on it', () => {
    assert.equal(ownedByAnotherProcess({ owner_pid: 300 }, 100, opts), false)
    assert.equal(ownedByAnotherProcess({}, 100, opts), false)
    assert.equal(ownedByProcess({ owner_pid: 300 }, 300, opts), false)
  })

  it('a process that cannot place itself never stands down on a guess', () => {
    assert.equal(ownedByAnotherProcess({ owner_pid: 200 }, 999, { isAlive: alive, claudeOf: (pid) => (pid === 999 ? null : claudeOf(pid)) }), false)
  })

  it('walks a pid up to its Claude Code process', () => {
    const names = { 10: 'node', 9: 'zsh', 8: 'claude', 7: 'konsole' }
    const parents = { 10: 9, 9: 8, 8: 7, 7: 1 }
    const world = { isAlive: () => true, nameOf: (pid) => names[pid] ?? null, parentOfPid: (pid) => parents[pid] ?? null }
    assert.equal(claudeProcessOf(10, world), 8)
    assert.equal(claudeProcessOf(8, world), 8)
    assert.equal(claudeProcessOf(7, world), null, 'nothing above it is Claude Code')
    assert.equal(claudeProcessOf(10, { ...world, isAlive: () => false }), null)
  })
})

describe('what a serving listener does on each tick', () => {
  const ownedBy = (owner) => (state, pid) => Number(state.owner_pid) === owner && pid === owner
  const classify = (state, pid = 100) =>
    classifyConnection(state, pid, { owns: ownedBy(100), ownedElsewhere: (s, p) => Number(s.owner_pid) !== p && Number(s.owner_pid) === 200 })

  it('classifies by ownership and ends, never by age or quiet', () => {
    assert.equal(classify({ enabled: true, owner_pid: 100, updated_at: '2020-01-01T00:00:00Z' }), 'mine')
    assert.equal(classify({ enabled: true, owner_pid: 200 }), 'superseded')
    assert.equal(classify({ enabled: false, owner_pid: 100 }), 'ended')
    assert.equal(classify({ enabled: true, owner_pid: 100, ended_from_ui: true }), 'ended')
    assert.equal(classify({ enabled: true, owner_pid: 100, end_reason: 'ui' }), 'ended')
    assert.equal(classify(null), 'not_mine')
  })

  it('arms one reader only when nothing holds the wake', () => {
    const base = { standing: 'mine', pollerUp: true }
    assert.equal(reconcileStep({ ...base, streaming: false, waitHeld: false }).arm, true)
    assert.equal(reconcileStep({ ...base, streaming: true, waitHeld: true }).arm, false)
    assert.equal(reconcileStep({ ...base, streaming: false, waitHeld: true }).arm, false, 'a Monitor of this session already reads it')
    assert.equal(reconcileStep({ ...base, streaming: false, waitHeld: false, now: 5, streamNotBefore: 10 }).arm, false, 'backing off a failing stream')
  })

  it('repairs a missing poller only after it stays missing, and only when backoff allows', () => {
    let step = { misses: 0 }
    for (let i = 1; i < POLLER_MISSES_BEFORE_REPAIR; i++) {
      step = reconcileStep({ standing: 'mine', streaming: true, waitHeld: true, pollerUp: false, misses: step.misses })
      assert.equal(step.repair, false, 'a restart in progress is not a death')
    }
    step = reconcileStep({ standing: 'mine', streaming: true, waitHeld: true, pollerUp: false, misses: step.misses })
    assert.equal(step.repair, true)
    assert.equal(reconcileStep({ standing: 'mine', streaming: true, waitHeld: true, pollerUp: false, misses: 5, now: 1, repairNotBefore: 2 }).repair, false)
    assert.equal(reconcileStep({ standing: 'mine', streaming: true, waitHeld: true, pollerUp: true, misses: 5 }).misses, 0)
  })

  it('does nothing at all for a connection it does not own', () => {
    for (const standing of ['superseded', 'ended', 'not_mine']) {
      const step = reconcileStep({ standing, streaming: false, waitHeld: false, pollerUp: false, misses: 9 })
      assert.deepEqual(step, { arm: false, repair: false, misses: 0 }, standing)
    }
  })
})

describe('/devspec.remote defers to the listener this session already runs', () => {
  const noSleep = async () => {}

  it('says the listener holds the wake once it serves this connection', async () => {
    const reads = [{ status: 'watching' }, { status: 'serving', connection_id: CONN }]
    const held = await listenerHoldsWake(100, CONN, { read: () => reads.shift() ?? reads.at(-1), sleepFn: noSleep })
    assert.equal(held, true)
  })

  it('arms by itself when there is no listener, or one that will not serve', async () => {
    assert.equal(await listenerHoldsWake(100, CONN, { read: () => null, sleepFn: noSleep }), false)
    assert.equal(await listenerHoldsWake(100, CONN, { read: () => ({ status: 'dormant' }), sleepFn: noSleep }), false)
  })

  it('gives up waiting, rather than leave the connection deaf', async () => {
    const held = await listenerHoldsWake(100, CONN, { read: () => ({ status: 'connecting' }), waitMs: 0, sleepFn: noSleep })
    assert.equal(held, false)
  })

  it("a reader left in a window this was resumed away from is not this window's", () => {
    const claudeOf = (pid) => ({ 100: 100, 150: 100, 200: 200 })[pid] ?? null
    const world = (holderOwner) => ({ holderOf: () => 4242, ownerOfHolder: () => holderOwner, claudeOf })
    assert.equal(wakeHeldByThisProcess(CONN, 100, world(150)), true)
    assert.equal(wakeHeldByThisProcess(CONN, 100, world(200)), false)
    assert.equal(wakeHeldByThisProcess(CONN, 100, { ...world(200), holderOf: () => null }), false)
    assert.equal(wakeHeldByThisProcess(CONN, 100, world(null)), true, 'unknown owner: trust the reader')
  })
})

describe('the turn hooks of a window that handed the connection over stand back', () => {
  it('drops live connections another process owns, and keeps everything else', () => {
    const candidates = [
      { raw: { connection_id: 'mine', enabled: true, owner_pid: 100 } },
      { raw: { connection_id: 'moved', enabled: true, owner_pid: 200 } },
      { raw: { connection_id: 'old', enabled: false, owner_pid: 200 } },
    ]
    const kept = withoutConnectionsOwnedElsewhere(candidates, { myPid: 100, ownedElsewhere: (raw) => Number(raw.owner_pid) === 200 })
    assert.deepEqual(kept.map((c) => c.raw.connection_id), ['mine', 'old'])
    assert.equal(withoutConnectionsOwnedElsewhere(candidates, { myPid: null }).length, 3)
  })
})

describe('what a listener files under its owner', () => {
  it('round-trips a status and an owned-connection pointer, and cleans both up', () => {
    const dir = tmpDir('devspec-owner-files-')
    writeOwnerListenerStatus(process.pid, 'serving', { connectionId: CONN, dir })
    assert.equal(readOwnerListenerStatus(process.pid, dir)?.status, 'serving')
    writeOwnedConnectionPointer(process.pid, CONN, { dir })
    assert.equal(readOwnedConnectionPointer(process.pid, { dir }), CONN)
    removeOwnerListenerFiles(process.pid, { dir })
    assert.equal(readOwnerListenerStatus(process.pid, dir), null)
    assert.equal(readOwnedConnectionPointer(process.pid, { dir }), null)
  })

  it('never hands a pointer to a different process that reused the pid', () => {
    if (!LINUX) return
    const dir = tmpDir('devspec-owner-reuse-')
    writeOwnedConnectionPointer(process.pid, CONN, { dir })
    const file = path.join(dir, `${process.pid}.connection.json`)
    const pointer = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...pointer, owner_started: '1' }), { mode: 0o600 })
    assert.equal(readOwnedConnectionPointer(process.pid, { dir }), null)
  })
})

describe('a resumed conversation hands its wake over cleanly (real processes)', { skip: !LINUX }, () => {
  function seedState(home, state) {
    const dir = path.join(home, '.devspec', 'remote-control', 'connections')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${CONN}.json`), JSON.stringify({ connection_id: CONN, agent_name: 'Claude Code', enabled: true, ...state }), { mode: 0o600 })
    fs.writeFileSync(path.join(dir, `${CONN}.inbox.jsonl`), '', { mode: 0o600 })
    return dir
  }

  function runWait(home, ownerPid, { untilMs = 8_000 } = {}) {
    const child = spawn(process.execPath, [path.join(HERE, 'devspec-remote-wait.mjs'), '--connection-id', CONN, '--owner-pid', String(ownerPid), '--stream', '--pending'], {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
    })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    const done = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ code: 'still running', stdout, stderr }), untilMs)
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    })
    return { child, done }
  }

  it('a window whose conversation now lives elsewhere declines to arm, silently', async () => {
    const home = tmpDir('devspec-wait-superseded-')
    const oldWindow = await fakeClaude(home, 'a/claude')
    const newWindow = await fakeClaude(home, 'b/claude')
    seedState(home, { owner_pid: newWindow.pid })
    const { code, stdout } = await runWait(home, oldWindow.pid).done
    assert.equal(code, EXIT_SUPERSEDED)
    assert.equal(stdout, '', 'stdout is the old window model\'s ear — it must hear nothing')
  })

  it('a running stream stands down within seconds of the conversation being resumed elsewhere', async () => {
    const home = tmpDir('devspec-wait-handover-')
    const oldWindow = await fakeClaude(home, 'a/claude')
    const newWindow = await fakeClaude(home, 'b/claude')
    const dir = seedState(home, { owner_pid: oldWindow.pid })
    const run = runWait(home, oldWindow.pid)
    await new Promise((resolve) => setTimeout(resolve, 700))
    const state = JSON.parse(fs.readFileSync(path.join(dir, `${CONN}.json`), 'utf8'))
    fs.writeFileSync(path.join(dir, `${CONN}.json`), JSON.stringify({ ...state, owner_pid: newWindow.pid }), { mode: 0o600 })
    const { code, stdout } = await run.done
    assert.equal(code, EXIT_SUPERSEDED)
    assert.equal(stdout, '')
    assert.equal(fs.existsSync(path.join(dir, `${CONN}.wait.pid`)), false, 'it released the wake for the new window')
  })

  it('a second reader never arms beside the first', async () => {
    const home = tmpDir('devspec-wait-second-')
    const owner = await fakeClaude(home, 'a/claude')
    seedState(home, { owner_pid: owner.pid })
    const first = runWait(home, owner.pid, { untilMs: 3_000 })
    await new Promise((resolve) => setTimeout(resolve, 700))
    const { code } = await runWait(home, owner.pid).done
    assert.equal(code, EXIT_SUPERSEDED)
    first.child.kill('SIGTERM')
    await first.done
  })

  it('closing the window it moved away from does not end the connection', async () => {
    const home = tmpDir('devspec-close-old-window-')
    const newWindow = await fakeClaude(home, 'b/claude')
    const LOCAL = '33333333-3333-4333-8333-333333333333'
    const dir = seedState(home, { owner_pid: newWindow.pid, local_id: LOCAL, token: 'dvs_x', mcp_url: 'http://127.0.0.1:9/api/mcp' })
    const bonds = path.join(home, '.devspec', 'remote-control', 'local', 'claude-code')
    fs.mkdirSync(bonds, { recursive: true })
    fs.writeFileSync(path.join(bonds, `${LOCAL}.json`), JSON.stringify({ connection_id: CONN, agent_name: 'Claude Code', local_id: LOCAL, status: 'live' }), { mode: 0o600 })
    // The old window: SessionEnd runs as a child of ITS Claude Code process, exactly as
    // Claude Code runs a hook (a shell under the claude binary).
    const oldClaude = claudeBinary(path.join(home, 'a'))
    const payload = path.join(home, 'session-end.json')
    fs.writeFileSync(payload, JSON.stringify({ session_id: LOCAL, reason: 'prompt_input_exit' }))
    const hook = `"${process.execPath}" "${path.join(HERE, 'remote-control-state.mjs')}" disable-local --agent "Claude Code" < "${payload}"; true`
    await new Promise((resolve) => {
      const child = spawn(oldClaude, ['-c', hook], { env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home }, stdio: 'ignore' })
      child.on('close', resolve)
    })
    const state = JSON.parse(fs.readFileSync(path.join(dir, `${CONN}.json`), 'utf8'))
    assert.equal(state.enabled, true, 'the new window keeps its connection')
    assert.match(fs.readFileSync(path.join(dir, `${CONN}.poll.log`), 'utf8'), /connection_kept_for_owner/)
  })
})
