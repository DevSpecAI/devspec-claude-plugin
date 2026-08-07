#!/usr/bin/env node
/**
 * Attachment materialisation — the ONE place an owner command's attachments turn
 * from a server payload into something a model can actually open.
 *
 * WHY THIS IS ITS OWN MODULE (item b237de43).
 *
 * It used to live in `devspec-remote-wait.mjs` and run when that script PRINTED a
 * stream event. The inbox line kept the raw payload, deliberately, as "the durable
 * record" — and that is where the fix leaked. A long owner command is truncated in
 * the host's notification, so the only way to read the whole thing is to open
 * `inbox.jsonl`, which is precisely the path the materialisation did not cover. The
 * obvious reader there is `console.log(m.content)`, and the attachment vanishes with
 * no warning to anybody. That is how a screenshot was lost on 2026-08-02, six days
 * AFTER 99165e12 shipped the stream-side fix, on a build that had it.
 *
 * So materialisation now happens at WRITE time (`devspec-remote-poll.mjs`), and this
 * module is what both halves import. The inbox is then self-describing: every
 * attachment is a descriptor naming a real file, and no reader — however naive — can
 * silently drop one, because there is no longer a payload hiding behind `content`.
 *
 * `describeAttachment` is idempotent: hand it a descriptor it already produced and it
 * returns it untouched. That is not a nicety, it is load-bearing. The wait script
 * still calls this on everything it reads, and without the pass-through it would look
 * for `content`/`dataUrl`, find neither, return null, and DROP the descriptor — a
 * worse bug than the one being fixed. It also keeps inbox lines written by an older
 * poller working, which matters because a running poller keeps the code it started
 * with until the agent is relaunched.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

/** Small text payloads are cheap and immediately useful, so they stay inline. */
export const MAX_INLINE_ATTACHMENT_CHARS = 2048

/** Where this connection's decoded attachments land. */
export function attachmentDirFor(connectionId) {
  return path.join(CONNECTIONS_DIR, `${connectionId}.attachments`)
}

/** The delivery kinds this module produces. Anything else is not ours. */
const DELIVERY_KINDS = new Set(['file', 'inline', 'unavailable'])

/**
 * Has this attachment already been through here? Checked by value, not by trusting
 * any string in `delivery` — the server payload never carries the field at all, so a
 * known kind is a reliable signature of our own output.
 */
export function isMaterialisedDescriptor(a) {
  return !!a && typeof a === 'object' && DELIVERY_KINDS.has(a.delivery)
}

/** Filesystem-safe leaf name; never lets a filename escape the attachment dir. */
function safeAttachmentName(filename) {
  const base = path.basename(String(filename || 'attachment'))
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '')
  return cleaned.slice(0, 120) || 'attachment'
}

/** Default sink: 0600 under the connection's attachment dir. */
export function defaultWriteFile(target, buf) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, buf, { mode: 0o600 })
}

/**
 * Turn one server attachment into something a model can actually use, WITHOUT
 * putting its payload in the record (item 99165e12).
 *
 * The server sends `content` (base64) and, for images, `dataUrl` — which is the same
 * bytes again with a prefix. Printing that verbatim is what the shared pollers used to
 * do, and it is the worse half of that bug: a 500KB screenshot became a **1.37MB**
 * payload, ~341k tokens of base64 that the model cannot see as an image anyway.
 * Silently dropping it (what OpenCode did) at least stayed cheap; this detonated the
 * context window AND still failed to deliver the picture.
 *
 * So: decode once to a real file on disk and hand back a path. Every host in this
 * family can open a local file, and an image read from disk is a genuine image rather
 * than a base64 string. Small text stays inline because a path would be pure overhead.
 *
 * `writeFile` is injected so the decision is testable without touching a filesystem.
 */
export function describeAttachment(a, { dir, messageId, index, writeFile } = {}) {
  if (!a || typeof a !== 'object') return null

  // Already ours — hand it straight back. See the module header: re-deriving it would
  // fail (there is no payload left to read) and the failure mode is a silent drop.
  if (isMaterialisedDescriptor(a)) return a

  const filename = safeAttachmentName(a.filename)
  const mimeType = typeof a.mimeType === 'string' ? a.mimeType : 'application/octet-stream'
  const type = typeof a.type === 'string' ? a.type : 'document'
  const sizeBytes = typeof a.sizeBytes === 'number' ? a.sizeBytes : null

  // dataUrl is content re-encoded; prefer content and never carry both.
  let b64 = typeof a.content === 'string' && a.content ? a.content : null
  if (!b64 && typeof a.dataUrl === 'string') {
    const comma = a.dataUrl.indexOf(',')
    if (comma !== -1) b64 = a.dataUrl.slice(comma + 1)
  }
  if (!b64) return null

  const base = { filename, mimeType, type, sizeBytes }

  // Small text/markdown/json inline — a file path for 300 bytes helps nobody.
  const isTextual = type === 'text' || /^text\/|json|xml|yaml/.test(mimeType)
  if (isTextual) {
    let decoded = null
    try {
      decoded = Buffer.from(b64, 'base64').toString('utf8')
    } catch {
      decoded = null
    }
    if (decoded !== null && decoded.length <= MAX_INLINE_ATTACHMENT_CHARS) {
      return { ...base, delivery: 'inline', content: decoded }
    }
  }

  if (!dir || typeof writeFile !== 'function') {
    // No landing place — say so rather than pretend, and never inline the base64.
    return {
      ...base,
      delivery: 'unavailable',
      note: 'Attachment could not be written to disk; re-read it with get_session_transcript.',
    }
  }

  const leaf = `${String(messageId || 'msg').slice(0, 12)}-${index}-${filename}`
  const target = path.join(dir, leaf)
  try {
    writeFile(target, Buffer.from(b64, 'base64'))
  } catch (e) {
    return {
      ...base,
      delivery: 'unavailable',
      note: `Attachment could not be written to disk (${e.message}); re-read it with get_session_transcript.`,
    }
  }
  return {
    ...base,
    delivery: 'file',
    path: target,
    note:
      type === 'image'
        ? 'Image saved locally — OPEN THIS PATH to see it. It is part of the command, not decoration.'
        : 'Saved locally — read this path if the command refers to it.',
  }
}

/**
 * Replace a message's `attachments` with payload-free descriptors. Returns a NEW
 * message object, or the SAME object when there is nothing to do — callers rely on
 * that identity to prove an attachment-free command is untouched.
 */
export function materialiseAttachments(message, opts = {}) {
  const list = Array.isArray(message?.attachments) ? message.attachments : null
  if (!list || list.length === 0) return message
  const described = list
    .map((a, i) => describeAttachment(a, { ...opts, messageId: message.id, index: i }))
    .filter(Boolean)
  if (described.length === 0) {
    const { attachments, ...rest } = message
    return rest
  }
  return { ...message, attachments: described }
}

/**
 * Materialise every message in a batch. This is what the poller calls before it
 * writes the inbox line, so the durable record and the wake event agree.
 */
export function materialiseBatchAttachments(messages, { dir, writeFile = defaultWriteFile } = {}) {
  if (!Array.isArray(messages)) return []
  return messages.map((m) => materialiseAttachments(m, { dir, writeFile }))
}
