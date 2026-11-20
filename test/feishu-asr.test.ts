import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { AsrBridge } from '../packages/adapter-feishu/src/asr.js'
import { createAdapter } from '../packages/adapter-feishu/src/index.js'
import { encodeFrame, FrameType } from '../packages/adapter-feishu/src/proto.js'
import type { FeishuEnvelope } from '../packages/adapter-feishu/src/normalize.js'
import type { WebSocketLike } from '../packages/adapter-feishu/src/socket.js'
import type { FetchLike } from '../packages/adapter-feishu/src/transport.js'
import type { IngressSink } from '../packages/core/src/types.js'

const silent = { info: () => {}, warn: () => {} }
const APP_ID = 'cli_0000000000000001'

function audioFile(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-asr-')), 'v.ogg')
  fs.writeFileSync(file, 'OggS....')
  return file
}

/** A fake bridge process: answers each request line with whatever `answer` says. */
function fakeSpawn(answer: (request: { wav: string }) => string | undefined) {
  const spawnImpl = (() => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = { stdin, stdout, stderr, exitCode: null as number | null, kill: () => { child.exitCode = 0 }, on: () => child, once: () => child, off: () => child }
    let buffer = ''
    stdin.on('data', (chunk: Buffer) => {
      buffer += String(chunk)
      for (const line of buffer.split('\n')) {
        if (line.trim() === '') continue
        const reply = answer(JSON.parse(line) as { wav: string })
        if (reply !== undefined) stdout.write(reply)
      }
      buffer = ''
    })
    return child
  }) as unknown as typeof import('node:child_process').spawn
  return spawnImpl
}

function bridge(spawnImpl: typeof import('node:child_process').spawn, overrides: Record<string, unknown> = {}) {
  return new AsrBridge({
    scriptPath: process.argv[1] ?? 'x',
    modelDir: '/tmp/models',
    logger: silent,
    spawnImpl,
    timeoutMs: 1000,
    ...overrides,
  })
}

test('a Feishu voice note transcribes to text', async () => {
  const asr = bridge(fakeSpawn(() => `${JSON.stringify({ ok: true, text: '明天下午三点' })}\n`))
  assert.deepEqual(await asr.transcribe(audioFile()), { ok: true, text: '明天下午三点' })
})

test('a transcription failure is a reason, never an exception', async () => {
  const asr = bridge(fakeSpawn(() => `${JSON.stringify({ ok: false, error: 'model missing' })}\n`))
  const result = await asr.transcribe(audioFile())
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /model missing/)
})

class MockWebSocket implements WebSocketLike {
  static OPEN = 1
  static instances: MockWebSocket[] = []
  readonly readyState = 1
  #listeners = new Map<string, Array<(data?: unknown) => void>>()
  constructor() { MockWebSocket.instances.push(this) }
  on(type: string, listener: (data?: unknown) => void): void {
    const list = this.#listeners.get(type) ?? []
    list.push(listener)
    this.#listeners.set(type, list)
  }
  emit(type: string, data?: unknown): void { for (const listener of this.#listeners.get(type) ?? []) listener(data) }
  open(): void { this.emit('open') }
  message(data: Uint8Array): void { this.emit('message', data) }
  send(): void {}
  close(): void {}
  terminate(): void {}
}

function audioEnvelope(): FeishuEnvelope {
  return {
    schema: '2.0',
    header: { event_id: 'evt-a', event_type: 'im.message.receive_v1', create_time: '2026-01-01T00:00:00+08:00' },
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
      message: { message_id: 'om_a', chat_id: 'oc_chat', chat_type: 'p2p', message_type: 'audio', content: JSON.stringify({ file_key: 'a_k', duration: 2230 }) },
    },
  }
}

function audioFrame(): Uint8Array {
  return encodeFrame({
    seqId: 1, logId: 1, service: 7, method: FrameType.data,
    headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'om_a' }, { key: 'sum', value: '1' }, { key: 'seq', value: '0' }],
    payload: new TextEncoder().encode(JSON.stringify(audioEnvelope())),
  })
}

function wsFetch(): FetchLike {
  return (async (url: string) => {
    if (url.endsWith('/callback/ws/endpoint')) {
      return { ok: true, status: 200, body: null, json: async () => ({
        code: 0,
        data: { URL: 'wss://gateway/ws?service_id=7', ClientConfig: { PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 0, ReconnectNonce: 0 } },
      }) }
    }
    if (url.endsWith('/tenant_access_token/internal')) {
      return { ok: true, status: 200, body: null, json: async () => ({ code: 0, tenant_access_token: 't', expire: 7200 }) }
    }
    return {
      ok: true, status: 200, json: async () => ({}),
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('OggS-audio-bytes')); controller.close() } }),
    }
  }) as FetchLike
}

test('an inbound Feishu voice note carries its transcript to the sink', { timeout: 8000 }, async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-asr-e2e-'))
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }))
  MockWebSocket.instances.length = 0
  const delivered: Array<{ transcript: string | undefined; mime: string }> = []
  const adapter = await createAdapter({
    runtime: { logger: silent, canReceive: () => true, canBypassInbound: () => false },
    stateRoot,
    config: {
      appId: APP_ID, appSecret: 's',
      fetchImpl: wsFetch(),
      webSocketImpl: MockWebSocket as never,
      asrScriptPath: process.argv[1] ?? 'x',
      asrSpawnImpl: fakeSpawn(() => `${JSON.stringify({ ok: true, text: '这是一段测试语音' })}\n`),
    },
  })
  const sink: IngressSink = { async offer(message) { delivered.push({ transcript: message.media[0]?.transcript, mime: message.media[0]?.mime ?? '' }) } }
  await adapter.startWithSink(sink)
  await delay(20)
  const ws = MockWebSocket.instances[0]!
  ws.open()
  await delay(20)
  ws.message(audioFrame())
  for (let i = 0; i < 100 && delivered.length === 0; i++) await delay(20)
  try {
    assert.deepEqual(delivered, [{ transcript: '这是一段测试语音', mime: 'audio/ogg' }])
  } finally {
    await adapter.stop()
  }
})

test('a failed transcription still delivers the audio without a transcript', { timeout: 8000 }, async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-asr-fail-'))
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }))
  MockWebSocket.instances.length = 0
  const delivered: Array<{ transcript: string | undefined; media: number }> = []
  const adapter = await createAdapter({
    runtime: { logger: silent, canReceive: () => true, canBypassInbound: () => false },
    stateRoot,
    config: {
      appId: APP_ID, appSecret: 's',
      fetchImpl: wsFetch(),
      webSocketImpl: MockWebSocket as never,
      asrScriptPath: process.argv[1] ?? 'x',
      asrSpawnImpl: fakeSpawn(() => `${JSON.stringify({ ok: false, error: 'no model' })}\n`),
    },
  })
  const sink: IngressSink = { async offer(message) { delivered.push({ transcript: message.media[0]?.transcript, media: message.media.length }) } }
  await adapter.startWithSink(sink)
  await delay(20)
  const ws = MockWebSocket.instances[0]!
  ws.open()
  await delay(20)
  ws.message(audioFrame())
  for (let i = 0; i < 100 && delivered.length === 0; i++) await delay(20)
  try {
    assert.deepEqual(delivered, [{ transcript: undefined, media: 1 }])
    assert.equal(fs.existsSync(path.join(stateRoot, 'media', 'inbound', `app_${APP_ID}`)), true)
  } finally {
    await adapter.stop()
  }
})

test('engine diagnostics on stdout do not break the protocol answer', async () => {
  // mlx-whisper prints "Detected language: …" to stdout before the JSON line.
  const asr = bridge(fakeSpawn(() => `Detected language: Chinese\n${JSON.stringify({ ok: true, text: '请把这句话重复一遍。' })}\n`))
  assert.deepEqual(await asr.transcribe(audioFile()), { ok: true, text: '请把这句话重复一遍。' })
})

test('the configured model is passed to the bridge environment', async () => {
  const envs: Array<Record<string, string | undefined>> = []
  const spawnImpl = ((command: string, args: string[], options: { env: Record<string, string | undefined> }) => {
    envs.push(options.env)
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = { stdin, stdout, stderr, exitCode: null as number | null, kill: () => { child.exitCode = 0 }, on: () => child, once: () => child, off: () => child }
    stdin.on('data', () => stdout.write(`${JSON.stringify({ ok: true, text: 'ok' })}\n`))
    void command; void args
    return child
  }) as unknown as typeof import('node:child_process').spawn
  const asr = bridge(spawnImpl, { model: 'large-v3-turbo' })
  await asr.transcribe(audioFile())
  assert.equal(envs[0]?.['DSH_FEISHU_ASR_MODEL'], 'large-v3-turbo')
})

test('the configured device and compute type reach the bridge environment', async () => {
  const envs: Array<Record<string, string | undefined>> = []
  const spawnImpl = ((_command: string, _args: string[], options: { env: Record<string, string | undefined> }) => {
    envs.push(options.env)
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = { stdin, stdout, stderr, exitCode: null as number | null, kill: () => { child.exitCode = 0 }, on: () => child, once: () => child, off: () => child }
    stdin.on('data', () => stdout.write(`${JSON.stringify({ ok: true, text: 'ok' })}\n`))
    return child
  }) as unknown as typeof import('node:child_process').spawn
  const asr = bridge(spawnImpl, { device: 'mps', computeType: 'float16' })
  await asr.transcribe(audioFile())
  assert.equal(envs[0]?.['DSH_FEISHU_ASR_DEVICE'], 'mps')
  assert.equal(envs[0]?.['DSH_FEISHU_ASR_COMPUTE_TYPE'], 'float16')
})
