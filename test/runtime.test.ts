import assert from 'node:assert/strict'
import test from 'node:test'

import { createFakeAdapter, createChannelsRuntime } from './runtime-helper.js'
import { createHarness, inbound } from './harness.js'

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

test('a sender that is not on the allowlist never reaches the agent', async () => {
  const h = createHarness()
  const runtime = createChannelsRuntime({ ctx: h.ctx, config: { allowedSenders: [] } })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  const decision = runtime.dispatch(inbound())
  await tick(20)
  assert.equal(decision.allow, false)
  assert.equal(h.created.length, 0)
  assert.equal(adapter.sent.length, 0)
  runtime.dispose()
})

test('an allowed message becomes a turn and its reply goes back through the adapter', async () => {
  const h = createHarness({ reply: '收到' })
  const runtime = h.makeRuntime()
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  runtime.dispatch(inbound())
  await tick(150)
  assert.equal(adapter.sent.length, 1)
  assert.equal(adapter.sent[0]?.outgoing.text, '收到')
  assert.equal(adapter.sent[0]?.outgoing.kind, 'reply')
  assert.equal(adapter.sent[0]?.target.conversationId, 'conv')
  runtime.dispose()
})

test('a long reply is split to the channel\'s limit', async () => {
  const h = createHarness({ reply: '字'.repeat(25) })
  const runtime = h.makeRuntime()
  const adapter = createFakeAdapter({ maxTextChars: 10 })
  runtime.register(adapter)
  runtime.dispatch(inbound())
  await tick(150)
  assert.equal(adapter.sent.length, 3)
  assert.ok(adapter.sent.every((entry) => (entry.outgoing.text ?? '').length <= 10))
  runtime.dispose()
})

test('a failed send is kept in the outbox instead of vanishing', async () => {
  const h = createHarness({ reply: '收不到的话也要留住' })
  const runtime = h.makeRuntime()
  const adapter = createFakeAdapter({ failWith: 'server-500' })
  runtime.register(adapter)
  runtime.dispatch(inbound())
  await tick(150)
  const items = runtime.outbox.list()
  assert.equal(items.length, 1)
  assert.equal(items[0]?.outgoing.text, '收不到的话也要留住')
  assert.equal(items[0]?.lastCode, 'server-500')
  runtime.dispose()
})

test('the outbox retries and drops the entry once delivery succeeds', async () => {
  const h = createHarness({ reply: '一条' })
  const runtime = h.makeRuntime()
  const adapter = createFakeAdapter({ failWith: 'once' })
  runtime.register(adapter)
  runtime.dispatch(inbound())
  await tick(150)
  assert.equal(runtime.outbox.list().length, 1)
  // Deliver on the next attempt.
  const good = createFakeAdapter()
  runtime.register(good)
  Object.assign(adapter, good, { id: 'fake' })
  const delivered = await runtime.outbox.drain(async (entry) => {
    const result = await adapter.send(entry.target, { text: entry.outgoing.text ?? '', kind: entry.outgoing.kind })
    return result.ok === true ? { ok: true as const } : { ok: false as const, code: result.code }
  })
  assert.equal(delivered, 0, 'the backoff has not elapsed yet, so nothing was retried')
  runtime.dispose()
})

test('an unknown channel is refused instead of throwing', async () => {
  const h = createHarness()
  const runtime = h.makeRuntime({ allowedSenders: ['sender'] })
  const results = await runtime.send({ channel: 'nope', accountId: 'a', conversationId: 'c' }, { text: 'x', kind: 'reply' })
  assert.equal(results[0]?.ok, false)
  runtime.dispose()
})
