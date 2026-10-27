#!/usr/bin/env node
/**
 * A reply to a DevSpec notice is posted as one, and never as a command's answer
 * (item 8ad9f857, notice-reply.mjs). Run: node --test hooks/scripts/notice-reply.test.mjs
 *
 * What these guard, each a mistake reading one file would not show:
 * - the ids reach DevSpec as an array even from a conversation whose tool list
 *   predates the argument (Claude Code then hands them over as one string, which
 *   the server refuses: observed 27 Oct);
 * - the tool-input writer never adds a notice to a post, and never stamps the
 *   turn's request on a notice reply;
 * - a notice reply with complete_turn ends neither the turn nor its command here;
 * - every notice the model is handed carries its own exact id in the call to make.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { normalizeNoticeIds, replyLine } from './notice-reply.mjs'
import { prepareDevspecToolInput } from './devspec-tool-input.mjs'
import { appendRequestEvent, readRequestState } from './requests.mjs'
import { formatSystemNoticeContent } from './devspec-remote-wait.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const NOTICE_A = 'aaaaaaaa-1111-4111-8111-111111111111'
const NOTICE_B = 'bbbbbbbb-2222-4222-8222-222222222222'
const CONNECTION = 'cccccccc-3333-4333-8333-333333333333'
const COMMAND = 'dddddddd-4444-4444-8444-444444444444'
const TEAMMATE_COMMAND = 'eeeeeeee-5555-4555-8555-555555555555'
const CONVERSATION = 'claude-conversation-8ad9f857'
const POST = 'mcp__plugin_devspec_devspec__post_session_message'

describe('normalizeNoticeIds', () => {
  it('sends the ids as an array, from an array or from the string a stale tool list hands over', () => {
    assert.deepEqual(normalizeNoticeIds([NOTICE_A, NOTICE_B]), [NOTICE_A, NOTICE_B])
    assert.deepEqual(normalizeNoticeIds(JSON.stringify([NOTICE_A, NOTICE_B])), [NOTICE_A, NOTICE_B])
    assert.deepEqual(normalizeNoticeIds(` ${NOTICE_A} `), [NOTICE_A])
    assert.deepEqual(normalizeNoticeIds(`${NOTICE_A}, ${NOTICE_B}`), [NOTICE_A, NOTICE_B])
  })

  it('sends an exact repeat once, because the server refuses a repeated id', () => {
    assert.deepEqual(normalizeNoticeIds([NOTICE_A, NOTICE_A, NOTICE_B]), [NOTICE_A, NOTICE_B])
  })

  it('leaves anything that is not wholly notice ids for the server to refuse with its reason', () => {
    for (const value of ['', '[]', [], 'not-an-id', [NOTICE_A, 'x'], `["${NOTICE_A}"`, { id: NOTICE_A }, 7]) {
      assert.deepEqual(normalizeNoticeIds(value), value, JSON.stringify(value))
    }
  })
})

describe('the tool-input writer on post_session_message', () => {
  let home, dir
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-notice-reply-'))
    dir = path.join(home, '.devspec', 'remote-control', 'connections')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(dir, `${CONNECTION}.json`), JSON.stringify({
      connection_id: CONNECTION, enabled: true, agent_name: 'Claude Code', local_id: CONVERSATION,
    }), { mode: 0o600 })
    // A room command is open and is what the turn serves.
    appendRequestEvent(CONNECTION, { op: 'open', id: COMMAND, kind: 'command', provenance_ref: COMMAND, requested_by: 'person-a' }, { dir })
    appendRequestEvent(CONNECTION, { op: 'current', ref: COMMAND }, { dir })
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  const prepare = (toolInput) => prepareDevspecToolInput({ session_id: CONVERSATION, tool_name: POST, tool_input: toolInput }, { home, env: {} })

  it('posts a notice reply with the ids as an array and the connection, and names no request', () => {
    const out = prepare({ message: 'DevSpec found a clash', system_notice_ids: JSON.stringify([NOTICE_A]), request_ref: COMMAND })
    assert.equal(out.hookSpecificOutput.permissionDecision, undefined)
    assert.deepEqual(out.hookSpecificOutput.updatedInput, {
      message: 'DevSpec found a clash', system_notice_ids: [NOTICE_A], connection_id: CONNECTION,
    })
  })

  it('is not held when the turn carries two people\'s requests', () => {
    appendRequestEvent(CONNECTION, { op: 'open', id: TEAMMATE_COMMAND, kind: 'command', provenance_ref: TEAMMATE_COMMAND, requested_by: 'person-b' }, { dir })
    appendRequestEvent(CONNECTION, { op: 'joined', id: TEAMMATE_COMMAND }, { dir })
    const out = prepare({ message: 'DevSpec found a clash', system_notice_ids: [NOTICE_A] })
    assert.equal(out.hookSpecificOutput.permissionDecision, undefined)
    assert.deepEqual(out.hookSpecificOutput.updatedInput.system_notice_ids, [NOTICE_A])
  })

  it('never adds a notice to a command\'s answer', () => {
    const out = prepare({ message: 'Here is the answer', complete_turn: true })
    const sent = out.hookSpecificOutput.updatedInput
    assert.equal(Object.hasOwn(sent, 'system_notice_ids'), false)
    assert.equal(sent.request_ref, COMMAND, 'the command\'s answer still names the command it serves')
  })
})

describe('mark-explicit-reply (PostToolUse) after a notice reply', () => {
  let home, dir
  const turnMarker = () => path.join(dir, `${CONNECTION}.turn`)
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-notice-reply-post-'))
    dir = path.join(home, '.devspec', 'remote-control', 'connections')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(dir, `${CONNECTION}.json`), JSON.stringify({
      connection_id: CONNECTION, enabled: true, agent_name: 'Claude Code', local_id: CONVERSATION,
    }), { mode: 0o600 })
    fs.writeFileSync(turnMarker(), JSON.stringify({ startedAt: Date.now() }), { mode: 0o600 })
    appendRequestEvent(CONNECTION, { op: 'open', id: COMMAND, kind: 'command', provenance_ref: COMMAND, requested_by: 'person-a' }, { dir })
    appendRequestEvent(CONNECTION, { op: 'current', ref: COMMAND }, { dir })
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  const posted = (toolInput) => {
    const run = spawnSync(process.execPath, [path.join(HERE, 'mark-explicit-reply.mjs')], {
      input: JSON.stringify({ session_id: CONVERSATION, tool_name: POST, tool_input: toolInput, tool_response: {} }),
      env: { PATH: process.env.PATH, HOME: home },
      encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr)
  }

  it('leaves the command\'s turn open even with complete_turn', () => {
    posted({ message: 'DevSpec found a clash', system_notice_ids: [NOTICE_A], complete_turn: true, connection_id: CONNECTION })
    assert.equal(fs.existsSync(turnMarker()), true, 'the turn is still Working')
    assert.equal(readRequestState(CONNECTION, { dir }).open.get(COMMAND).answered, undefined, 'the command still waits for its answer')
  })

  it('still ends the turn on the command\'s own final answer', () => {
    posted({ message: 'Here is the answer', complete_turn: true, connection_id: CONNECTION })
    assert.equal(fs.existsSync(turnMarker()), false)
    assert.equal(readRequestState(CONNECTION, { dir }).open.get(COMMAND).answered, true)
  })
})

describe('the notice the model is handed', () => {
  it('carries its own exact id in the call that replies to it, whatever its kind', () => {
    const records = [{ label: 'Your change', record_type: 'task', record_id: NOTICE_B, title: 'T', text: 'body', url: null }]
    const notices = [
      { kind: 'server_notice', notice_id: NOTICE_A, topic: 'conflict', notice_type: 'decision_conflict', summary: 'S', prompt: 'P', records, allowed_outcomes: [], allowed_tools: [] },
      { kind: 'unlinked_commit_item_review', notice_id: NOTICE_A, commit_sha: 'abc1234', task_id: NOTICE_B, task_title: 'T', prompt: 'P', allowed_outcomes: ['link'], allowed_tools: ['add_commit_reference'] },
      // A kind this version cannot read: the person is still told, as a reply to it.
      { version: 1, kind: 'requirement_outcome', notice_id: NOTICE_A, contract_uri: 'devspec://product/remote-ingress-contract' },
    ]
    for (const notice of notices) {
      const content = formatSystemNoticeContent(notice)
      assert.ok(content.includes(replyLine([NOTICE_A])), notice.kind)
      assert.ok(content.includes(`"system_notice_ids": ["${NOTICE_A}"]`), notice.kind)
    }
  })
})
