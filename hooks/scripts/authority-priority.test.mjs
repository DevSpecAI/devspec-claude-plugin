#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8')
}

describe('current Claude authority and work-acquisition prose', () => {
  it('teaches canonical authority and conversation-requested reserve then claim', () => {
    const command = source('commands/devspec.remote.md')
    const workSection = command.slice(command.indexOf('## 5. Working action items when asked'))

    assert.match(command, /devspec:\/\/product\/remote-ingress-contract/)
    assert.match(command, /Preserve the command's requester attribution/)
    assert.match(command, /A sessionless connection has no conversation answer path/)
    assert.match(workSection, /Nothing is ever sent work/)
    assert.match(workSection, /Only acquire action-item work when a canonical conversation explicitly asks/)
    assert.ok(workSection.indexOf('reserve_work_items') < workSection.indexOf('claim_work_item'))
    assert.match(workSection, /devspec:\/\/product\/implementation-contract/)
    assert.match(workSection, /separately typed, exactly addressed `playbook_run` path/)

    assert.doesNotMatch(command, /assignment protocol/i)
    assert.doesNotMatch(command, /ready for dispatch/i)
    assert.doesNotMatch(command, /Sessionless: use `report_progress`/)
    assert.doesNotMatch(command, /mcp__devspec__get_connection_dispatch/)
  })

  it('keeps user-facing and maintainer docs free of sessionless assignment claims', () => {
    const readme = source('README.md')
    const overview = source('docs/remote-control/remote-control-overview.md')
    const claude = source('docs/remote-control/remote-control-claude-code.md')
    const independence = source('docs/PLUGIN-INDEPENDENCE.md')
    const currentDocs = [readme, overview, claude, independence].join('\n')

    assert.match(currentDocs, /server-only owner\/delegated exact-target authority/)
    assert.match(currentDocs, /immutable requester provenance/)
    assert.match(currentDocs, /Typed host controls|typed controls/)
    assert.match(currentDocs, /owner-scoped playbook runs/)
    assert.match(currentDocs, /devspec:\/\/product\/implementation-contract/)
    assert.match(readme, /Sessionless means available; it does not receive action-item assignments/)
    assert.match(readme, /owner or a server-authorized delegate[^\n]*exactly addressed command/)

    assert.doesNotMatch(currentDocs, /receives dispatches \/ assignments/i)
    assert.doesNotMatch(currentDocs, /assignment protocol/i)
    assert.doesNotMatch(currentDocs, /idle connected session[^\n]*picks them up/i)
    assert.doesNotMatch(currentDocs, /Sessionless: assignment \/ `report_progress` only/i)
    assert.doesNotMatch(currentDocs, /while only you can actually steer it/i)
  })
})

describe('Claude authority source boundaries', () => {
  it('retains exact-target canonical authority, requester provenance, and typed controls', () => {
    const ingress = source('hooks/scripts/remote-ingress-v1.mjs')

    assert.match(ingress, /AUTHORITY_KINDS = new Set\(\['owner', 'delegated'\]\)/)
    assert.match(ingress, /value\.decision_source !== 'server'/)
    assert.match(ingress, /value\.requester\.user_id === value\.authority\.requested_by_user_id/)
    assert.match(ingress, /input\.connection\.connection_id !== connectionId/)
    assert.match(ingress, /CONTROL_VERBS = new Set/)
  })

  it('retains the independent exactly addressed playbook path without assignment prose', () => {
    const poll = source('hooks/scripts/devspec-remote-poll.mjs')
    const wait = source('hooks/scripts/devspec-remote-wait.mjs')

    assert.match(poll, /dispatch\.kind === 'playbook_run'/)
    assert.match(poll, /dispatch\.delivery_connection_id === connectionId/)
    assert.match(poll, /Object\.keys\(dispatch\.requester\)\.length === 1/)
    assert.match(wait, /d\.kind === 'playbook_run'/)
    assert.match(wait, /d\.delivery_connection_id === connectionId/)
    assert.match(wait, /channel: 'explicit_playbook_dispatch'/)

    assert.doesNotMatch(poll, /live assignment|life of an assignment|assignment protocol/i)
    assert.doesNotMatch(wait, /assignment protocol/i)
  })
})
