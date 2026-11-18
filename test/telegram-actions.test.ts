import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { normalizeInbound } from '../packages/adapter-telegram/src/normalize.js'
import { TelegramTransport } from '../packages/adapter-telegram/src/transport.js'
import { approvalEntry } from '../packages/core/src/interaction/approval.js'
import { createChannelsRuntime, createFakeAdapter } from './runtime-helper.js'
import { createHarness, inbound } from './harness.js'

const silent = { info: () => {}, warn: () => {} }
const tick = (ms = 0) => delay(ms)

test('a Telegram callback button becomes the text reply it represents', () => {
  const message = normalizeInbound({
    update_id: 1,
    callback_query: {
      id: 'cb-1',
      data: 'a1b2c3 1',
      from: { id: 7, is_bot: false },
      message: { message_id: 5, chat: { id: 7, type: 'private' } },
    },
  } as never, 'bot')
  assert.equal(message?.text, 'a1b2c3 1')
  assert.equal(message?.senderId, '7')
  assert.equal(message?.callbackQueryId, 'cb-1')
  assert.equal(message?.platformMessageId, 'callback:cb-1')
})

test('Telegram text sends inline buttons as callback data', async () => {
  let body: Record<string, unknown> | undefined
  const transport = new TelegramTransport({
    token: '1:secret',
    logger: silent,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 9 } }) }
    },
  })
  const result = await transport.sendText('7', '需要批准', [{ label: '允许一次', value: 'a1b2c3 1' }])
  assert.deepEqual(result, { ok: true, messageId: '9' })
  assert.deepEqual(body?.['reply_markup'], { inline_keyboard: [[{ text: '允许一次', callback_data: 'a1b2c3 1' }]] })
})

test('Telegram edits a task card in place', async () => {
  let body: Record<string, unknown> | undefined
  const transport = new TelegramTransport({
    token: '1:secret',
    logger: silent,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 12 } }) }
    },
  })
  assert.deepEqual(await transport.editMessageText('7', '12', '已完成'), { ok: true, messageId: '12' })
  assert.equal(body?.['message_id'], 12)
  assert.equal(body?.['text'], '已完成')
})

test('an approval carries native actions only when the adapter advertises them', async () => {
  const h = createHarness({ silent: true })
  const runtime = createChannelsRuntime({ ctx: h.ctx, config: { senderPerMinute: 0, autoSendFiles: false } })
  const adapter = createFakeAdapter()
  adapter.capabilities.actions = true
  runtime.register(adapter)
  const target = inbound()
  try {
    const pending = runtime.interactions.ask(approvalEntry({ target, request: { toolName: 'bash' } }))
    await tick(10)
    const prompt = adapter.sent.find((entry) => entry.outgoing.kind === 'question')
    assert.ok(prompt)
    assert.equal(prompt.outgoing.actions?.length, 3)
    assert.match(prompt.outgoing.actions?.[0]?.value ?? '', / [123]$/)
    const code = prompt.outgoing.actions?.[0]?.value?.split(' ')[0]
    assert.ok(code)
    runtime.dispatch(inbound({ text: `${code} 1` }))
    assert.equal(await pending, 'allowed-once')
    runtime.dispose()
  } finally { await runtime.dispose() }
})

test('a text-only adapter receives no actions', async () => {
  const h = createHarness({ silent: true })
  const runtime = createChannelsRuntime({ ctx: h.ctx, config: { senderPerMinute: 0, autoSendFiles: false } })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  try {
    const pending = runtime.interactions.ask(approvalEntry({ target: inbound(), request: { toolName: 'bash' } }))
    await tick(10)
    assert.equal(adapter.sent.find((entry) => entry.outgoing.kind === 'question')?.outgoing.actions, undefined)
    runtime.interactions.dispose()
    await pending.catch(() => {})
  } finally { await runtime.dispose() }
})
