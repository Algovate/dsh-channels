import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { createChannelsRuntime, createFakeAdapter } from './runtime-helper.js'
import { createHarness, inbound } from './harness.js'

const tick = (ms = 0) => delay(ms)

function fixture() {
  const h = createHarness({ reply: 'ok' })
  const runtime = createChannelsRuntime({
    ctx: h.ctx,
    config: { allowedSenders: ['sender'], groupTrigger: 'prefix', groupPrefix: '/ask', senderPerMinute: 0, senderPerDay: 0, autoSendFiles: false },
  })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  const text = () => adapter.sent.map((entry) => entry.outgoing.text ?? '').join('\n')
  return { h, runtime, adapter, text }
}

test('a group message without the prefix is ignored before admission', async () => {
  const { h, runtime, adapter } = fixture()
  try {
    assert.equal(runtime.canReceive(inbound({ group: true, text: 'just chatting' })), false)
    assert.deepEqual(runtime.dispatch(inbound({ group: true, text: 'just chatting' })), { allow: false, reason: 'not-addressed' })
    await tick(20)
    assert.equal(h.followedUp.length, 0)
    assert.equal(adapter.sent.length, 0)
  } finally { await runtime.dispose() }
})

test('the prefix is stripped and the rest becomes the turn', async () => {
  const { h, runtime } = fixture()
  try {
    assert.equal(runtime.dispatch(inbound({ group: true, text: '/ask summarize this' })).allow, true)
    await tick(20)
    assert.equal((h.followedUp[0]?.message as { content: Array<{ text: string }> }).content[0]?.text, 'summarize this')
  } finally { await runtime.dispose() }
})

test('a prefixed command is still a command, and unprefixed controls are ignored', async () => {
  const { h, runtime, text } = fixture()
  try {
    assert.equal(runtime.canBypassInbound(inbound({ group: true, text: '/ask /cancel' })), true)
    assert.equal(runtime.canBypassInbound(inbound({ group: true, text: '/cancel' })), false)
    runtime.dispatch(inbound({ group: true, text: '/status' }))
    await tick(20)
    assert.equal(h.followedUp.length, 0)
    runtime.dispatch(inbound({ group: true, text: '/ask /status' }))
    await tick(20)
    assert.match(text(), /当前任务|暂无/)
  } finally { await runtime.dispose() }
})

test('an active interaction can be answered without repeating the group prefix', async () => {
  const { h, runtime, adapter } = fixture()
  try {
    const target = inbound({ group: true })
    const pending = runtime.interactions.ask({
      kind: 'question', target, view: { title: '继续吗', options: [] }, parse: (text) => text === 'yes' ? { ok: true, value: 'yes' } : null,
      expiredNotice: '', retiredNotice: '', retireValue: '',
    })
    await tick(10)
    runtime.dispatch(inbound({ group: true, text: 'yes' }))
    assert.equal(await pending, 'yes')
    assert.equal(h.followedUp.length, 0)
    assert.ok(adapter.sent.some((entry) => entry.outgoing.kind === 'question'))
  } finally { await runtime.dispose() }
})

test('mention mode accepts the configured bot handle and still accepts the prefix', async () => {
  const h = createHarness({ reply: 'ok' })
  const runtime = createChannelsRuntime({
    ctx: h.ctx,
    config: { allowedSenders: ['sender'], groupTrigger: 'mention', groupMention: '@helper', senderPerMinute: 0, senderPerDay: 0, autoSendFiles: false },
  })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  try {
    assert.equal(runtime.dispatch(inbound({ text: 'plain chatter', group: true })).allow, false)
    runtime.dispatch(inbound({ text: '@helper 查一下', group: true }))
    assert.equal(runtime.dispatch(inbound({ text: '/ask 再看一下', group: true })).allow, true)
    await tick(50)
    assert.equal(h.followedUp.length, 2)
  } finally { await runtime.dispose() }
})

test('a prefixed control command still bypasses an exhausted quota', async () => {
  const h = createHarness({ reply: 'late' })
  const runtime = createChannelsRuntime({
    ctx: h.ctx,
    config: { allowedSenders: ['sender'], groupTrigger: 'prefix', groupPrefix: '/ask', senderPerMinute: 0, senderPerDay: 1, autoSendFiles: false },
  })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  try {
    runtime.dispatch(inbound({ text: '/ask 做点事', group: true }))
    await tick(20)
    assert.equal(runtime.canReceive(inbound({ text: '/ask /cancel', group: true }), false), true)
  } finally { await runtime.dispose() }
})
