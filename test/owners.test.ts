import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { createChannelsRuntime, createFakeAdapter } from './runtime-helper.js'
import { createHarness, inbound } from './harness.js'

const tick = (ms = 0) => delay(ms)

function fixture() {
  const h = createHarness({ silent: true })
  const runtime = createChannelsRuntime({
    ctx: h.ctx,
    config: { allowedSenders: ['owner', 'member'], owners: ['owner'], senderPerMinute: 0, senderPerDay: 0, autoSendFiles: false },
  })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  const text = () => adapter.sent.map((entry) => entry.outgoing.text ?? '').join('\n')
  return { h, runtime, adapter, text }
}

test('a member can run tasks but not change shared routing', async () => {
  const { h, runtime, text } = fixture()
  try {
    assert.equal(runtime.canManage(inbound({ senderId: 'member' })), false)
    assert.equal(runtime.canManage(inbound({ senderId: 'owner' })), true)
    runtime.dispatch(inbound({ senderId: 'member', text: '/project default' }))
    runtime.dispatch(inbound({ senderId: 'member', text: '/new' }))
    await tick(20)
    assert.match(text(), /只有管理员可以切换项目或会话/)
    assert.equal(h.followedUp.length, 0)
    assert.equal(runtime.dispatch(inbound({ senderId: 'member', text: 'do the work' })).allow, true)
    await tick(20)
    assert.equal(h.followedUp.length, 1, 'a member still drives the agent')
  } finally { await runtime.dispose() }
})

test('a member can read status and stop their own task', async () => {
  const { runtime, adapter } = fixture()
  try {
    runtime.dispatch(inbound({ senderId: 'member', text: 'run' }))
    await tick(20)
    runtime.dispatch(inbound({ senderId: 'member', text: '/status' }))
    await tick(20)
    assert.equal(adapter.sent.some((entry) => entry.outgoing.text?.includes('当前任务')), true)
    runtime.dispatch(inbound({ senderId: 'member', text: '/cancel' }))
    await tick(20)
    assert.equal(adapter.sent.some((entry) => entry.outgoing.text?.includes('已请求停止')), true)
  } finally { await runtime.dispose() }
})

test('only an owner can manage schedules', async () => {
  const { runtime, adapter } = fixture()
  try {
    runtime.dispatch(inbound({ senderId: 'member', text: '/schedule after 5 check' }))
    await tick(20)
    assert.match(adapter.sent.at(-1)?.outgoing.text ?? '', /只有管理员可以管理计划/)
    const before = adapter.sent.length
    runtime.dispatch(inbound({ senderId: 'owner', text: '/schedules' }))
    await tick(20)
    const ownerText = adapter.sent.slice(before).map((entry) => entry.outgoing.text ?? '').join('\n')
    assert.doesNotMatch(ownerText, /只有管理员可以管理计划/)
  } finally { await runtime.dispose() }
})

test('whoami names the sender role and an empty owners list keeps everyone an owner', async () => {
  const { runtime, adapter } = fixture()
  try {
    runtime.dispatch(inbound({ senderId: 'member', text: '/whoami' }))
    await tick(20)
    assert.match(adapter.sent.at(-1)?.outgoing.text ?? '', /角色：成员/)
    const open = createChannelsRuntime({ ctx: createHarness().ctx, config: { allowedSenders: ['member'], autoSendFiles: false } })
    try { assert.equal(open.canManage(inbound({ senderId: 'member' })), true) } finally { await open.dispose() }
  } finally { await runtime.dispose() }
})
