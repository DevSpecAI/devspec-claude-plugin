/**
 * The instruction tiers a connection is handed at register time, and where they wait
 * when nobody is reading yet.
 *
 * `/devspec.remote` prints the tiers into the conversation as it connects, because the
 * model is right there. A connection Claude Code starts on its own (item b7ef1fe2) has
 * no model to print them to: nothing reads until the first command arrives, which may
 * be hours later or never. So the startup listener files them here, privately, and the
 * `devspec-remote-command` skill reads them once, on the first command a conversation
 * handles. An idle agent pays nothing for them.
 *
 * Manual connects also retain the snapshot for resume/compaction. Delivery receipts
 * are separate per-conversation files: consuming context never rewrites producer state.
 *
 * The file sits beside the connection's other private state and goes through the same
 * private-state boundary, so it inherits its permissions and its repair of older modes.
 */

import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readPrivateJsonResult, STATE_OK, writePrivateJson, writePrivateText } from './private-state.mjs'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

/** The tier fields the server may hand back, in the order they should be read. */
export const TIER_FIELDS = [
  ['owner_custom_instructions', 'Your response style'],
  ['owner_agent_rules', 'Your personal agent rules (machine/tooling)'],
  ['project_custom_instructions', 'Project principles (team-wide)'],
  ['project_agent_rules', 'Project agent rules (execution mechanics)'],
]

export function renderTiers(payload) {
  if (payload?.instructions_unchanged) {
    return '\nInstructions: unchanged since this conversation last connected — the tiers you already hold still apply.\n'
  }
  const parts = []
  for (const [field, label] of TIER_FIELDS) {
    const value = payload?.[field]
    if (typeof value === 'string' && value.trim()) {
      parts.push(`\n### ${label}\n\n${value}\n`)
    } else if (Object.hasOwn(payload ?? {}, field)) {
      parts.push(`\n### ${label}\n\nNo instruction configured (clears the previous value).\n`)
    }
  }
  if (!parts.length) return ''
  return `\n## Instructions in force for this run\n${parts.join('')}`
}

export function tiersPath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.tiers.json`)
}

export function hasStoredTiers(connectionId, {dir=CONNECTIONS_DIR}={}) {
  return readPrivateJsonResult(tiersPath(connectionId,dir)).status === STATE_OK
}

/** Attach replies may clear a rule; missing fields do not erase a prior registration. */
export function mergeInstructionTiers(previous, incoming) {
  if (incoming?.instructions_unchanged) return previous
  const merged={...previous}
  for(const [field] of TIER_FIELDS) if(typeof incoming?.[field]==='string' || incoming?.[field]===null) merged[field]=incoming[field]
  for(const field of ['instruction_tiers_version','instruction_tiers_hash']) if(incoming?.[field]!=null) merged[field]=incoming[field]
  if(TIER_FIELDS.some(([field])=>Object.hasOwn(incoming??{},field))) delete merged.instructions_unchanged
  return merged
}

/** Save changed server rules as an immutable, complete file for a queued command. */
export function captureInstructionContext(connectionId, payload, {dir=CONNECTIONS_DIR}={}) {
  if(payload?.instructions_unchanged || !TIER_FIELDS.some(([key])=>Object.hasOwn(payload??{},key))) return null
  const snapshot=tierSnapshot(connectionId,payload,dir,new Date())
  // Render this response's snapshot, not a mutable cache another process can replace.
  // Response style is attributed to each command's sender, never this cached owner.
  const text=renderTiers(Object.fromEntries(Object.entries(snapshot.texts).filter(([key])=>key!=='owner_custom_instructions')))
  const file=path.join(dir,`${connectionId}.tiers-${createHash('sha256').update(text).digest('hex')}.txt`)
  writePrivateText(file,text)
  writePrivateJson(tiersPath(connectionId,dir),snapshot)
  return file
}

/** Build a response-owned snapshot; absent fields retain the last known value. */
function tierSnapshot(connectionId, registration, dir, now) {
  const prior = readPrivateJsonResult(tiersPath(connectionId, dir))
  const texts = { ...(prior.status === STATE_OK ? prior.value?.texts : {}) }
  for (const [field] of TIER_FIELDS) {
    const value = registration[field]
    if (typeof value === 'string' || value === null) texts[field] = value
  }
  return {
    connection_id: connectionId,
    version: registration.instruction_tiers_version ?? null,
    hash: registration.instruction_tiers_hash ?? null,
    texts,
    stored_at: now.toISOString(),
  }
}

/** Unchanged replies carry no text and never erase the stored snapshot. */
export function storeTiers(connectionId, registration, { dir = CONNECTIONS_DIR, now = new Date() } = {}) {
  if (!connectionId || !registration || registration.instructions_unchanged) return false
  writePrivateJson(tiersPath(connectionId, dir),tierSnapshot(connectionId,registration,dir,now))
  return true
}

/**
 * What the first command of a conversation should read.
 *
 * Returns `{ status: 'deliver', text }` the first time a conversation asks for a given
 * set of tiers, `{ status: 'unchanged' }` when that same conversation asks again, and
 * `{ status: 'absent' }` when nothing was filed, including connections made by an
 * older plugin. Current manual and automatic connections both retain full snapshots.
 *
 * `localId` keys the delivery: after `/clear` the conversation is new and holds none
 * of what the old one read, so it is handed the texts again.
 */
export function takeTiersFor(connectionId, localId, { dir = CONNECTIONS_DIR, force = false, writeReceipt = writePrivateJson } = {}) {
  const file = tiersPath(connectionId, dir)
  const read = readPrivateJsonResult(file)
  if (read.status !== STATE_OK || !read.value) return { status: 'absent' }
  const stored = read.value
  const text = renderTiers(stored.texts || {})
  const deliveredKey = `${stored.hash || 'nohash'}@${createHash('sha256').update(text).digest('hex')}`
  const reader = createHash('sha256').update(localId || 'unknown').digest('hex')
  const receiptFile = path.join(dir,`${connectionId}.tiers-delivery-${reader}.json`)
  const receipt = readPrivateJsonResult(receiptFile)
  if (!force && receipt.status === STATE_OK && receipt.value?.delivered_key === deliveredKey) return { status: 'unchanged' }
  // Readers only write their receipt. Rewriting the tier cache here could overwrite
  // a newer poll/attach snapshot published between this read and this write.
  writeReceipt(receiptFile, {delivered_key:deliveredKey})
  return { status: 'deliver', text }
}
