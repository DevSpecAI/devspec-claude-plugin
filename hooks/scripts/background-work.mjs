/**
 * Background work the model started during the current command, read from Claude
 * Code's own session transcript (item f4a79327).
 *
 * Why this exists: when Claude starts a job with `run_in_background` and then ends
 * its turn to wait, the Stop hook used to report the DevSpec command as finished.
 * The server closed the command turn, so everything Claude did after the job woke it
 * reached DevSpec with no live command behind it: no requester was recorded, and the
 * write was judged by the agent owner's role instead of the person who asked
 * (observed on staging 2026-10-04 — a Reviewed Contributor's request became agreed
 * work). Pi keeps the turn open until its background work is done (item 15cb0983);
 * this is the Claude Code equivalent.
 *
 * The transcript records both ends of every background job, so this is an exact
 * reading, not a heuristic:
 *   - launch: an assistant `tool_use` whose input has `run_in_background: true`,
 *     followed by its `tool_result` ("… running in background with ID: <task id>").
 *     An error result means nothing was started.
 *   - end: a `<task-notification>` naming the job's `<tool-use-id>` / `<task-id>` with
 *     a terminal `<status>`, or the model stopping it with a kill/stop tool.
 * Monitors are not counted: a Monitor is a standing watch, not a job with an end, and
 * the DevSpec wake stream itself is one.
 *
 * Imports only Node built-ins (DEVELOPMENT.md).
 */

import fs from 'node:fs'

/** A status the host reports while a job is still going; anything else ends it. */
const NON_TERMINAL_STATUSES = new Set(['running', 'started', 'pending', 'in_progress'])

const LAUNCH_ID_PATTERN = /running in background with ID:\s*([A-Za-z0-9_-]+)/
const NOTIFICATION_PATTERN = /<task-notification>([\s\S]*?)<\/task-notification>/g

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`))
  return match ? match[1] : null
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('\n')
  }
  return ''
}

/**
 * Reduce transcript lines to the background jobs launched at or after `sinceMs`
 * that have not ended. Pure: takes the raw JSONL text so tests run it directly.
 *
 * @param {string} jsonl     the transcript file's contents
 * @param {number} sinceMs   epoch ms; jobs launched before it belong to earlier work
 * @returns {Array<{ toolUseId: string, taskId: string|null, tool: string, description: string|null }>}
 */
export function outstandingBackgroundWork(jsonl, sinceMs) {
  /** @type {Map<string, { toolUseId: string, taskId: string|null, tool: string, description: string|null }>} */
  const launched = new Map()
  const endedToolUseIds = new Set()
  const endedTaskIds = new Set()

  for (const line of String(jsonl || '').split('\n')) {
    // Cheap pre-filter: transcripts run to tens of megabytes, and only these lines matter.
    if (
      !line.includes('run_in_background') &&
      !line.includes('running in background') &&
      !line.includes('task-notification') &&
      !line.includes('"tool_use"') &&
      !/"is_error":\s*true/.test(line)
    ) {
      continue
    }
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    // A job's end is recorded whenever it arrives, and before `sinceMs` filtering:
    // ending is never "earlier work".
    if (line.includes('task-notification')) {
      const raw = typeof entry.content === 'string' ? entry.content : textOf(entry.message?.content)
      for (const match of raw.matchAll(NOTIFICATION_PATTERN)) {
        const status = (tag(match[1], 'status') || '').toLowerCase()
        if (!status || NON_TERMINAL_STATUSES.has(status)) continue
        const toolUseId = tag(match[1], 'tool-use-id')
        const taskId = tag(match[1], 'task-id')
        if (toolUseId) endedToolUseIds.add(toolUseId)
        if (taskId) endedTaskIds.add(taskId)
      }
    }

    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    const at = Date.parse(entry.timestamp || '')
    const inWindow = Number.isFinite(at) && at >= sinceMs

    for (const block of content) {
      if (block?.type === 'tool_use') {
        const input = block.input && typeof block.input === 'object' ? block.input : {}
        if (inWindow && input.run_in_background === true && typeof block.id === 'string') {
          launched.set(block.id, {
            toolUseId: block.id,
            taskId: null,
            tool: String(block.name || ''),
            description: typeof input.description === 'string' ? input.description : null,
          })
        }
        // The model stopping a job itself (KillShell / TaskStop and their kin).
        const stoppedId = input.shell_id || input.task_id || input.bash_id
        if (typeof stoppedId === 'string' && /kill|stop/i.test(String(block.name || ''))) {
          endedTaskIds.add(stoppedId)
        }
      } else if (block?.type === 'tool_result' && launched.has(block.tool_use_id)) {
        const job = launched.get(block.tool_use_id)
        if (block.is_error === true) {
          launched.delete(block.tool_use_id)
          continue
        }
        const id = textOf(block.content).match(LAUNCH_ID_PATTERN)
        if (id) job.taskId = id[1]
      }
    }
  }

  return [...launched.values()].filter(
    (job) => !endedToolUseIds.has(job.toolUseId) && !(job.taskId && endedTaskIds.has(job.taskId)),
  )
}

/**
 * The same reading from a transcript path. Fails open to "nothing outstanding" when
 * the file cannot be read, so an unreadable transcript never holds a turn open.
 */
export function outstandingBackgroundWorkFromFile(transcriptPath, sinceMs) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return []
  try {
    return outstandingBackgroundWork(fs.readFileSync(transcriptPath, 'utf8'), sinceMs)
  } catch {
    return []
  }
}
