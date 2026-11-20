import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { createAdapter } from '../packages/adapter-feishu/src/index.js'
import { encodeFrame, FrameType } from '../packages/adapter-feishu/src/proto.js'
import type { IngressSink } from '../packages/core/src/types.js'
import type { FeishuEnvelope } from '../packages/adapter-feishu/src/normalize.js'
import type { FetchLike } from '../packages/adapter-feishu/src/transport.js'
import { wsFetch } from './feishu-fixtures.js'
import { MockWebSocket } from './feishu-mocks.js'

const silent = { info: () => {}, warn: () => {} }
const APP_ID = 'cli_0000000000000001'


function imageEnvelope(): FeishuEnvelope {
  return {
    schema: '2.0',
    header: { event_id: 'evt-img', event_type: 'im.message.receive_v1', create_time: '2026-01-01T00:00:00+08:00' },
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
      message: { message_id: 'om_img', chat_id: 'oc_chat', chat_type: 'p2p', message_type: 'image', content: JSON.stringify({ image_key: 'img_k' }) },
    },
  }
}

function imageFrame(): Uint8Array {
  return encodeFrame({
    seqId: 1, logId: 1, service: 7, method: FrameType.data,
    headers: [
      { key: 'type', value: 'event' },
      { key: 'message_id', value: 'om_img' },
      { key: 'sum', value: '1' },
      { key: 'seq', value: '0' },
    ],
    payload: new TextEncoder().encode(JSON.stringify(imageEnvelope())),
  })
}

test('the Feishu adapter satisfies the channel contract', async () => {
  const adapter = await createAdapter({
    stateRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-contract-')),
    config: { appId: APP_ID, appSecret: 's', mediaEnabled: false, fetchImpl: wsFetch(), webSocketImpl: MockWebSocket as never },
  })
  assert.equal(adapter.id, 'feishu')
  assert.deepEqual(adapter.label, { zh: '飞书', en: 'Feishu' })
  assert.equal(adapter.capabilities.actions, true)
  assert.equal(adapter.capabilities.edit, true)
  assert.equal(adapter.capabilities.media.image, true)
  assert.equal(adapter.capabilities.maxTextChars > 0, true)
  assert.equal(typeof adapter.startWithSink, 'function')
  assert.equal(typeof adapter.stop, 'function')
  assert.equal(typeof adapter.send, 'function')
})

test('missing or malformed credentials are clear errors, not half-started adapters', async () => {
  await assert.rejects(createAdapter({ config: {} }), /no Feishu app credentials/)
  await assert.rejects(createAdapter({ config: { appId: 'not-an-app', appSecret: 's' } }), /invalid Feishu app id/)
})

test('account identity is derived from the app id and stable across secrets', async () => {
  const first = await createAdapter({ config: { appId: APP_ID, appSecret: 'a', mediaEnabled: false } })
  const rotated = await createAdapter({ config: { appId: APP_ID, appSecret: 'b', botId: '我的助手', mediaEnabled: false } })
  assert.deepEqual(await first.accounts.list(), [{ accountId: `app:${APP_ID}`, label: APP_ID, expired: false }])
  assert.deepEqual(await rotated.accounts.list(), [{ accountId: `app:${APP_ID}`, label: '我的助手', expired: false }])
})

test('a target for a different app never uses the active credential', async () => {
  const calls: string[] = []
  const adapter = await createAdapter({
    config: {
      appId: APP_ID, appSecret: 's', mediaEnabled: false,
      fetchImpl: (async (url: string) => { calls.push(url); return { ok: true, status: 200, body: null, json: async () => ({ code: 0, data: { message_id: 'om_1' } }) } }) as FetchLike,
    },
  })
  const stale = { channel: 'feishu', accountId: 'app:cli_0000000000009999', conversationId: 'oc_chat' }
  assert.equal((await adapter.send(stale, { text: 'hi', kind: 'reply' })).ok, false)
  assert.deepEqual(calls, [])
})

test('an inbound image is downloaded before the durable handoff', { timeout: 5000 }, async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-e2e-'))
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }))
  MockWebSocket.reset()
  const delivered: Array<{ media: number; text: string }> = []
  const adapter = await createAdapter({
    runtime: { logger: silent, canReceive: () => true, canBypassInbound: () => false },
    stateRoot,
    config: { appId: APP_ID, appSecret: 's', maxInboundBytes: 1024, fetchImpl: wsFetch(), webSocketImpl: MockWebSocket as never },
  })
  const sink: IngressSink = { async offer(message) { delivered.push({ media: message.media.length, text: message.text }) } }
  await adapter.startWithSink(sink)
  await delay(20)
  const ws = MockWebSocket.instances[0]!
  ws.open()
  await delay(20)
  ws.message(imageFrame())
  for (let i = 0; i < 50 && delivered.length === 0; i++) await delay(20)
  try {
    assert.deepEqual(delivered, [{ media: 1, text: '' }])
  } finally {
    await adapter.stop()
    assert.equal(ws.terminated, true)
  }
})

test('repeated start keeps the same socket; a new start after stop reconnects', { timeout: 5000 }, async () => {
  MockWebSocket.reset()
  const adapter = await createAdapter({
    config: { appId: APP_ID, appSecret: 's', mediaEnabled: false, fetchImpl: wsFetch(), webSocketImpl: MockWebSocket as never },
  })
  const noopSink: IngressSink = { async offer() {} }
  await adapter.startWithSink(noopSink)
  await adapter.startWithSink(noopSink)
  await delay(20)
  assert.equal(MockWebSocket.instances.length, 1)
  await adapter.stop()
  await adapter.startWithSink(noopSink)
  await delay(20)
  assert.equal(MockWebSocket.instances.length, 2)
  await adapter.stop()
})
