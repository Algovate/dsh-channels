import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { decodeFrame, encodeFrame, FrameType } from '../packages/adapter-feishu/src/proto.js'
import { FeishuSocket, type WebSocketLike } from '../packages/adapter-feishu/src/socket.js'
import { createDispatcher } from '../packages/adapter-feishu/src/polling.js'
import { normalizeInbound, type FeishuEnvelope, type NormalizedInbound } from '../packages/adapter-feishu/src/normalize.js'

const silent = { info: () => {}, warn: () => {} }
const APP_ID = 'cli_0000000000000001'

class MockWebSocket implements WebSocketLike {
  static OPEN = 1
  static instances: MockWebSocket[] = []
  readonly readyState = 1
  sent: Uint8Array[] = []
  url: string
  #listeners = new Map<string, Array<(event: { data?: unknown }) => void>>()
  constructor(url: string) { this.url = url; MockWebSocket.instances.push(this) }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const list = this.#listeners.get(type) ?? []
    list.push(listener)
    this.#listeners.set(type, list)
  }
  emit(type: string, data?: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener({ data })
  }
  open(): void { this.emit('open') }
  message(data: Uint8Array): void { this.emit('message', data) }
  closeSocket(): void { this.emit('close') }
  send(data: Uint8Array): void { this.sent.push(data) }
  close(): void {}
  terminate(): void {}
}

function eventFrame(envelope: FeishuEnvelope, messageId: string, sum = 1, seq = 0): Uint8Array {
  return encodeFrame({
    seqId: 1, logId: 1, service: 7, method: FrameType.data,
    headers: [
      { key: 'type', value: 'event' },
      { key: 'message_id', value: messageId },
      { key: 'sum', value: String(sum) },
      { key: 'seq', value: String(seq) },
      { key: 'trace_id', value: 'trace-1' },
    ],
    payload: new TextEncoder().encode(JSON.stringify(envelope)),
  })
}

function splitEventFrame(payload: string, messageId: string, seq: number, sum: number): Uint8Array {
  return encodeFrame({
    seqId: 1, logId: 1, service: 7, method: FrameType.data,
    headers: [
      { key: 'type', value: 'event' },
      { key: 'message_id', value: messageId },
      { key: 'sum', value: String(sum) },
      { key: 'seq', value: String(seq) },
      { key: 'trace_id', value: 'trace-2' },
    ],
    payload: new TextEncoder().encode(payload),
  })
}

const textEvent: FeishuEnvelope = {
  schema: '2.0',
  header: { event_id: 'evt-1', event_type: 'im.message.receive_v1', create_time: '2026-01-01T00:00:00+08:00' },
  event: {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
    message: { message_id: 'om_1', chat_id: 'oc_chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '你好' }) },
  },
}

async function flush(ms = 20): Promise<void> { await delay(ms) }

function decodeAck(bytes: Uint8Array): { code: number } {
  const frame = decodeFrame(bytes)
  return JSON.parse(new TextDecoder().decode(frame.payload)) as { code: number }
}

test('an event is delivered and its frame acknowledged with code 200', async () => {
  MockWebSocket.instances.length = 0
  const transport = { pullConnectConfig: async () => ({ URL: 'wss://gateway/ws?service_id=7', ClientConfig: { PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 0, ReconnectNonce: 0 } }), signal: new AbortController().signal }
  const received: FeishuEnvelope[] = []
  const socket = new FeishuSocket({
    transport: transport as never, logger: silent, onEvent: async (envelope) => { received.push(envelope) },
    webSocketImpl: MockWebSocket as never,
  })
  socket.start()
  await flush()
  const ws = MockWebSocket.instances[0]!
  ws.open()
  await flush()
  ws.message(eventFrame(textEvent, 'om_ws_1'))
  await flush()
  try {
    assert.equal(received.length, 1)
    assert.equal(received[0]?.header?.event_type, 'im.message.receive_v1')
    const ack = decodeAck(ws.sent[ws.sent.length - 1]!)
    assert.equal(ack.code, 200)
  } finally {
    await socket.stop()
  }
})

test('fragmented events are reassembled by seq before one ack is sent', async () => {
  MockWebSocket.instances.length = 0
  const transport = { pullConnectConfig: async () => ({ URL: 'wss://gateway/ws?service_id=7', ClientConfig: { PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 0, ReconnectNonce: 0 } }), signal: new AbortController().signal }
  const received: FeishuEnvelope[] = []
  const socket = new FeishuSocket({
    transport: transport as never, logger: silent, onEvent: async (envelope) => { received.push(envelope) },
    webSocketImpl: MockWebSocket as never,
  })
  socket.start()
  await flush()
  const ws = MockWebSocket.instances[0]!
  ws.open()
  const payload = JSON.stringify(textEvent)
  const half = Math.ceil(payload.length / 2)
  ws.message(splitEventFrame(payload.slice(0, half), 'om_frag', 0, 2))
  ws.message(splitEventFrame(payload.slice(half), 'om_frag', 1, 2))
  await flush()
  try {
    assert.equal(received.length, 1)
    assert.equal(received[0]?.event?.message?.message_id, 'om_1')
    const ack = decodeAck(ws.sent[ws.sent.length - 1]!)
    assert.equal(ack.code, 200)
  } finally {
    await socket.stop()
  }
})

test('a handler failure acks 500 so the gateway redelivers', async () => {
  MockWebSocket.instances.length = 0
  const transport = { pullConnectConfig: async () => ({ URL: 'wss://gateway/ws?service_id=7', ClientConfig: { PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 0, ReconnectNonce: 0 } }), signal: new AbortController().signal }
  const socket = new FeishuSocket({
    transport: transport as never, logger: silent, onEvent: async () => { throw new Error('durable handoff down') },
    webSocketImpl: MockWebSocket as never,
  })
  socket.start()
  await flush()
  const ws = MockWebSocket.instances[0]!
  ws.open()
  ws.message(eventFrame(textEvent, 'om_fail'))
  await flush()
  try {
    const ack = decodeAck(ws.sent[ws.sent.length - 1]!)
    assert.equal(ack.code, 500)
  } finally {
    await socket.stop()
  }
})

test('a pong refreshes the reconnect timing and a ping frame stays unacknowledged', async () => {
  MockWebSocket.instances.length = 0
  const transport = { pullConnectConfig: async () => ({ URL: 'wss://gateway/ws?service_id=7', ClientConfig: { PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 0, ReconnectNonce: 0 } }), signal: new AbortController().signal }
  const socket = new FeishuSocket({
    transport: transport as never, logger: silent, onEvent: async () => {},
    webSocketImpl: MockWebSocket as never,
  })
  socket.start()
  await flush()
  const ws = MockWebSocket.instances[0]!
  ws.open()
  const before = ws.sent.length
  ws.message(encodeFrame({ service: 7, method: FrameType.control, headers: [{ key: 'type', value: 'ping' }] }))
  ws.message(encodeFrame({
    service: 7, method: FrameType.control, headers: [{ key: 'type', value: 'pong' }],
    payload: new TextEncoder().encode(JSON.stringify({ PingInterval: 60, ReconnectCount: 3, ReconnectInterval: 1, ReconnectNonce: 0 })),
  }))
  await flush()
  try {
    // No ack frame is produced for control messages.
    assert.equal(ws.sent.length, before)
  } finally {
    await socket.stop()
  }
})

test('the dispatcher retries a DSH_INBOUND_RETRY durable handoff before settling', { timeout: 8000 }, async () => {
  let attempts = 0
  const delivered: NormalizedInbound[] = []
  const dispatcher = createDispatcher({
    accountId: 'app:cli_0000000000000001',
    priority: () => false,
    normalize: (envelope, accountId) => normalizeInbound(envelope, accountId),
    deliver: async (message) => {
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error('cannot persist'), { code: 'DSH_INBOUND_RETRY' })
      delivered.push(message)
    },
    logger: silent,
  })
  await dispatcher.onEvent(textEvent)
  assert.equal(attempts, 2)
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0]?.text, '你好')
})

test('the dispatcher keeps ordinary messages from one chat in order', async () => {
  const order: string[] = []
  const dispatcher = createDispatcher({
    accountId: 'app:cli_0000000000000001',
    priority: () => false,
    normalize: (envelope, accountId) => normalizeInbound(envelope, accountId),
    deliver: async (message) => { order.push(message.text) },
    logger: silent,
  })
  const second: FeishuEnvelope = {
    schema: '2.0',
    header: { event_id: 'evt-2', event_type: 'im.message.receive_v1', create_time: '2026-01-01T00:00:01+08:00' },
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
      message: { message_id: 'om_2', chat_id: 'oc_chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '第二' }) },
    },
  }
  await Promise.all([dispatcher.onEvent(textEvent), dispatcher.onEvent(second)])
  assert.deepEqual(order, ['你好', '第二'])
})
