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
  storeTiers(connectionId,payload,{dir})
  const after=readPrivateJsonResult(tiersPath(connectionId,dir))
  if(after.status!==STATE_OK) throw new Error('Instruction context could not be preserved')
  // Response style is attributed to each command's sender, never this cached owner.
  const text=renderTiers(Object.fromEntries(Object.entries(after.value.texts).filter(([key])=>key!=='owner_custom_instructions')))
  const file=path.join(dir,`${connectionId}.tiers-${createHash('sha256').update(text).digest('hex')}.txt`)
  writePrivateText(file,text)
  return file
}

/**
 * File the tier texts a registration returned. Returns false when there was nothing to
 * file — an `instructions_unchanged` reply carries no texts, and must never overwrite
 * texts already on disk with nothing.
 */
export function storeTiers(connectionId, registration, { dir = CONNECTIONS_DIR, now = new Date() } = {}) {
  if (!connectionId || !registration || registration.instructions_unchanged) return false
  const prior = readPrivateJsonResult(tiersPath(connectionId, dir))
  const texts = { ...(prior.status === STATE_OK ? prior.value?.texts : {}) }
  for (const [field] of TIER_FIELDS) {
    const value = registration[field]
    if (typeof value === 'string' || value === null) texts[field] = value
  }
  writePrivateJson(tiersPath(connectionId, dir), {
    connection_id: connectionId,
    version: registration.instruction_tiers_version ?? null,
    hash: registration.instruction_tiers_hash ?? null,
    texts,
    stored_at: now.toISOString(),
    // Which conversation has already read these. A fresh store resets it: new texts
    // have been read by nobody.
    delivered_to: prior.status === STATE_OK && prior.value?.hash === (registration.instruction_tiers_hash ?? null)
      && JSON.stringify(prior.value.texts) === JSON.stringify(texts) ? prior.value.delivered_to : null,
  })
  return true
}

/**
 * What the first command of a conversation should read.
 *
 * Returns `{ status: 'deliver', text }` the first time a conversation asks for a given
 * set of tiers, `{ status: 'unchanged' }` when that same conversation asks again, and
 * `{ status: 'absent' }` when nothing was filed — a connection made by
 * `/devspec.remote`, which printed its tiers into the conversation at connect time.
 *
 * `localId` keys the delivery: after `/clear` the conversation is new and holds none
 * of what the old one read, so it is handed the texts again.
 */
export function takeTiersFor(connectionId, localId, { dir = CONNECTIONS_DIR, force = false } = {}) {
  const file = tiersPath(connectionId, dir)
  const read = readPrivateJsonResult(file)
  if (read.status !== STATE_OK || !read.value) return { status: 'absent' }
  const stored = read.value
  const deliveredKey = `${localId || 'unknown'}@${stored.hash || 'nohash'}`
  if (!force && stored.delivered_to === deliveredKey) return { status: 'unchanged' }
  const text = renderTiers(stored.texts || {})
  writePrivateJson(file, { ...stored, delivered_to: deliveredKey })
  return { status: 'deliver', text }
}
