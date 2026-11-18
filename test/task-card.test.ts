import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { createChannelsRuntime, createFakeAdapter } from './runtime-helper.js'
import { createHarness, inbound } from './harness.js'

const tick = (ms = 0) => delay(ms)

test('a capable adapter gets one task card edited through the turn', async () => {
  const h = createHarness({ reply: 'finished' })
  const runtime = createChannelsRuntime({ ctx: h.ctx, config: { senderPerMinute: 0, autoSendFiles: false } })
  const adapter = createFakeAdapter()
  adapter.capabilities.edit = true
  const edits: Array<{ id: string; text: string }> = []
  adapter.edit = async (_target, id, outgoing) => {
    edits.push({ id, text: outgoing.text ?? '' })
    return { ok: true, messageId: id }
  }
  runtime.register(adapter)
  try {
    runtime.dispatch(inbound())
    for (let i = 0; i < 100 && !edits.some((edit) => edit.text.includes('任务已完成')); i++) await tick(5)
    assert.ok(edits.some((edit) => edit.text.includes('执行中')), 'the receipt is edited when the turn starts')
    assert.ok(edits.some((edit) => edit.text.includes('任务已完成')), 'the same receipt is edited when the turn completes')
    assert.equal(new Set(edits.map((edit) => edit.id)).size, 1, 'all edits target the receipt message')
  } finally { await runtime.dispose() }
})

test('an adapter without edit support keeps the separate notices', async () => {
  const h = createHarness({ reply: 'finished' })
  const runtime = createChannelsRuntime({ ctx: h.ctx, config: { senderPerMinute: 0, autoSendFiles: false } })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  try {
    runtime.dispatch(inbound())
    await tick(50)
    assert.equal(adapter.sent.filter((entry) => entry.outgoing.kind === 'reply').length, 1)
  } finally { await runtime.dispose() }
})
