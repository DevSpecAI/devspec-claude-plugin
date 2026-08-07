#!/usr/bin/env node
/**
 * Unit tests for attachment-store — the single materialisation point.
 * Run: node --test hooks/scripts/attachment-store.test.mjs
 *
 * The load-bearing case here is the IDEMPOTENT PASS-THROUGH (item b237de43). Once the
 * poller materialises at inbox-write time, the wait script reads a descriptor rather
 * than a payload — and if describeAttachment did not recognise its own output it would
 * find no `content`/`dataUrl`, return null, and drop the attachment entirely. That
 * would be a worse bug than the silent-drop this change exists to fix, so it is
 * asserted directly rather than left to follow from the implementation.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  attachmentDirFor,
  describeAttachment,
  isMaterialisedDescriptor,
  materialiseAttachments,
  materialiseBatchAttachments,
  MAX_INLINE_ATTACHMENT_CHARS,
} from './attachment-store.mjs'

const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64')

function imageAttachment(over = {}) {
  return {
    filename: 'shot.png',
    mimeType: 'image/png',
    type: 'image',
    sizeBytes: 14,
    content: PNG_B64,
    ...over,
  }
}

/** Records writes instead of touching a filesystem. */
function recordingWriter() {
  const writes = []
  const writeFile = (target, buf) => writes.push({ target, bytes: buf.length })
  return { writes, writeFile }
}

describe('describeAttachment: server payload → descriptor', () => {
  it('decodes an image to disk and returns a path, never the payload', () => {
    const { writes, writeFile } = recordingWriter()
    const d = describeAttachment(imageAttachment(), {
      dir: '/att',
      messageId: 'msg-1234567890abcdef',
      index: 0,
      writeFile,
    })
    assert.equal(d.delivery, 'file')
    assert.equal(d.path, '/att/msg-12345678-0-shot.png')
    assert.equal(d.content, undefined)
    assert.equal(d.dataUrl, undefined)
    assert.match(d.note, /OPEN THIS PATH/)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].bytes, Buffer.from(PNG_B64, 'base64').length)
  })

  it('keeps a small text attachment inline', () => {
    const d = describeAttachment(
      {
        filename: 'note.txt',
        mimeType: 'text/plain',
        type: 'text',
        content: Buffer.from('hello').toString('base64'),
      },
      { dir: '/att', messageId: 'm', index: 0, writeFile: () => {} },
    )
    assert.equal(d.delivery, 'inline')
    assert.equal(d.content, 'hello')
  })

  it('sends an oversized text attachment to disk rather than inline', () => {
    const big = 'x'.repeat(MAX_INLINE_ATTACHMENT_CHARS + 1)
    const { writeFile } = recordingWriter()
    const d = describeAttachment(
      {
        filename: 'big.txt',
        mimeType: 'text/plain',
        type: 'text',
        content: Buffer.from(big).toString('base64'),
      },
      { dir: '/att', messageId: 'm', index: 0, writeFile },
    )
    assert.equal(d.delivery, 'file')
  })

  it('sanitises a traversal filename into the attachment dir', () => {
    const { writeFile } = recordingWriter()
    const d = describeAttachment(imageAttachment({ filename: '../../etc/passwd' }), {
      dir: '/att',
      messageId: 'm',
      index: 0,
      writeFile,
    })
    assert.equal(d.path, '/att/m-0-passwd')
  })

  it('says so rather than dropping when there is nowhere to write', () => {
    const d = describeAttachment(imageAttachment(), { messageId: 'm', index: 0 })
    assert.equal(d.delivery, 'unavailable')
    assert.match(d.note, /get_session_transcript/)
    assert.equal(d.content, undefined)
  })

  it('reports a failed write instead of pretending it landed', () => {
    const d = describeAttachment(imageAttachment(), {
      dir: '/att',
      messageId: 'm',
      index: 0,
      writeFile: () => {
        throw new Error('disk full')
      },
    })
    assert.equal(d.delivery, 'unavailable')
    assert.match(d.note, /disk full/)
  })

  it('returns null for a metadata-only stub with no payload at all', () => {
    const d = describeAttachment({ filename: 'ghost.png', mimeType: 'image/png', type: 'image' }, {
      dir: '/att',
      messageId: 'm',
      index: 0,
      writeFile: () => {},
    })
    assert.equal(d, null)
  })
})

describe('describeAttachment: already-materialised pass-through (b237de43)', () => {
  it('returns an existing file descriptor untouched and writes nothing', () => {
    const existing = {
      filename: 'shot.png',
      mimeType: 'image/png',
      type: 'image',
      sizeBytes: 14,
      delivery: 'file',
      path: '/att/m-0-shot.png',
      note: 'Image saved locally — OPEN THIS PATH to see it. It is part of the command, not decoration.',
    }
    const { writes, writeFile } = recordingWriter()
    const d = describeAttachment(existing, { dir: '/other', messageId: 'm', index: 0, writeFile })
    assert.equal(d, existing, 'must be the same object, not a re-derived one')
    assert.equal(writes.length, 0, 'must not rewrite a file the poller already wrote')
  })

  it('passes inline and unavailable descriptors through too', () => {
    for (const delivery of ['inline', 'unavailable']) {
      const existing = { filename: 'n.txt', mimeType: 'text/plain', type: 'text', delivery }
      assert.equal(describeAttachment(existing, { dir: '/att', writeFile: () => {} }), existing)
    }
  })

  it('does NOT treat an unknown delivery value as one of ours', () => {
    // A server payload will never carry `delivery`, but if something ever did, an
    // unrecognised value must fall through to normal handling rather than being
    // trusted as an already-written file.
    const odd = { ...imageAttachment(), delivery: 'carrier-pigeon' }
    const { writeFile } = recordingWriter()
    const d = describeAttachment(odd, { dir: '/att', messageId: 'm', index: 0, writeFile })
    assert.equal(d.delivery, 'file')
  })

  it('isMaterialisedDescriptor only accepts the three kinds we produce', () => {
    assert.equal(isMaterialisedDescriptor({ delivery: 'file' }), true)
    assert.equal(isMaterialisedDescriptor({ delivery: 'inline' }), true)
    assert.equal(isMaterialisedDescriptor({ delivery: 'unavailable' }), true)
    assert.equal(isMaterialisedDescriptor({ delivery: 'nope' }), false)
    assert.equal(isMaterialisedDescriptor(imageAttachment()), false)
    assert.equal(isMaterialisedDescriptor(null), false)
    assert.equal(isMaterialisedDescriptor('file'), false)
  })

  it('is idempotent end to end: materialising twice writes once and keeps the descriptor', () => {
    const { writes, writeFile } = recordingWriter()
    const msg = { id: 'm1', content: 'look', attachments: [imageAttachment()] }
    const once = materialiseAttachments(msg, { dir: '/att', writeFile })
    const twice = materialiseAttachments(once, { dir: '/att', writeFile })
    assert.equal(writes.length, 1)
    assert.deepEqual(twice.attachments, once.attachments)
    assert.equal(twice.attachments[0].delivery, 'file')
  })
})

describe('materialiseAttachments / materialiseBatchAttachments', () => {
  it('leaves a message with no attachments identical', () => {
    const msg = { id: 'm1', content: 'just text' }
    assert.equal(materialiseAttachments(msg, { dir: '/att', writeFile: () => {} }), msg)
  })

  it('drops the attachments key entirely when nothing survives description', () => {
    const m = materialiseAttachments(
      { id: 'm1', attachments: [{ filename: 'ghost.png', mimeType: 'image/png', type: 'image' }] },
      { dir: '/att', writeFile: () => {} },
    )
    assert.equal('attachments' in m, false)
  })

  it('materialises every message in a batch', () => {
    const { writes, writeFile } = recordingWriter()
    const out = materialiseBatchAttachments(
      [
        { id: 'a', content: 'text only' },
        { id: 'b', content: 'with shot', attachments: [imageAttachment()] },
      ],
      { dir: '/att', writeFile },
    )
    assert.equal(out.length, 2)
    assert.equal(out[0].attachments, undefined)
    assert.equal(out[1].attachments[0].delivery, 'file')
    assert.equal(writes.length, 1)
  })

  it('returns an empty array for a non-array batch', () => {
    assert.deepEqual(materialiseBatchAttachments(null, { dir: '/att' }), [])
  })
})

describe('attachmentDirFor', () => {
  it('is per-connection and ends in .attachments', () => {
    const dir = attachmentDirFor('abc-123')
    assert.match(dir, /abc-123\.attachments$/)
  })
})
