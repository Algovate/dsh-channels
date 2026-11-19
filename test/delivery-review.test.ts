import { readSectionJson, writeSectionJson } from './state-helper.js'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { WeixinTransport } from '../packages/adapter-weixin/src/transport.js'
import { ChannelsRuntime } from '../packages/core/src/runtime.js'
import { resolveConfig } from '../packages/core/src/config.js'
import { Outbox } from '../packages/core/src/store/outbox.js'
import { inboundTextWithMedia } from '../packages/core/src/media.js'
import { createFakeAdapter } from './runtime-helper.js'
import { createHarness, inbound } from './harness.js'

const logger = { info() {}, warn() {} }
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'channels-delivery-'))

test('stopping Weixin cancels paced sends and rejects later text and media', async () => {
  process.env['OPENCLAW_STATE_DIR'] = temp()
  const sent: string[] = []
  const transport = new WeixinTransport({ accountId: 'a', baseUrl: 'https://invalid.test', token: 'test', logger, onMessage() {}, onSessionRejected() {}, sendIntervalMs: 100,
    getUpdatesImpl: async (params) => { await delay(10000, undefined, { signal: params['abortSignal'] as AbortSignal }); return {} },
    sendImpl: async () => { sent.push('text'); return {} }, sendMediaImpl: async () => { sent.push('media'); return {} },
  })
  transport.start()
  await transport.sendText('chat', 'first')
  const waiting = transport.sendText('chat', 'second')
  await delay(5)
  await transport.stop()
  assert.equal((await waiting).ok, false)
  assert.equal((await transport.sendText('chat', 'third')).ok, false)
  assert.equal((await transport.sendMedia('chat', '/tmp/a')).ok, false)
  assert.deepEqual(sent, ['text'])
})

test('a partially failed reply keeps its entire unsent tail for ordered retry', async () => {
  const root = temp()
  const runtime = new ChannelsRuntime({ ctx: {}, config: resolveConfig({ bubbleGapMs: 0 }), logger, stateRoot: root, workingDirectory: root })
  const adapter = createFakeAdapter({ maxTextChars: 3 })
  const delivered: string[] = []
  let calls = 0
  adapter.send = async (_target, outgoing) => { if (++calls === 1) return { ok: false, code: 'temporary' }; delivered.push(outgoing.text ?? ''); return { ok: true, messageId: 'sent' } }
  runtime.register(adapter)
  await runtime.send(inbound(), { kind: 'reply', text: 'ABCDEFGHI' })
  assert.deepEqual(delivered, [])
  assert.equal(runtime.outbox.list().length, 1)
  const file = path.join(root, 'outbox.json')
  const saved = JSON.parse(readSectionJson(root, 'outbox'))
  saved.items[0].nextAt = 0
  writeSectionJson(root, 'outbox', JSON.stringify(saved))
  runtime.startOutboxRetry(5)
  for (let i = 0; i < 50 && runtime.outbox.list().length > 0; i++) await delay(5)
  assert.deepEqual(delivered, ['ABC', 'DEF', 'GHI'])
  assert.equal(runtime.outbox.list().length, 0)
  await runtime.dispose()
  fs.rmSync(root, { recursive: true })
})

test('retrying a tail persists progress and does not repeat an already delivered part', async () => {
  const root = temp()
  let now = 0
  const outbox = new Outbox({ stateRoot: root, now: () => now })
  // Same persisted envelope used by runtime sends; old entries without remaining still work.
  writeSectionJson(root, 'outbox', JSON.stringify({ schemaVersion: 1, items: [{ id: 'tail', target: inbound(), outgoing: { kind: 'reply', text: 'A' }, remaining: ['B', 'C'], attempts: 0, nextAt: 0 }] }))
  const sent: string[] = []
  await outbox.drain(async (entry) => { sent.push(entry.outgoing.text ?? ''); return entry.outgoing.text === 'B' ? { ok: false, code: 'again' } : { ok: true } })
  assert.deepEqual(sent, ['A', 'B'])
  assert.equal(outbox.list()[0]?.outgoing.text, 'B')
  now = 180000
  const reopened = new Outbox({ stateRoot: root, now: () => now })
  await reopened.drain(async (entry) => { sent.push(entry.outgoing.text ?? ''); return { ok: true } })
  assert.deepEqual(sent, ['A', 'B', 'B', 'C'])
  assert.equal(reopened.list().length, 0)
  fs.rmSync(root, { recursive: true })
})

test('untranscribed audio describes its actual MIME without claiming a conversion', () => {
  for (const mime of ['audio/ogg', 'audio/mpeg', 'audio/silk', 'audio/wav']) {
    const text = inboundTextWithMedia({ text: '', media: [{ kind: 'voice', path: '/audio', mime, bytes: 12 }] })
    assert.ok(text.includes(mime))
    assert.doesNotMatch(text, /微信|已转成|请用 read 工具/)
    assert.match(text, /无法读取音频就如实说明/)
  }
})

test('a queued ordinary message survives restart, while a started turn is not replayed', async () => {
  const root = temp()
  const firstHost = createHarness({ silent: true })
  const open = (h: ReturnType<typeof createHarness>) => new ChannelsRuntime({ ctx: h.ctx, config: resolveConfig({ allowedSenders: ['sender'], autoSendFiles: false, turnPollMs: 1, maxTurnWaitMs: 200 }), logger, stateRoot: root, workingDirectory: root, createUserMessage: h.createUserMessage })
  const first = open(firstHost)
  first.register(createFakeAdapter())
  first.dispatch(inbound({ text: 'running', platformMessageId: '1' }))
  await delay(10)
  first.dispatch(inbound({ text: 'queued', platformMessageId: '2' }))
  await first.dispose()
  assert.ok(fs.existsSync(path.join(root, 'state.json')))
  const secondHost = createHarness()
  const second = open(secondHost)
  second.register(createFakeAdapter())
  // Production startup invokes this after every adapter has started.
  await second.resumePending()
  await delay(40)
  assert.equal(secondHost.followedUp.length, 1)
  const input = secondHost.followedUp[0]?.message as { content: Array<{ text: string }> }
  assert.equal(input.content.at(-1)?.text, 'queued')
  await second.dispose()
  fs.rmSync(root, { recursive: true })
})

test('Weixin does not acknowledge an input whose durable handoff failed', async () => {
  const root = temp()
  process.env['OPENCLAW_STATE_DIR'] = root
  let fail = true
  const requested: unknown[] = []
  const transport = new WeixinTransport({ accountId: 'a', baseUrl: 'https://invalid.test', token: 'test', logger, onSessionRejected() {},
    onMessage() { if (fail) throw Object.assign(new Error('disk full'), { code: 'DSH_INBOUND_RETRY' }) },
    getUpdatesImpl: async (params) => { requested.push(params['get_updates_buf']); return { ret: 0, msgs: [{ from_user_id: 'sender' }], get_updates_buf: 'next' } },
  })
  assert.equal(await transport.pollOnce(), 'retry')
  fail = false
  assert.equal(await transport.pollOnce(), 'ok')
  assert.deepEqual(requested, ['', ''])
  await transport.stop()
  fs.rmSync(root, { recursive: true })
})

test('unwritable inbox rejects handoff without charging quota or accepting the receipt', async () => {
  const root = temp()
  fs.mkdirSync(path.join(root, 'inbox.json'))
  const h = createHarness()
  const runtime = new ChannelsRuntime({ ctx: h.ctx, config: resolveConfig({ allowedSenders: ['sender'], senderPerMinute: 1 }), logger, stateRoot: root, workingDirectory: root, createUserMessage: h.createUserMessage })
  runtime.register(createFakeAdapter())
  assert.throws(() => runtime.dispatch(inbound({ platformMessageId: 'not-saved' })), (error: unknown) => (error as { code?: string }).code === 'DSH_INBOUND_RETRY')
  assert.equal(runtime.journal.received(inbound(), 'not-saved'), false)
  assert.equal(h.followedUp.length, 0)
  await runtime.dispose()
  fs.rmSync(root, { recursive: true })
})

test('pending inputs keep their original session line and wait for the original account', async () => {
  const root = temp()
  const h = createHarness()
  const open = () => new ChannelsRuntime({ ctx: h.ctx, config: resolveConfig({ allowedSenders: ['sender'], autoSendFiles: false }), logger, stateRoot: root, workingDirectory: root, createUserMessage: h.createUserMessage })
  const initial = open()
  initial.register(createFakeAdapter())
  initial.dispatch(inbound({ text: 'old line', platformMessageId: 'pending-old' }))
  initial.dispatch(inbound({ text: '/new' }))
  await initial.dispose()
  const saved = JSON.parse(readSectionJson(root, 'inbox'))
  assert.equal(saved.length, 1)
  const restored = open()
  const replacement = createFakeAdapter()
  replacement.accounts.list = async () => [{ accountId: 'replacement', expired: false }]
  const unregister = restored.register(replacement)
  await restored.resumePending()
  assert.equal(h.followedUp.length, 0)
  unregister()
  restored.register(createFakeAdapter())
  await restored.resumePending()
  await delay(30)
  assert.equal(h.created[0]?.sessionId, saved[0].sessionId)
  assert.equal(h.followedUp.length, 1)
  await restored.dispose()
  fs.rmSync(root, { recursive: true })
})

test('revoking access before restart removes a pending input without running it', async () => {
  const root = temp()
  const h = createHarness()
  const open = (allowedSenders: string[]) => new ChannelsRuntime({ ctx: h.ctx, config: resolveConfig({ allowedSenders }), logger, stateRoot: root, workingDirectory: root, createUserMessage: h.createUserMessage })
  const first = open(['sender'])
  first.register(createFakeAdapter())
  first.dispatch(inbound({ platformMessageId: 'revoked' }))
  await first.dispose()
  const reopened = open([])
  reopened.register(createFakeAdapter())
  await reopened.resumePending()
  assert.equal(h.followedUp.length, 0)
  assert.deepEqual(JSON.parse(readSectionJson(root, 'inbox')), [])
  await reopened.dispose()
  fs.rmSync(root, { recursive: true })
})

test('a backed-off reply blocks only later replies to its own chat', async () => {
  const root = temp()
  const outbox = new Outbox({ stateRoot: root, now: () => 90000 })
  const first = outbox.enqueue(inbound(), ['old'])!
  await outbox.sendPending(first, async () => ({ ok: false, code: 'rate-limited', retryAfterMs: 90000 }))
  outbox.enqueue(inbound(), ['later'])
  outbox.enqueue(inbound({ conversationId: 'other' }), ['independent'])
  const sent: string[] = []
  await outbox.drain(async (entry) => { sent.push(entry.outgoing.text ?? ''); return { ok: true } })
  assert.deepEqual(sent, ['independent'])
  fs.rmSync(root, { recursive: true })
})

test('the real Weixin send API observes an external abort through its response body', async () => {
  const { sendMessageItemWeixin } = await import('../packages/adapter-weixin/vendor/openclaw-weixin/messaging/send.js')
  const previous = globalThis.fetch
  const abort = new AbortController()
  let canceled = false
  let ready!: () => void
  const started = new Promise<void>((resolve) => { ready = resolve })
  globalThis.fetch = (async (_url, init) => {
    const signal = init?.signal
    assert.ok(signal)
    return new Response(new ReadableStream({
      start(controller) { signal.addEventListener('abort', () => { canceled = true; controller.error(signal.reason) }, { once: true }); ready() },
    }))
  }) as typeof fetch
  try {
    const sending = sendMessageItemWeixin({ to: 'chat', item: { type: 1, text_item: { text: 'hi' } }, opts: { baseUrl: 'https://invalid.test', token: 'fake', signal: abort.signal } })
    await started
    abort.abort(new Error('stop sending'))
    await assert.rejects(sending, { name: 'AbortError' })
    assert.equal(canceled, true)
  } finally { globalThis.fetch = previous }
})

test('recovery restores adapter routing context and keeps attachment paths', async () => {
  const root = temp()
  const h = createHarness()
  const open = () => new ChannelsRuntime({ ctx: h.ctx, config: resolveConfig({ allowedSenders: ['sender'], autoSendFiles: false }), logger, stateRoot: root, workingDirectory: root, createUserMessage: h.createUserMessage })
  const first = open()
  first.register(createFakeAdapter())
  first.dispatch(inbound({ platformMessageId: 'voice', raw: { contextToken: 'private-context' }, media: [{ kind: 'voice', path: '/saved/audio.ogg', mime: 'audio/ogg', bytes: 100 }] }))
  await first.dispose()
  const reopened = open()
  const adapter = createFakeAdapter()
  let restored = 0
  adapter.restoreInbound = (message) => { restored++; assert.deepEqual(message.raw, { contextToken: 'private-context' }); assert.equal(message.media[0]?.path, '/saved/audio.ogg') }
  reopened.register(adapter)
  await reopened.resumePending()
  await delay(30)
  assert.ok(restored >= 1)
  assert.equal(h.followedUp.length, 1)
  await reopened.dispose()
  fs.rmSync(root, { recursive: true })
})

test('malformed outbox records refuse live replies without sending or overwriting state', async () => {
  const root = temp()
  const runtime = new ChannelsRuntime({ ctx: {}, config: resolveConfig({}), logger, stateRoot: root, workingDirectory: root })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  for (const saved of [null, { items: [null, { target: {} }] }]) {
    writeSectionJson(root, 'outbox', JSON.stringify(saved))
    assert.deepEqual(await runtime.send(inbound(), { kind: 'reply', text: 'live' }), [{ ok: false, code: 'outbox-persist' }])
    assert.equal(adapter.sent.length, 0)
    assert.equal(readSectionJson(root, 'outbox'), JSON.stringify(saved))
  }
  await runtime.dispose()
  fs.rmSync(root, { recursive: true })
})
