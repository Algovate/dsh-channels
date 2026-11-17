import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeInbound } from '../packages/adapter-weixin/src/normalize.js'

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

test('a media-only message is dropped in 0.1.0, with no crash', () => {
  const message = normalizeInbound(raw({ item_list: [{ type: IMAGE }] }), 'acct')
  assert.equal(message, null)
})

test('text and an attachment together keep the text and count the attachment', () => {
  const message = normalizeInbound(raw({ item_list: [{ type: TEXT, text_item: { text: '看图' } }, { type: IMAGE }] }), 'acct')
  assert.ok(message !== null)
  assert.equal(message.text, '看图')
  assert.deepEqual(message.raw, { unsupportedItems: 1 })
})

test('anything that is not an object is dropped rather than thrown', () => {
  assert.equal(normalizeInbound(null as never, 'acct'), null)
  assert.equal(normalizeInbound({} as never, 'acct'), null)
})
