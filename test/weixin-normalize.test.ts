import assert from 'node:assert/strict'
import test from 'node:test'

import { mediaItemsOf, normalizeInbound } from '../packages/adapter-weixin/src/normalize.js'

const TEXT = 1
const IMAGE = 2

function raw(overrides: Record<string, unknown> = {}) {
  return {
    message_type: 0,
    message_state: 2,
    from_user_id: 'wxid_a',
    group_id: '',
    message_id: 'm1',
    create_time_ms: 1_700_000_000_000,
    context_token: 'ctx-1',
    item_list: [{ type: TEXT, text_item: { text: '你好' } }],
    ...overrides,
  }
}

test('a 1:1 text message becomes one normalized message', () => {
  const message = normalizeInbound(raw(), 'acct')
  assert.ok(message !== null)
  assert.equal(message.channel, 'weixin')
  assert.equal(message.accountId, 'acct')
  assert.equal(message.senderId, 'wxid_a')
  assert.equal(message.conversationId, 'wxid_a', 'a blank group_id means the sender is the conversation')
  assert.equal(message.text, '你好')
  assert.equal(message.group, false)
  assert.equal(message.contextToken, 'ctx-1')
  assert.equal(message.at, 1_700_000_000_000)
})

test('a group message keeps the group as the conversation and the member as the sender', () => {
  const message = normalizeInbound(raw({ group_id: 'room-1' }), 'acct')
  assert.ok(message !== null)
  assert.equal(message.conversationId, 'room-1')
  assert.equal(message.senderId, 'wxid_a')
  assert.equal(message.group, true)
})

test('the bot\'s own echo is dropped', () => {
  // MessageType.BOT === 2; a user message is 1.
  assert.equal(normalizeInbound(raw({ message_type: 2 }), 'acct'), null)
  assert.ok(normalizeInbound(raw({ message_type: 1 }), 'acct') !== null)
})

test('an unfinished message and a missing sender are dropped', () => {
  assert.equal(normalizeInbound(raw({ message_state: 1 }), 'acct'), null)
  assert.equal(normalizeInbound(raw({ from_user_id: '' }), 'acct'), null)
})

test('a media-only message is kept: the attachment is the message', () => {
  const message = normalizeInbound(raw({ item_list: [{ type: IMAGE }] }), 'acct')
  assert.ok(message !== null)
  assert.equal(message.text, '')
  assert.equal(message.media.length, 0, 'nothing is downloaded yet at this stage')
  assert.equal(mediaItemsOf(message).length, 1, 'the item is queued for the downloader')
})

test('an empty item list is not a message', () => {
  assert.equal(normalizeInbound(raw({ item_list: [] }), 'acct'), null)
})

test('text and an attachment together keep both', () => {
  const message = normalizeInbound(raw({ item_list: [{ type: TEXT, text_item: { text: '看图' } }, { type: IMAGE }] }), 'acct')
  assert.ok(message !== null)
  assert.equal(message.text, '看图')
  assert.equal(mediaItemsOf(message).length, 1)
})

test('anything that is not an object is dropped rather than thrown', () => {
  assert.equal(normalizeInbound(null as never, 'acct'), null)
  assert.equal(normalizeInbound({} as never, 'acct'), null)
})

test('an inbound image that declares no type still gets a usable extension', async () => {
  const { extensionFor, sniffMime } = await import('../packages/adapter-weixin/src/media.js')
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)])
  assert.equal(sniffMime(jpeg), 'image/jpeg')
  assert.equal(sniffMime(png), 'image/png')
  assert.equal(sniffMime(Buffer.from('hello')), undefined)
  assert.equal(extensionFor({ kind: 'image', mime: 'image/jpeg' }), '.jpg')
  assert.equal(extensionFor({ kind: 'image' }), '.jpg', 'a nameless, typeless image is still a jpg')
  assert.equal(extensionFor({ kind: 'file', originalName: 'report.pdf' }), '.pdf')
  assert.equal(extensionFor({ kind: 'video' }), '.mp4')
})
