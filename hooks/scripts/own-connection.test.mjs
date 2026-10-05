import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ownConnectionId, withOwnConnection } from './own-connection.mjs'
import { prepareDevspecToolInput } from './devspec-tool-input.mjs'
import { saveConversationProject } from './conversation-project.mjs'

const MINE = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const CONVERSATION = 'claude-conversation-718825fc'
const notElsewhere = { ownedElsewhere: () => false }

let home
let dir
function bond(connectionId, extra = {}) {
  fs.writeFileSync(path.join(dir, `${connectionId}.json`), JSON.stringify({
    connection_id: connectionId, enabled: true, agent_name: 'Claude Code', local_id: CONVERSATION, ...extra,
  }), { mode: 0o600 })
}
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-own-connection-'))
  dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
})

describe('ownConnectionId', () => {
  it('is the live connection bound to exactly this conversation', () => {
    bond(MINE)
    bond(OTHER, { local_id: 'another-conversation' })
    fs.writeFileSync(path.join(dir, `${MINE}.listener.json`), '{}')
    assert.equal(ownConnectionId(CONVERSATION, { home, ...notElsewhere }), MINE)
  })
  it("never another conversation's, a disabled one, another host's, or one a resumed window owns", () => {
    bond(OTHER, { local_id: 'another-conversation' })
    assert.equal(ownConnectionId(CONVERSATION, { home, ...notElsewhere }), null)
    bond(MINE, { enabled: false })
    assert.equal(ownConnectionId(CONVERSATION, { home, ...notElsewhere }), null)
    bond(MINE, { agent_name: 'Pi' })
    assert.equal(ownConnectionId(CONVERSATION, { home, ...notElsewhere }), null)
    bond(MINE)
    assert.equal(ownConnectionId(CONVERSATION, { home, myPid: 4242, ownedElsewhere: () => true }), null)
  })
  it('names nobody when two connections claim the conversation', () => {
    bond(MINE)
    bond(OTHER)
    assert.equal(ownConnectionId(CONVERSATION, { home, ...notElsewhere }), null)
  })
})

describe('withOwnConnection', () => {
  it('adds the connection to a call that names none', () => {
    assert.deepEqual(withOwnConnection('create_action_item', { title: 't' }, MINE), { title: 't', connection_id: MINE })
    assert.deepEqual(withOwnConnection('search_memories', { query: 'q' }, MINE), { query: 'q', connection_id: MINE })
  })
  it('leaves a call that names a connection or a room exactly as written', () => {
    const named = { title: 't', connection_id: OTHER }
    assert.equal(withOwnConnection('create_action_item', named, MINE), named)
    const room = { message: 'm', session_id: 'room' }
    assert.equal(withOwnConnection('post_session_message', room, MINE), room)
  })
  it('never aims a call whose subject is a connection', () => {
    for (const tool of ['register_connection', 'attach_connection', 'detach_connection',
      'heartbeat_connection', 'poll_connection', 'verify_agent_connection', 'get_connection_dispatch',
      'report_pickup', 'report_keepalive', 'report_complete']) {
      const args = {}
      assert.equal(withOwnConnection(tool, args, MINE), args, tool)
    }
  })
  it('changes nothing without a connection', () => {
    const args = { title: 't' }
    assert.equal(withOwnConnection('create_action_item', args, null), args)
  })
})

describe('the PreToolUse hook stamps project and connection in one input', () => {
  it("adds this conversation's connection beside its project", () => {
    const endpoint = 'https://devspec.invalid/api/mcp'
    const project = { id: '33333333-3333-4333-8333-333333333333', name: 'Fixture' }
    saveConversationProject(CONVERSATION, endpoint, project, 'explicit', { home })
    bond(MINE)
    const output = prepareDevspecToolInput({
      session_id: CONVERSATION,
      tool_name: 'mcp__plugin_devspec_devspec__create_action_item',
      tool_input: { title: 'filed from the terminal' },
    }, { home, env: { CLAUDE_PLUGIN_OPTION_DEVSPEC_MCP_URL: endpoint } })
    assert.deepEqual(output.hookSpecificOutput.updatedInput, {
      title: 'filed from the terminal', project_id: project.id, connection_id: MINE,
    })
    assert.equal(output.hookSpecificOutput.permissionDecision, undefined)
  })
})
