#!/usr/bin/env node
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fitRoomMessage, ROOM_MESSAGE_MAX_CHARS } from './room-message.mjs'

describe('a message posted into a room on a person\'s behalf (item 9a4c0d6a)', () => {
  it('goes whole whenever the room accepts it, however long', () => {
    // The old cut was 12,000 characters, a number the server never had.
    const long = 'x'.repeat(ROOM_MESSAGE_MAX_CHARS)
    assert.equal(fitRoomMessage(long), long)
    assert.equal(fitRoomMessage('a prompt'), 'a prompt')
  })

  it('past the room\'s own limit, says how much is missing instead of passing as whole', () => {
    const text = 'y'.repeat(ROOM_MESSAGE_MAX_CHARS + 2_345)
    const fitted = fitRoomMessage(text)
    assert.ok(fitted.length <= ROOM_MESSAGE_MAX_CHARS, 'fits, so the server accepts it')
    assert.ok(fitted.length > ROOM_MESSAGE_MAX_CHARS - 200, 'and keeps all but the room for the note')
    const omitted = Number(/\[([\d,]+) more characters are not shown/.exec(fitted)[1].replace(/,/g, ''))
    const kept = fitted.indexOf('\n\n[')
    assert.equal(kept + omitted, text.length, 'what is kept plus what the note counts is the whole message')
  })

  it('never splits a character in two', () => {
    const emoji = '😀'
    const text = emoji.repeat(ROOM_MESSAGE_MAX_CHARS)
    const fitted = fitRoomMessage(text)
    assert.ok(fitted.length <= ROOM_MESSAGE_MAX_CHARS)
    assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])/.test(fitted), false, 'no lone high surrogate')
  })
})
