import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeFrame, encodeFrame, FrameType } from '../packages/adapter-feishu/src/proto.js'
import { resolveMediaType, sniffMedia } from '../packages/adapter-feishu/src/media.js'
import { normalizeInbound } from '../packages/adapter-feishu/src/normalize.js'
import type { FeishuEnvelope } from '../packages/adapter-feishu/src/normalize.js'

const ACCOUNT = 'app:cli_0000000000000001'

function messageEvent(overrides: Record<string, unknown> = {}): FeishuEnvelope {
  return {
    schema: '2.0',
    header: { event_id: 'evt-1', event_type: 'im.message.receive_v1', create_time: '2026-01-01T00:00:00+08:00', app_id: 'cli_x', tenant_key: 'tk' },
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_user', union_id: 'un', user_id: 'uid' } },
      message: {
        message_id: 'om_1', chat_id: 'oc_chat', chat_type: 'p2p', message_type: 'text',
        content: JSON.stringify({ text: '你好' }), ...(overrides['message'] as object | undefined),
      },
      ...(overrides['event'] as object | undefined),
    },
    ...(overrides['header'] ? { header: { ...({ event_id: 'evt-1', event_type: 'im.message.receive_v1' }), ...(overrides['header'] as object) } } : {}),
  }
}

test('proto frames round-trip through the hand-written codec', () => {
  const bytes = encodeFrame({
    seqId: 7, logId: 9, service: 42, method: FrameType.data,
    headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'om_1' }],
    payload: new TextEncoder().encode('{"code":200}'),
  })
  const frame = decodeFrame(bytes)
  assert.equal(frame.seqId, 7)
  assert.equal(frame.logId, 9)
  assert.equal(frame.service, 42)
  assert.equal(frame.method, FrameType.data)
  assert.deepEqual(frame.headers, [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'om_1' }])
  assert.deepEqual(new TextDecoder().decode(frame.payload), '{"code":200}')
})

test('proto decoding skips unknown fields instead of failing', () => {
  // Field 15, wire type 2 (length-delimited) — a field this schema does not know.
  const unknown = new Uint8Array([(15 << 3) | 2, 3, 1, 2, 3, 8, 5])
  const frame = decodeFrame(unknown)
  assert.equal(frame.seqId, 5)
})

test('a private text event becomes one normalized message', () => {
  const message = normalizeInbound(messageEvent(), ACCOUNT)
  assert.ok(message !== null)
  assert.equal(message.channel, 'feishu')
  assert.equal(message.accountId, ACCOUNT)
  assert.equal(message.conversationId, 'oc_chat')
  assert.equal(message.senderId, 'ou_user')
  assert.equal(message.text, '你好')
  assert.equal(message.group, false)
  assert.equal(message.platformMessageId, 'om:om_1')
  assert.equal(message.media.length, 0)
})

test('a group event is marked as one', () => {
  const message = normalizeInbound(messageEvent({ message: { chat_type: 'group' } }), ACCOUNT)
  assert.equal(message?.group, true)
})

test('app senders, unknown event types and unsupported message types are refused', () => {
  assert.equal(normalizeInbound(messageEvent({ event: { sender: { sender_type: 'app' } } }), ACCOUNT), null)
  const other: FeishuEnvelope = { header: { event_type: 'im.chat.member.bot.added_v1' }, event: {} }
  assert.equal(normalizeInbound(other, ACCOUNT), null)
  assert.equal(normalizeInbound(messageEvent({ message: { message_type: 'sticker', content: '{}' } }), ACCOUNT), null)
})

test('mention placeholders are replaced with the display name', () => {
  const message = normalizeInbound(messageEvent({
    message: { content: JSON.stringify({ text: '@_user_1 看一下' }), mentions: [{ key: '@_user_1', name: 'Alice' }] },
  }), ACCOUNT)
  assert.equal(message?.text, '@Alice 看一下')
})

test('image, file, audio and video become attachment descriptors', () => {
  const image = normalizeInbound(messageEvent({
    message: { message_type: 'image', content: JSON.stringify({ image_key: 'img_k' }) },
  }), ACCOUNT)
  assert.equal(image?.text, '')
  assert.deepEqual(image?.mediaItems?.map((item) => [item.kind, item.fileKey, item.type]), [['image', 'img_k', 'image']])

  const file = normalizeInbound(messageEvent({
    message: { message_type: 'file', content: JSON.stringify({ file_key: 'f_k', file_name: '合同.pdf' }) },
  }), ACCOUNT)
  assert.deepEqual(file?.mediaItems?.[0], {
    kind: 'file', fileKey: 'f_k', messageId: 'om_1', type: 'file', fileName: '合同.pdf', mime: 'application/octet-stream',
  })

  const audio = normalizeInbound(messageEvent({
    message: { message_type: 'audio', content: JSON.stringify({ file_key: 'a_k' }) },
  }), ACCOUNT)
  assert.equal(audio?.mediaItems?.[0]?.kind, 'voice')
  // The resources endpoint only accepts `image` or `file`; audio/video use file.
  assert.equal(audio?.mediaItems?.[0]?.type, 'file')

  const video = normalizeInbound(messageEvent({
    message: { message_type: 'video', content: JSON.stringify({ file_key: 'v_k', file_name: 'clip.mp4' }) },
  }), ACCOUNT)
  assert.equal(video?.mediaItems?.[0]?.kind, 'video')
  assert.equal(video?.mediaItems?.[0]?.type, 'file')
})

test('a card button press becomes the text value it represents', () => {
  const envelope: FeishuEnvelope = {
    schema: '2.0',
    header: { event_id: 'evt-card', event_type: 'card.action.trigger' },
    event: {
      context: { open_message_id: 'om_card', open_chat_id: 'oc_chat' },
      token: 'callback-token',
      operator: { open_id: 'ou_user', name: 'Alice' },
      action: { tag: 'button', value: { value: 'a1b2c3 1' } },
    },
  }
  const message = normalizeInbound(envelope, ACCOUNT)
  assert.ok(message !== null)
  assert.equal(message.text, 'a1b2c3 1')
  assert.equal(message.conversationId, 'oc_chat')
  assert.equal(message.senderId, 'ou_user')
  assert.equal(message.platformMessageId, 'card:evt-card')
  assert.equal(message.cardCallbackToken, 'callback-token')
})

test('a malformed card action without chat or operator is refused', () => {
  const envelope: FeishuEnvelope = {
    header: { event_type: 'card.action.trigger' },
    event: { operator: { open_id: 'ou' }, action: { value: { value: 'x' } } },
  }
  assert.equal(normalizeInbound(envelope, ACCOUNT), null)
})

test('media type follows the bytes, not a misleading file name', () => {
  // A JPEG delivered as a file named .webp (seen on a real device).
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
  assert.deepEqual(sniffMedia(jpeg), { mime: 'image/jpeg', extension: '.jpg' })
  assert.deepEqual(resolveMediaType(jpeg, 'application/octet-stream', 'pic.webp', '.webp'), { mime: 'image/jpeg', extension: '.jpg' })
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  assert.equal(sniffMedia(png)?.extension, '.png')
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])
  assert.deepEqual(sniffMedia(pdf), { mime: 'application/pdf', extension: '.pdf' })
  const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
  assert.deepEqual(sniffMedia(mp4), { mime: 'video/mp4', extension: '.mp4' })
})

test('a text file keeps its own extension and becomes text/plain', () => {
  const markdown = new TextEncoder().encode('# 标题\n\n正文')
  assert.deepEqual(resolveMediaType(markdown, 'application/octet-stream', 'note.md', '.md'), { mime: 'text/plain', extension: '.md' })
  // Unknown binary keeps the declared mime.
  const blob = new Uint8Array([1, 2, 3, 4])
  assert.deepEqual(resolveMediaType(blob, undefined, 'x.bin', '.bin'), { mime: 'application/octet-stream', extension: '.bin' })
})
