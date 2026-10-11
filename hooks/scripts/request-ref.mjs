/**
 * Stamp the request a DevSpec write serves (item 7a4d04fd, requests.mjs).
 *
 * Only this plugin knows what woke the agent, so the write carries it: the request
 * the current turn continues, or, for a subagent, the request that launched it.
 * `request_ref` is a host-only parameter DevSpec hides from the model; a tool that
 * does not declare it simply drops it. A call that already names a request, and a
 * call whose subject is a connection, are left as written. Nothing known stamps
 * nothing, which leaves DevSpec to resolve who asked as it always has.
 *
 * When the turn carries more than one person's request and the agent has not said
 * which it is working on, a write that records who asked is refused, with the
 * requests it could serve and the one command that names one. Never a guess: a
 * write credited to the wrong person is judged by the wrong person's role.
 */

import os from 'node:os'
import path from 'node:path'
import { readRequestState, requestRefForWrite, serveCommand, turnAmbiguity } from './requests.mjs'

const CONNECTION_SUBJECT = /(?:^|_)connection(?:_|$)|^report_(?:pickup|keepalive|complete|request)$/

/**
 * The DevSpec tools that record who asked for a write and take `request_ref` (the
 * server's `provenance: 'work_claim'` tools). server-tool-names.test.mjs checks
 * this against a devspecv2 checkout beside the plugin.
 */
export const REQUEST_REF_TOOLS = new Set([
  'add_commit_reference', 'add_implementation_note', 'archive_resource', 'classify_criterion',
  'create_action_item', 'create_automation', 'create_resource', 'delete_automation',
  'fail_work_item', 'import_instruction_rules', 'link_action_items', 'manage_knowledge_links',
  'record_completed_work', 'record_criterion_verdicts', 'record_implementation', 'record_memory',
  'release_work_item', 'reopen_action_item', 'resolve_memory_flag', 'resolve_resource_flag',
  'retract_memory', 'spin_off_action_item', 'supersede_action_item', 'supersede_memory',
  'supersede_resource', 'unlink_action_items', 'update_action_item', 'update_automation',
  'update_memory', 'update_resource', 'write_project_instruction_rule',
])

function describeRequest(entry) {
  if (entry.kind === 'none') return '- nobody\'s request (your own initiative): --none'
  if (entry.kind === 'typed_prompt') return '- the prompt your owner typed at this terminal: --terminal'
  return `- the room command with message_id ${entry.message_id ?? '(unknown)'}: --message-id ${entry.message_id ?? '<id>'}`
}

/**
 * @returns {{ args: object } | { deny: string }} the call's arguments, stamped, or
 *   why it is refused
 */
export function stampRequest(toolName, args, connectionId, agentId = null, { home = os.homedir() } = {}) {
  if (!connectionId || !args || typeof args !== 'object' || CONNECTION_SUBJECT.test(toolName)) return { args }
  if (args.request_ref !== undefined) return { args }
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  const state = readRequestState(connectionId, { dir })
  const agent = typeof agentId === 'string' && agentId ? agentId : null
  // A write that cites the work it belongs to (work_claim_ref) or the command it
  // serves (provenance_ref) already says whose it is: DevSpec reads those first.
  const cites = typeof args.work_claim_ref === 'string' || typeof args.provenance_ref === 'string'
  const ambiguous = REQUEST_REF_TOOLS.has(toolName) && !cites ? turnAmbiguity(state, agent) : null
  if (ambiguous) {
    return { deny: [
      'This turn carries requests from more than one person (or from a person and nobody), and DevSpec records who asked for this write.',
      'Say which request it serves, then make the call again. Run:',
      `  ${serveCommand(connectionId)} <one of>`,
      ...ambiguous.map(describeRequest),
      'Writes follow that request until another reaches you. Name each request before its writes when you switch.',
    ].join('\n') }
  }
  const ref = requestRefForWrite(state, agent)
  return { args: ref ? { ...args, request_ref: ref } : args }
}
