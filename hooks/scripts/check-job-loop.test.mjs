#!/usr/bin/env node
/**
 * The real poller against a stub server, with check jobs on the dispatch channel
 * (item f7b8c8d3; DevSpec item 55d71b0c). DevSpec offers a check job only to a
 * connection whose polls say they read them and carries the whole open set on every
 * poll, so what matters here is what the running poller actually sends and keeps, and
 * what the running wake stream then hands Claude Code (item 108de10f).
 * Run: node --test hooks/scripts/check-job-loop.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildCheckJobEvents, CHECK_JOB_HELPERS_RULE, parseInboxBatches } from './devspec-remote-wait.mjs'

const POLL_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'devspec-remote-poll.mjs')
const WAIT_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'devspec-remote-wait.mjs')

const CONNECTION = '10000000-0000-4000-8000-000000000001'
const LOCAL_ID = '80000000-0000-4000-8000-000000000008'

const job = {
  id: '60000000-0000-4000-8000-000000000006',
  kind: 'check_job',
  check_job_id: '60000000-0000-4000-8000-000000000006',
  check_kind: 'duplicate',
  record: { type: 'memory', id: '70000000-0000-4000-8000-000000000007', title: 'Retry policy' },
  entries: 2,
  yours: false,
  offered_at: '2026-11-04T12:00:00.000Z',
  delivery_connection_id: CONNECTION,
}

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const until = async (condition, ms = 15_000) => {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  return condition()
}

/** Every poll is answered with `dispatches` (the whole open set) until `quiet` is set. */
async function stubServer(dispatches) {
  const requests = []
  const world = { quiet: false }
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', async () => {
      const parsed = JSON.parse(body)
      const call = parsed.params ?? {}
      requests.push({ name: call.name, args: call.arguments ?? {} })
      let result = text({})
      if (call.name === 'poll_connection') {
        if (world.quiet) {
          await new Promise((resolve) => setTimeout(resolve, 150))
          result = text({ connection_id: CONNECTION, session_id: null, changed: false })
        } else {
          await new Promise((resolve) => setTimeout(resolve, 50))
          result = text({ connection_id: CONNECTION, session_id: null, changed: true, dispatches, dispatch_cursor: 'dispatch-cursor-1' })
        }
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    world,
    polls: () => requests.filter((entry) => entry.name === 'poll_connection'),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function startPoller(stub, { turnRunning = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-check-job-'))
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${CONNECTION}.json`), JSON.stringify({
    enabled: true, connection_id: CONNECTION, session_id: null, agent_name: 'Claude Code',
    local_id: LOCAL_ID, token: 'dvs_test_token', mcp_url: stub.url,
  }), { mode: 0o600 })
  // Claude Code is working on a turn: the marker its prompt hook writes.
  if (turnRunning) fs.writeFileSync(path.join(dir, `${CONNECTION}.turn`), JSON.stringify({ startedAt: Date.now() }), { mode: 0o600 })
  const child = spawn(process.execPath, [POLL_SCRIPT, '--connection-id', CONNECTION], { env: { ...process.env, HOME: home } })
  let stderr = ''
  child.stdout.resume()
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const read = (name) => {
    try { return fs.readFileSync(path.join(dir, name), 'utf8') } catch { return '' }
  }
  return {
    home,
    state: () => JSON.parse(read(`${CONNECTION}.json`) || '{}'),
    inboxLines: () => read(`${CONNECTION}.inbox.jsonl`).split('\n').filter(Boolean),
    turnMarked: () => fs.existsSync(path.join(dir, `${CONNECTION}.turn`)),
    stderr: () => stderr,
    stop: () => { child.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }) },
  }
}

/** The wake stream Claude Code's Monitor runs, on the poller's own inbox. */
function startWaitStream(poller) {
  const child = spawn(
    process.execPath,
    [WAIT_SCRIPT, '--connection-id', CONNECTION, '--stream', '--pending', '--poll-ms', '20', '--owner-pid', String(process.pid)],
    { env: { ...process.env, HOME: poller.home, USERPROFILE: poller.home }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const closed = new Promise((resolve) => child.once('close', resolve))
  return {
    checkJobs: () => stdout.split('\n').slice(0, -1).map((line) => JSON.parse(line)).filter((event) => event.type === 'check_job'),
    /** How many deliveries each pass over the inbox made, as the stream counted them. */
    passes: () => [...stderr.matchAll(/streamed wake \((\d+) msg\)/g)].map((match) => Number(match[1])),
    stderr: () => stderr,
    stop: async () => { child.kill('SIGKILL'); await closed },
  }
}

describe('check jobs through the running poller (item f7b8c8d3)', () => {
  it('asks for check jobs on every poll, keeps the job once, and opens no turn for it', async () => {
    const stub = await stubServer([job])
    const poller = startPoller(stub)
    try {
      assert.ok(await until(() => poller.inboxLines().length > 0), poller.stderr())
      // The server keeps carrying the open job; it is still kept once.
      assert.ok(await until(() => stub.polls().length >= 4), poller.stderr())
      stub.world.quiet = true
      const polls = stub.polls()
      for (const poll of polls) assert.equal(poll.args.check_job_version, 2)
      assert.ok(polls.slice(1).every((poll) => poll.args.dispatch_cursor === 'dispatch-cursor-1'))

      const lines = poller.inboxLines()
      assert.equal(lines.length, 1)
      const [batch] = parseInboxBatches(lines, CONNECTION)
      assert.equal(batch.type, 'check_job')
      assert.deepEqual(batch.dispatch, job)
      const { content } = buildCheckJobEvents(batch)[0]
      assert.ok(content.startsWith('A check is waiting. '))
      assert.ok(content.endsWith(' It is on "Retry policy".'))

      // Busy is the agent's turn, which the wake starts through Claude Code's own
      // prompt hook: delivery alone never says Working.
      assert.equal(poller.turnMarked(), false)
      assert.ok(polls.every((poll) => poll.args.busy !== true))
    } finally {
      poller.stop()
      await stub.close()
    }
  })

  // Item 108de10f, decision b8abe2bb: sent while Claude Code is working, every check
  // job waiting reaches the wake stream at once. Claude Code hands what the stream
  // prints to a working agent at its next step, so none waits for the turn to end and
  // all arrive together. Before, the stream held them and released one per turn.
  it('check jobs sent while a turn is running all reach the wake stream at once, and the turn runs on', async () => {
    const second = {
      ...job,
      id: '61000000-0000-4000-8000-000000000006',
      check_job_id: '61000000-0000-4000-8000-000000000006',
      check_kind: 'conflict',
      record: { type: 'task', id: '71000000-0000-4000-8000-000000000007', title: 'Sign in with a passkey' },
    }
    const stub = await stubServer([job, second])
    const poller = startPoller(stub, { turnRunning: true })
    const stream = startWaitStream(poller)
    try {
      assert.ok(await until(() => stream.checkJobs().length === 2), `${poller.stderr()}\n${stream.stderr()}`)
      stub.world.quiet = true
      const delivered = stream.checkJobs()
      assert.deepEqual(delivered.map((event) => event.check_job_id), [job.check_job_id, second.check_job_id])
      // Both were handed over as they landed in the inbox, with the turn still running:
      // neither waited for a turn of its own. (That records already waiting go in ONE
      // pass is pinned in devspec-remote-wait.test.mjs, where the inbox is written first.)
      assert.equal(stream.passes().reduce((sum, count) => sum + count, 0), 2)
      for (const event of delivered) {
        // What a helper needs to take the job, and where the ruling instruction is,
        // before anything has been claimed.
        assert.equal(event.connection_id, CONNECTION)
        assert.ok(event.content.includes(CHECK_JOB_HELPERS_RULE))
      }
      // The turn that was running is still running: delivery ended and opened nothing.
      assert.equal(poller.turnMarked(), true)
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(stream.checkJobs().length, 2, 'each is delivered once')
    } finally {
      await stream.stop()
      poller.stop()
      await stub.close()
    }
  })

  it('rejects a batch with one malformed check job whole, and does not move its cursor', async () => {
    const stub = await stubServer([{ ...job, title: 'a record body has no place here' }])
    const poller = startPoller(stub)
    try {
      assert.ok(await until(() => /rejected dispatch/.test(poller.stderr())), poller.stderr())
      assert.ok(await until(() => stub.polls().length >= 2))
      stub.world.quiet = true
      assert.deepEqual(poller.inboxLines(), [])
      assert.equal(poller.state().dispatch_cursor ?? null, null)
      assert.ok(stub.polls().every((poll) => poll.args.dispatch_cursor === undefined))
    } finally {
      poller.stop()
      await stub.close()
    }
  })

  // Item 1d89fe56: version 2 carries open-task out-of-date checks raised by a settled
  // discussion point or a Goal change, and the manual whole-backlog scan.
  it('keeps the version-2 jobs that name a discussion point, a Goal and the backlog scan', async () => {
    const jobs = ['discussion_point', 'goal', 'backlog_scan'].map((type, i) => ({
      ...job,
      id: `6000000${i}-0000-4000-8000-00000000000${i}`,
      check_job_id: `6000000${i}-0000-4000-8000-00000000000${i}`,
      check_kind: 'staleness',
      record: { type, id: `7000000${i}-0000-4000-8000-00000000000${i}`, title: `About ${type}` },
    }))
    const stub = await stubServer(jobs)
    const poller = startPoller(stub)
    try {
      assert.ok(await until(() => poller.inboxLines().length === 3), poller.stderr())
      stub.world.quiet = true
      const batches = parseInboxBatches(poller.inboxLines(), CONNECTION)
      assert.deepEqual(batches.map((batch) => batch.dispatch.record.type), ['discussion_point', 'goal', 'backlog_scan'])
      assert.doesNotMatch(poller.stderr(), /rejected dispatch/)
    } finally {
      poller.stop()
      await stub.close()
    }
  })

  it('rejects a batch carrying a version-1 envelope whole, since it negotiated 2', async () => {
    const stub = await stubServer([{ ...job, high_risk: 0 }])
    const poller = startPoller(stub)
    try {
      assert.ok(await until(() => /rejected dispatch/.test(poller.stderr())), poller.stderr())
      stub.world.quiet = true
      assert.deepEqual(poller.inboxLines(), [])
    } finally {
      poller.stop()
      await stub.close()
    }
  })
})
