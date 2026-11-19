import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { createFakeAdapter } from './runtime-helper.js'
import { createHarness, inbound } from './harness.js'

test('the ingress sink accepts a message and the turn reaches the host', async () => {
  const h = createHarness({ reply: 'accepted' })
  const runtime = h.makeRuntime({ senderPerMinute: 0 })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  try {
    await runtime.ingress().offer(inbound({ text: 'through the sink' }))
    for (let i = 0; i < 50 && h.followedUp.length === 0; i++) await delay(5)
    assert.equal((h.followedUp[0]?.message as { content: Array<{ text: string }> }).content.at(-1)?.text, 'through the sink')
  } finally { await runtime.dispose() }
})

test('ordinary sink offers preserve their per-chat order', async () => {
  const h = createHarness({ reply: 'ok' })
  const runtime = h.makeRuntime({ senderPerMinute: 0 })
  runtime.register(createFakeAdapter())
  try {
    const sink = runtime.ingress()
    await Promise.all([sink.offer(inbound({ text: 'first' })), sink.offer(inbound({ text: 'second' }))])
    for (let i = 0; i < 50 && h.followedUp.length < 2; i++) await delay(5)
    const texts = h.followedUp.map((entry) => (entry.message as { content: Array<{ text: string }> }).content.at(-1)?.text)
    assert.deepEqual(texts, ['first', 'second'])
  } finally { await runtime.dispose() }
})

test('a priority offer can pass a blocked ordinary chain', async () => {
  const h = createHarness({ reply: 'ok' })
  const runtime = h.makeRuntime({ senderPerMinute: 0 })
  runtime.register(createFakeAdapter())
  try {
    const sink = runtime.ingress()
    // The ordinary offer is intentionally not awaited: the next priority offer
    // must not depend on it having reached the host first.
    void sink.offer(inbound({ text: 'ordinary' }))
    await sink.offer(inbound({ text: '/status' }), { priority: true })
    for (let i = 0; i < 50 && h.followedUp.length < 1; i++) await delay(5)
    assert.equal(h.followedUp[0]?.message !== undefined, true)
  } finally { await runtime.dispose() }
})
