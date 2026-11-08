#!/usr/bin/env node
/**
 * The real poller against a stub server, with check jobs on the dispatch channel
 * (item f7b8c8d3; DevSpec item 55d71b0c). DevSpec offers a check job only to a
 * connection whose polls say they read them, carries the whole open set on every
 * poll, and drops an untaken job when a turn ends, so what matters here is what the
 * running poller actually sends and keeps.
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
import { buildCheckJobEvents, parseInboxBatches } from './devspec-remote-wait.mjs'

const POLL_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'devspec-remote-poll.mjs')

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

function startPoller(stub) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-check-job-'))
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${CONNECTION}.json`), JSON.stringify({
    enabled: true, connection_id: CONNECTION, session_id: null, agent_name: 'Claude Code',
    local_id: LOCAL_ID, token: 'dvs_test_token', mcp_url: stub.url,
  }), { mode: 0o600 })
  const child = spawn(process.execPath, [POLL_SCRIPT, '--connection-id', CONNECTION], { env: { ...process.env, HOME: home } })
  let stderr = ''
  child.stdout.resume()
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const read = (name) => {
    try { return fs.readFileSync(path.join(dir, name), 'utf8') } catch { return '' }
  }
  return {
    state: () => JSON.parse(read(`${CONNECTION}.json`) || '{}'),
    inboxLines: () => read(`${CONNECTION}.inbox.jsonl`).split('\n').filter(Boolean),
    turnMarked: () => fs.existsSync(path.join(dir, `${CONNECTION}.turn`)),
    stderr: () => stderr,
    stop: () => { child.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }) },
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
      assert.equal(buildCheckJobEvents(batch)[0].content,
        'A check is waiting on "Retry policy": take it with claim_check_job, rule every entry with record_check_rulings, then carry on.')

      // Busy is the agent's turn, which the wake starts through Claude Code's own
      // prompt hook: delivery alone never says Working.
      assert.equal(poller.turnMarked(), false)
      assert.ok(polls.every((poll) => poll.args.busy !== true))
    } finally {
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
