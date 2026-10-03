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

/**
 * How much each Claude Code channel can actually show the model (item 1dbb6d5c).
 *
 * Past these, Claude Code saves the text to a file and shows a 2,000-character preview
 * instead, so anything after the first 2,000 characters never arrives:
 *  - a hook's additionalContext: 10,000 characters; no setting raises it, and Claude is
 *    never asked to read the file (code.claude.com/docs/en/hooks.md);
 *  - a valid Bash result (orient, and connect's status block): ~30,000 by default
 *    (code.claude.com/docs/en/tools-reference.md, "Output limits").
 * The reserve is room for what shares the block: separators, a pointer notice, and the
 * status lines printed beside the rules.
 */
export const CHANNEL_LIMITS = Object.freeze({ hookContext: 10_000, bashResult: 30_000 })
export const CHANNEL_RESERVE = 1_500

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

/**
 * Write rendered tiers to a private file named by their content, and return its path.
 * Same text, same name — so a model can tell a file it already read from changed rules.
 */
export function saveTiersText(connectionId, text, {dir=CONNECTIONS_DIR}={}) {
  const file=path.join(dir,`${connectionId}.tiers-${createHash('sha256').update(text).digest('hex')}.txt`)
  writePrivateText(file,text)
  return file
}

/**
 * What the model sees instead of the rules when they are too long for the channel.
 *
 * Every host channel has a ceiling, and past it the text does not arrive: Claude Code
 * turns an over-long hook string into a 2,000-character preview plus a file path it
 * never asks the model to read (item 1dbb6d5c). So the rules go to a file, and this
 * short notice — which always fits — tells the model to read all of it.
 */
export function renderTiersPointer(file, chars) {
  return '\n## Instructions in force for this run\n\n' +
    `The owner's and this project's rules for this run are ${chars.toLocaleString('en-US')} characters, too long to show here. ` +
    `They are saved in full at:\n\n${file}\n\n` +
    'Read that whole file now, before acting on any request, and follow it for the rest of this conversation. ' +
    'If it is shown to you in parts, keep reading to the end. A different file name later means the rules changed: read the new one.\n'
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
  const file=saveTiersText(connectionId,text,{dir})
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
 * `inlineLimit` is how much the caller's channel can actually show the model. Tiers
 * longer than that are saved to a file and returned as `{ status: 'pointer', text,
 * file }`, where `text` is the short notice to emit instead. The receipt records which
 * of the two happened, so a later reader never says "already delivered" about rules
 * that were only pointed to: it gets `{ status: 'unchanged', pointer }` to restate, or
 * the full text when its own channel is big enough. A receipt with no mode was written
 * before this distinction existed, when over-long tiers were lost while still being
 * marked delivered (item 1dbb6d5c), so it counts as no delivery at all.
 *
 * `localId` keys the delivery: after `/clear` the conversation is new and holds none
 * of what the old one read, so it is handed the texts again.
 */
export function takeTiersFor(connectionId, localId, { dir = CONNECTIONS_DIR, force = false, inlineLimit = Infinity, writeReceipt = writePrivateJson } = {}) {
  const file = tiersPath(connectionId, dir)
  const read = readPrivateJsonResult(file)
  if (read.status !== STATE_OK || !read.value) return { status: 'absent' }
  const stored = read.value
  const text = renderTiers(stored.texts || {})
  const deliveredKey = `${stored.hash || 'nohash'}@${createHash('sha256').update(text).digest('hex')}`
  const reader = createHash('sha256').update(localId || 'unknown').digest('hex')
  const receiptFile = path.join(dir,`${connectionId}.tiers-delivery-${reader}.json`)
  const receipt = readPrivateJsonResult(receiptFile)
  const prior = receipt.status === STATE_OK && receipt.value?.delivered_key === deliveredKey ? receipt.value.mode : null
  const fits = text.length <= inlineLimit
  if (!force && prior === 'inline') return { status: 'unchanged' }
  // Readers only write their receipt and the content-addressed text file. Rewriting the
  // tier cache here could overwrite a newer poll/attach snapshot published between this
  // read and this write.
  if (!force && prior === 'pointer' && !fits) {
    return { status: 'unchanged', pointer: renderTiersPointer(saveTiersText(connectionId, text, { dir }), text.length) }
  }
  if (fits) {
    writeReceipt(receiptFile, { delivered_key: deliveredKey, mode: 'inline' })
    return { status: 'deliver', text }
  }
  const saved = saveTiersText(connectionId, text, { dir })
  writeReceipt(receiptFile, { delivered_key: deliveredKey, mode: 'pointer' })
  return { status: 'pointer', text: renderTiersPointer(saved, text.length), file: saved }
}
