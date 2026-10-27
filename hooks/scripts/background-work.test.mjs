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
import {
  launchedBackgroundWork,
  outstandingBackgroundWork,
  outstandingBackgroundWorkFromFile,
  ownedOutstandingWork,
  parseBackgroundTasks,
} from './background-work.mjs'

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

/**
 * Item beb0e005. PostToolUse `tool_response` shapes and the Stop hook's
 * `background_tasks`, as Claude Code 2.1.289 sent them to a probe on 2026-10-05.
 */
describe('launchedBackgroundWork — the id a tool call left running, from its own result', () => {
  it('reads a background command, an async subagent and a workflow', () => {
    assert.deepEqual(
      launchedBackgroundWork('Bash', { backgroundTaskId: 'bvem1pf78', interrupted: false, isImage: false, noOutputExpected: false, stderr: '', stdout: '' }),
      { id: 'bvem1pf78', kind: 'shell' },
    )
    assert.deepEqual(
      launchedBackgroundWork('Agent', {
        agentId: 'a9f2b562e4a5fba8e',
        status: 'async_launched',
        isAsync: true,
        description: 'sleep probe',
        resolvedModel: 'claude-sonnet-5-5',
        prompt: 'Run `sleep 15` with Bash, then reply done.',
      }),
      // The label and model are carried for Activity (item d2cbd4c6); the prompt never is.
      { id: 'a9f2b562e4a5fba8e', kind: 'subagent', label: 'sleep probe', model: 'claude-sonnet-5-5' },
    )
    assert.deepEqual(launchedBackgroundWork('Workflow', { taskId: 'wf_8k2j3' }), { id: 'wf_8k2j3', kind: 'workflow' })
  })

  it('ignores calls that finished inside the call', () => {
    assert.equal(launchedBackgroundWork('Bash', { stdout: 'ok', stderr: '', interrupted: false }), null)
    assert.equal(launchedBackgroundWork('Agent', { agentId: 'a1', status: 'completed' }), null)
    assert.equal(launchedBackgroundWork('Read', { backgroundTaskId: 'x' }), null)
    assert.equal(launchedBackgroundWork('Bash', null), null)
  })
})

describe('parseBackgroundTasks — the host list, or "unknown"', () => {
  it('returns the list when the host sends one, even an empty one', () => {
    assert.deepEqual(parseBackgroundTasks(JSON.stringify({ background_tasks: [] })), [])
  })
  it('returns null when the host sends none, so a caller falls back instead of assuming nothing runs', () => {
    assert.equal(parseBackgroundTasks(JSON.stringify({ stop_hook_active: false })), null)
    assert.equal(parseBackgroundTasks('not json'), null)
  })
})

describe('ownedOutstandingWork — what this command is still waiting on', () => {
  const listener = { id: 'bjc8wt84h', type: 'shell', status: 'running', description: 'DevSpec: messages sent to this agent' }
  const subagent = { id: 'a9f2b562e4a5fba8e', type: 'subagent', status: 'running', description: 'sleep probe' }

  it('lists only owned work, as structured rows', () => {
    assert.deepEqual(ownedOutstandingWork([listener, subagent], ['a9f2b562e4a5fba8e']), [
      { id: 'a9f2b562e4a5fba8e', kind: 'subagent', description: 'sleep probe', status: 'running' },
    ])
  })
  it('never counts a monitor, even one the turn armed', () => {
    assert.deepEqual(ownedOutstandingWork([{ id: 'm1', type: 'monitor', status: 'running' }], ['m1']), [])
  })
  it('drops work the host reports as ended, and keeps a status it has not seen before', () => {
    const tasks = [
      { id: 'b1', type: 'shell', status: 'completed' },
      { id: 'b2', type: 'shell', status: 'queued_remotely' },
    ]
    assert.deepEqual(ownedOutstandingWork(tasks, ['b1', 'b2']).map((job) => job.id), ['b2'])
  })
})
