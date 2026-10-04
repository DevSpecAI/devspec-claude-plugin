#!/usr/bin/env node
/**
 * Background work read from Claude Code's transcript (item f4a79327).
 * Run: node --test hooks/scripts/background-work.test.mjs
 *
 * Line shapes are taken from a real installed Claude Code session on 2026-10-04:
 * a `run_in_background` Bash call, its "running in background with ID" result, the
 * queued `<task-notification>` and the same notification delivered as a user turn.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { outstandingBackgroundWork, outstandingBackgroundWorkFromFile } from './background-work.mjs'

const T0 = Date.parse('2026-10-04T17:30:40.000Z')
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString()

function launch(id, seconds, input = { command: 'sleep 40', description: 'Sleep 40 seconds', run_in_background: true }) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: at(seconds),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input }] },
  })
}
function launched(toolUseId, taskId, seconds, isError = false) {
  const content = isError
    ? 'Error: could not start the command'
    : `Command running in background with ID: ${taskId}. Output is being written to: /tmp/tasks/${taskId}.output. You will be notified when it completes.`
  return JSON.stringify({
    type: 'user',
    timestamp: at(seconds),
    message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: isError }] },
  })
}
function notificationText(toolUseId, taskId, status) {
  return `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/tmp/tasks/${taskId}.output</output-file>\n<status>${status}</status>\n<summary>Background command "Sleep 40 seconds" ${status} (exit code 0)</summary>\n</task-notification>`
}
function queued(toolUseId, taskId, seconds, status = 'completed') {
  return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at(seconds), content: notificationText(toolUseId, taskId, status) })
}
function delivered(toolUseId, taskId, seconds, status = 'completed') {
  return JSON.stringify({ type: 'user', timestamp: at(seconds), message: { role: 'user', content: notificationText(toolUseId, taskId, status) } })
}

describe('outstandingBackgroundWork', () => {
  it('reports a background job that has started and not finished', () => {
    const jsonl = [launch('toolu_A', 8), launched('toolu_A', 'bxhtqls7l', 8)].join('\n')
    const jobs = outstandingBackgroundWork(jsonl, T0)
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].toolUseId, 'toolu_A')
    assert.equal(jobs[0].taskId, 'bxhtqls7l')
    assert.equal(jobs[0].description, 'Sleep 40 seconds')
  })

  it('a completion notification ends it, whether queued or delivered', () => {
    const base = [launch('toolu_A', 8), launched('toolu_A', 'bxhtqls7l', 8)]
    assert.deepEqual(outstandingBackgroundWork([...base, queued('toolu_A', 'bxhtqls7l', 48)].join('\n'), T0), [])
    assert.deepEqual(outstandingBackgroundWork([...base, delivered('toolu_A', 'bxhtqls7l', 48)].join('\n'), T0), [])
  })

  it('failed and killed jobs are over too; only a running status keeps one open', () => {
    const base = [launch('toolu_A', 8), launched('toolu_A', 'bxhtqls7l', 8)]
    for (const status of ['failed', 'killed']) {
      assert.deepEqual(outstandingBackgroundWork([...base, delivered('toolu_A', 'bxhtqls7l', 20, status)].join('\n'), T0), [])
    }
    assert.equal(outstandingBackgroundWork([...base, delivered('toolu_A', 'bxhtqls7l', 20, 'running')].join('\n'), T0).length, 1)
  })

  it('matches a notification by task id when it carries no tool-use id', () => {
    const note = JSON.stringify({ type: 'user', timestamp: at(30), message: { role: 'user', content: '<task-notification><task-id>bxhtqls7l</task-id><status>completed</status></task-notification>' } })
    const jsonl = [launch('toolu_A', 8), launched('toolu_A', 'bxhtqls7l', 8), note].join('\n')
    assert.deepEqual(outstandingBackgroundWork(jsonl, T0), [])
  })

  it('a launch that errored started nothing', () => {
    const jsonl = [launch('toolu_A', 8), launched('toolu_A', null, 8, true)].join('\n')
    assert.deepEqual(outstandingBackgroundWork(jsonl, T0), [])
  })

  it('the model stopping the job itself ends it', () => {
    const stop = JSON.stringify({
      type: 'assistant',
      timestamp: at(12),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_K', name: 'KillShell', input: { shell_id: 'bxhtqls7l' } }] },
    })
    const jsonl = [launch('toolu_A', 8), launched('toolu_A', 'bxhtqls7l', 8), stop].join('\n')
    assert.deepEqual(outstandingBackgroundWork(jsonl, T0), [])
  })

  it('keeps overlapping jobs apart: one finishing does not end the other', () => {
    const jsonl = [
      launch('toolu_A', 8),
      launched('toolu_A', 'task_a', 8),
      launch('toolu_B', 9),
      launched('toolu_B', 'task_b', 9),
      delivered('toolu_A', 'task_a', 30),
    ].join('\n')
    const jobs = outstandingBackgroundWork(jsonl, T0)
    assert.deepEqual(jobs.map((job) => job.toolUseId), ['toolu_B'])
  })

  it('ignores jobs launched before the current command began', () => {
    const jsonl = [launch('toolu_OLD', -600), launched('toolu_OLD', 'old', -600)].join('\n')
    assert.deepEqual(outstandingBackgroundWork(jsonl, T0), [])
  })

  it('does not count foreground commands or tools without run_in_background', () => {
    const jsonl = [
      launch('toolu_F', 8, { command: 'npm test', description: 'Run tests' }),
      launch('toolu_M', 9, { command: 'until done; do sleep 2; done', description: 'watch' }).replace('"Bash"', '"Monitor"'),
    ].join('\n')
    assert.deepEqual(outstandingBackgroundWork(jsonl, T0), [])
  })

  it('tolerates junk lines and an empty transcript', () => {
    assert.deepEqual(outstandingBackgroundWork('', T0), [])
    assert.equal(outstandingBackgroundWork(['not json "tool_use"', launch('toolu_A', 8)].join('\n'), T0).length, 1)
  })
})

describe('outstandingBackgroundWorkFromFile', () => {
  it('reads the transcript file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-work-'))
    const file = path.join(dir, 'session.jsonl')
    fs.writeFileSync(file, [launch('toolu_A', 8), launched('toolu_A', 'task_a', 8)].join('\n') + '\n')
    assert.equal(outstandingBackgroundWorkFromFile(file, T0).length, 1)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('an unreadable or missing transcript holds nothing open', () => {
    assert.deepEqual(outstandingBackgroundWorkFromFile('/nonexistent/session.jsonl', T0), [])
    assert.deepEqual(outstandingBackgroundWorkFromFile(null, T0), [])
  })
})
