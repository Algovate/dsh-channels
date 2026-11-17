import assert from 'node:assert/strict'
import test from 'node:test'

import { mediaOf, normalizeInbound } from '../packages/adapter-telegram/src/normalize.js'
import { TelegramTransport } from '../packages/adapter-telegram/src/transport.js'

const silent = { info: () => {}, warn: () => {} }

const baseUpdate = {
  update_id: 10,
  message: {
    message_id: 5,
    date: 1_700_000_000,
    text: '你好',
    from: { id: 7, is_bot: false, username: 'alice' },
    chat: { id: 7, type: 'private', username: 'alice' },
  },
}

test('a private text message becomes one normalized message', () => {
  const message = normalizeInbound(baseUpdate as never, 'bot')
  assert.ok(message !== null)
  assert.equal(message.channel, 'telegram')
  assert.equal(message.accountId, 'bot')
  assert.equal(message.conversationId, '7')
  assert.equal(message.senderId, '7')
  assert.equal(message.text, '你好')
  assert.equal(message.group, false)
  assert.equal(message.media.length, 0)
  assert.equal(message.at, 1_700_000_000_000)
})

test('a group message is marked as one', () => {
  const message = normalizeInbound({
    message: { ...baseUpdate.message, chat: { id: -1001, type: 'supergroup', title: 'Team' } },
  } as never, 'bot')
  assert.equal(message?.group, true)
  assert.equal(message?.conversationId, '-1001')
})

test('edits, channel posts, bot messages and empty messages are refused', () => {
  assert.equal(normalizeInbound({ message: { ...baseUpdate.message, edit_date: 1 } } as never, 'bot'), null)
  assert.equal(normalizeInbound({ channel_post: baseUpdate.message } as never, 'bot'), null)
  assert.equal(normalizeInbound({ message: { ...baseUpdate.message, from: { id: 9, is_bot: true } } } as never, 'bot'), null)
  assert.equal(normalizeInbound({ message: { ...baseUpdate.message, text: undefined } } as never, 'bot'), null)
})

test('a caption carries the words of a photo message', () => {
  const message = normalizeInbound({
    message: {
      ...baseUpdate.message,
      text: undefined,
      caption: '看看这张',
      photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'big', file_size: 900 }],
    },
  } as never, 'bot')
  assert.equal(message?.text, '看看这张')
  const media = mediaOf({ ...baseUpdate.message, photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'big', file_size: 900 }] } as never)
  assert.deepEqual(media.map((item) => item.fileId), ['big'], 'only the largest size is downloaded')
})

test('documents, voice notes and videos are described with their mime', () => {
  const media = mediaOf({
    document: { file_id: 'd', file_name: '合同.pdf', mime_type: 'application/pdf', file_size: 1200 },
    voice: { file_id: 'v', mime_type: 'audio/ogg', file_size: 300 },
    video: { file_id: 'm', mime_type: 'video/mp4', file_size: 9000 },
  } as never)
  assert.deepEqual(media.map((item) => [item.kind, item.fileId, item.mime]), [
    ['file', 'd', 'application/pdf'],
    ['voice', 'v', 'audio/ogg'],
    ['video', 'm', 'video/mp4'],
  ])
})

test('one poll advances the offset so a restart does not replay', async () => {
  const calls: Array<Record<string, unknown>> = []
  const transport = new TelegramTransport({
    token: 't',
    logger: silent,
    fetchImpl: async (_url, init) => {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
      calls.push(body ?? {})
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: [{ update_id: 41, message: {} }, { update_id: 42, message: {} }] }),
      }
    },
  })
  assert.equal((await transport.pollOnce()).length, 2)
  assert.equal(calls[0]?.['offset'], undefined, 'the first poll asks for everything')
  await transport.pollOnce()
  assert.equal(calls[1]?.['offset'], 43, 'the next poll starts after the last update seen')
})

test('a failed poll throws with the server description and keeps the offset', async () => {
  const transport = new TelegramTransport({
    token: 't',
    logger: silent,
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 5 } }) }),
  })
  await assert.rejects(transport.pollOnce(), /Too Many Requests/)
})

test('sending reports the message id, and a rate limit carries a retry delay', async () => {
  const transport = new TelegramTransport({
    token: 't',
    logger: silent,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string }
      if (body.text === 'slow') {
        return { ok: true, status: 200, json: async () => ({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 99 } }) }
    },
  })
  assert.deepEqual(await transport.sendText('7', 'hi'), { ok: true, messageId: '99' })
  const refused = await transport.sendText('7', 'slow')
  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false ? refused.code : '', 'rate-limited')
  assert.equal(refused.ok === false ? refused.retryAfterMs : 0, 3000)
})

test('a thrown send is a value, not an exception', async () => {
  const transport = new TelegramTransport({
    token: 't',
    logger: silent,
    fetchImpl: async () => {
      throw new Error('network down')
    },
  })
  const result = await transport.sendText('7', 'hi')
  assert.deepEqual(result, { ok: false, code: 'send-failed', detail: 'network down' })
})
