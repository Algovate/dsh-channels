import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import { ChannelsRuntime } from '../packages/core/src/runtime.js'
import { createChannelsRuntime, createFakeAdapter, createFakeUserMessage } from './runtime-helper.js'
import { createHarness, inbound } from './harness.js'

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (check()) return; await tick(5) }
  assert.ok(check(), 'condition did not become true')
}
function setup() {
  const h = createHarness({ silent: true })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-tasks-'))
  const runtime = createChannelsRuntime({ stateRoot: root, ctx: h.ctx, config: { senderPerMinute: 0, senderPerDay: 0, allowedSenders: ['sender', 'other'] } })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  const text = () => adapter.sent.map((entry) => entry.outgoing.text ?? '').join('\n')
  return { h, runtime, adapter, text, root }
}
function ownTurn(h: ReturnType<typeof createHarness>, index = 0) {
  const message = h.followedUp[index]!.message
  const turn = index + 1
  h.events.push({ seq: h.events.length + 1, type: 'turn/start', data: { turn } },
    { seq: h.events.length + 2, type: 'user/message', data: message as Record<string, unknown> })
  return turn
}

test('durably accepted messages are acknowledged and status shows execution and elapsed time', async () => {
  const { h, runtime, text } = setup()
  try {
    runtime.dispatch(inbound({ text: '整理报表' }))
    await until(() => h.followedUp.length === 1)
    assert.match(text(), /已接收/)
    runtime.dispatch(inbound({ text: '/status' }))
    await until(() => /当前任务：整理报表/.test(text()))
    assert.match(text(), /执行中/)
    assert.match(text(), /已用时：/)
  } finally { await runtime.dispose() }
})

test('cancel stops the captured channel task, withdraws its prompt and preserves the next task', async () => {
  const { h, runtime, text } = setup()
  try {
    runtime.dispatch(inbound({ text: 'first' }))
    await until(() => h.followedUp.length === 1)
    const turn = ownTurn(h)
    const agent = [...h.agents.values()][0]!
    Object.assign(agent, { cancel() { h.events.push({ seq: h.events.length + 1, type: 'turn/end', data: { turn, reason: { kind: 'aborted' } } }) } })
    const interaction = runtime.interactionForAgent(agent)!
    const waiting = runtime.interactions.ask({ kind: 'question', target: interaction.target, view: { title: '继续吗', options: [] }, parse: () => null, expiredNotice: '', retiredNotice: '', retireValue: '' }, { signal: interaction.signal }).catch(() => 'withdrawn')
    runtime.dispatch(inbound({ text: 'second' }))
    runtime.dispatch(inbound({ text: '/cancel' }))
    await until(() => h.followedUp.length === 2)
    assert.equal(await waiting, 'withdrawn')
    assert.equal(runtime.interactions.pendingCount(), 0)
    assert.match(text(), /已请求停止/)
    assert.match(text(), /已取消/)
    assert.match(JSON.stringify(h.followedUp[1]), /second/)
  } finally { await runtime.dispose() }
})

test('clear removes only the sender queue in a group and persists removal across restart', async () => {
  const { h, runtime, adapter, text, root } = setup()
  try {
    runtime.dispatch(inbound({ text: 'running', group: true }))
    await until(() => h.followedUp.length === 1)
    runtime.dispatch(inbound({ text: 'mine', group: true, platformMessageId: 'mine' }))
    runtime.dispatch(inbound({ text: 'theirs', group: true, senderId: 'other' }))
    runtime.dispatch(inbound({ text: '/clear', group: true }))
    await until(() => /已清除 1/.test(text()))
    assert.equal(runtime.pendingInputs(), 1)
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'inbox.json'), 'utf8')).filter((entry: { clearedAt?: number }) => entry.clearedAt === undefined)
    assert.equal(saved.length, 1)
    assert.equal(saved[0].message.text, 'theirs')
    await runtime.dispose()
    const next = new ChannelsRuntime({ ctx: h.ctx, config: runtime.config, stateRoot: root, workingDirectory: root, logger: { info() {}, warn() {} }, createUserMessage: createFakeUserMessage })
    try { assert.equal(next.pendingInputs(), 1) } finally { await next.dispose() }
    assert.ok(adapter.sent.length > 0)
  } finally { await runtime.dispose() }
})

test('another group sender cannot cancel and another chat sees no task summary', async () => {
  const { h, runtime, adapter, text, root } = setup()
  try {
    runtime.dispatch(inbound({ text: 'private task', group: true }))
    await until(() => h.followedUp.length === 1)
    runtime.dispatch(inbound({ text: '/cancel', group: true, senderId: 'other' }))
    await until(() => /发起/.test(text()))
    runtime.dispatch(inbound({ text: '/status', conversationId: 'different' }))
    await until(() => adapter.sent.some((item) => item.target.conversationId === 'different'))
    assert.doesNotMatch(adapter.sent.filter((item) => item.target.conversationId === 'different').map((item) => item.outgoing.text).join('\n'), /private task/)
    assert.equal(h.followedUp.length, 1)
  } finally { await runtime.dispose() }
})

test('restart reports started execution as unknown without replaying it', async () => {
  const { h, runtime, root } = setup()
  runtime.dispatch(inbound({ text: 'interrupted task' }))
  await until(() => h.followedUp.length === 1)
  await runtime.dispose()
  const next = new ChannelsRuntime({ ctx: h.ctx, config: runtime.config, stateRoot: root, workingDirectory: root, logger: { info() {}, warn() {} }, createUserMessage: createFakeUserMessage })
  const adapter = createFakeAdapter()
  next.register(adapter)
  try {
    next.dispatch(inbound({ text: '/status' }))
    await until(() => adapter.sent.length > 0)
    const text = adapter.sent.map((item) => item.outgoing.text).join('\n')
    assert.match(text, /interrupted task/)
    assert.match(text, /未知/)
    assert.equal(next.pendingInputs(), 0)
    assert.equal(h.followedUp.length, 1)
  } finally { await next.dispose() }
})

test('completed execution with failed delivery remains completed and pending retry', async () => {
  const h = createHarness({ reply: 'result' })
  const runtime = h.makeRuntime({ senderPerMinute: 0 })
  const adapter = createFakeAdapter()
  const send = adapter.send
  adapter.send = async (target, outgoing) => outgoing.kind === 'reply' ? { ok: false, code: 'offline' } : send(target, outgoing)
  runtime.register(adapter)
  try {
    runtime.dispatch(inbound({ text: 'make result' }))
    await until(() => runtime.outbox.list().length > 0)
    runtime.dispatch(inbound({ text: '/status' }))
    await until(() => adapter.sent.some((item) => item.outgoing.text?.includes('执行状态：完成')))
    assert.match(adapter.sent.map((item) => item.outgoing.text).join('\n'), /待重发/)
  } finally { await runtime.dispose() }
})

test('task state write failure keeps accepted work queued without executing or charging it', async () => {
  const { h, runtime, root } = setup()
  fs.mkdirSync(path.join(root, 'tasks.json'))
  try {
    runtime.dispatch(inbound({ text: 'must not disappear' }))
    await tick(30)
    assert.equal(h.followedUp.length, 0)
    assert.equal(runtime.pendingInputs(), 1)
  } finally { await runtime.dispose() }
})

test('clear write failure preserves queue and never reports successful removal', async () => {
  const { h, runtime, root, text } = setup()
  try {
    runtime.dispatch(inbound({ text: 'running' }))
    await until(() => h.followedUp.length === 1)
    runtime.dispatch(inbound({ text: 'keep this' }))
    const file = path.join(root, 'inbox.json')
    fs.renameSync(file, `${file}.saved`)
    fs.mkdirSync(file)
    runtime.dispatch(inbound({ text: '/clear' }))
    await until(() => /未能清除排队消息/.test(text()))
    assert.equal(runtime.pendingInputs(), 1)
    assert.doesNotMatch(text(), /已清除/)
  } finally { await runtime.dispose() }
})

test('a host that does not confirm cancellation is reported as unknown', async () => {
  const { h, runtime, adapter, text } = setup()
  try {
    runtime.dispatch(inbound({ text: 'uncertain task' }))
    await until(() => h.followedUp.length === 1)
    ownTurn(h)
    runtime.dispatch(inbound({ text: '/cancel' }))
    await until(() => /停止尚未得到宿主确认/.test(text()))
    runtime.dispatch(inbound({ text: '/status' }))
    await until(() => adapter.sent.some((item) => item.outgoing.text?.includes('执行状态：未知')))
    assert.doesNotMatch(text(), /当前任务已取消/)
  } finally { await runtime.dispose() }
})

test('unconfirmed platform acceptance is never shown as a delivered result', async () => {
  const h = createHarness({ reply: 'result' })
  const runtime = h.makeRuntime({ senderPerMinute: 0 })
  const adapter = createFakeAdapter()
  const send = adapter.send
  adapter.send = async (target, outgoing) => outgoing.kind === 'reply' ? { ok: true, unconfirmed: true } : send(target, outgoing)
  runtime.register(adapter)
  try {
    runtime.dispatch(inbound())
    await until(() => h.followedUp.length > 0)
    await tick(20)
    runtime.dispatch(inbound({ text: '/status' }))
    await until(() => adapter.sent.some((item) => item.outgoing.text?.includes('结果发送：未获平台确认')))
  } finally { await runtime.dispose() }
})

test('task controls remain available after the sender exhausts turn quota', async () => {
  const h = createHarness({ silent: true })
  const runtime = h.makeRuntime({ senderPerDay: 1, senderPerMinute: 0 })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  try {
    runtime.dispatch(inbound())
    await until(() => h.followedUp.length === 1)
    assert.equal(runtime.canReceive(inbound({ text: '/status' })), true)
    assert.equal(runtime.canReceive(inbound({ text: '/cancel' })), true)
    assert.equal(runtime.canReceive(inbound({ text: '/clear' })), true)
    assert.equal(runtime.dispatch(inbound({ text: '/status' })).allow, true)
    assert.equal(runtime.dispatch(inbound({ text: '/clear' })).allow, true)
    assert.equal(runtime.dispatch(inbound({ text: '/cancel' })).allow, true)
    assert.equal(runtime.dispatch(inbound({ text: 'another task' })).allow, false)
  } finally { await runtime.dispose() }
})

test('an uncertain early reply part stays uncertain after the remaining text retries successfully', async () => {
  const h = createHarness({ reply: 'x'.repeat(25) })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-retry-'))
  const runtime = createChannelsRuntime({ ctx: h.ctx, stateRoot: root, config: { senderPerMinute: 0 } })
  const adapter = createFakeAdapter({ maxTextChars: 10 })
  const send = adapter.send
  let parts = 0
  let retry = false
  adapter.send = async (target, outgoing) => {
    if (outgoing.kind !== 'reply') return send(target, outgoing)
    parts++
    if (!retry) return parts === 1 ? { ok: true, unconfirmed: true } : { ok: false, code: 'offline' }
    return { ok: true, messageId: `retry-${parts}` }
  }
  runtime.register(adapter)
  try {
    runtime.dispatch(inbound())
    await until(() => runtime.outbox.list().length > 0)
    await tick(10)
    const file = path.join(root, 'outbox.json')
    const outbox = JSON.parse(fs.readFileSync(file, 'utf8'))
    outbox.items[0].nextAt = 0
    fs.writeFileSync(file, JSON.stringify(outbox))
    retry = true
    runtime.startOutboxRetry(5)
    await until(() => runtime.outbox.list().length === 0)
    await tick(10)
    const task = JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8'))[0]
    assert.equal(task.execution, 'completed')
    assert.equal(task.delivery, 'unknown')
  } finally { await runtime.dispose() }
})

test('cleared work never executes or reappears on provider redelivery', async () => {
  const { h, runtime, text } = setup()
  try {
    runtime.dispatch(inbound({ text: 'first' }))
    await until(() => h.followedUp.length === 1)
    const turn = ownTurn(h)
    const cleared = inbound({ text: 'clear me', platformMessageId: 'cleared-message' })
    runtime.dispatch(cleared)
    runtime.dispatch(inbound({ text: '/clear' }))
    await until(() => /已清除 1/.test(text()))
    assert.equal(runtime.dispatch(cleared).allow, false)
    runtime.dispatch(inbound({ text: 'keep me' }))
    h.events.push({ seq: h.events.length + 1, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
    await until(() => h.followedUp.length === 2)
    assert.match(JSON.stringify(h.followedUp[1]), /keep me/)
    assert.doesNotMatch(JSON.stringify(h.followedUp), /clear me/)
  } finally { await runtime.dispose() }
})

test('timeout without host termination evidence is unknown rather than execution failure', async () => {
  const h = createHarness({ silent: true })
  const runtime = h.makeRuntime({ maxTurnWaitMs: 20, senderPerMinute: 0 })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  try {
    runtime.dispatch(inbound())
    await tick(70)
    runtime.dispatch(inbound({ text: '/status' }))
    await until(() => adapter.sent.some((item) => item.outgoing.text?.includes('执行状态：未知')))
    assert.equal(h.followedUp.length, 1)
  } finally { await runtime.dispose() }
})

test('cleared platform messages stay deduplicated after restart even when journal writes fail', async () => {
  const { h, runtime, root, text } = setup()
  try {
    runtime.dispatch(inbound({ text: 'running' }))
    await until(() => h.followedUp.length === 1)
    const cleared = inbound({ text: 'never replay', platformMessageId: 'durable-clear' })
    runtime.dispatch(cleared)
    const journal = path.join(root, 'journal')
    fs.renameSync(journal, `${journal}.saved`)
    fs.writeFileSync(journal, 'unwritable journal directory')
    runtime.dispatch(inbound({ text: '/clear' }))
    await until(() => /已清除 1/.test(text()))
    await runtime.dispose()
    const next = createChannelsRuntime({ ctx: h.ctx, stateRoot: root, config: runtime.config })
    next.register(createFakeAdapter())
    try {
      assert.equal(next.pendingInputs(), 0)
      assert.equal(next.dispatch(cleared).allow, false)
    } finally { await next.dispose() }
  } finally { await runtime.dispose() }
})

test('cancellation racing a completed host turn preserves the completed result', async () => {
  let runtime!: ChannelsRuntime
  const h = createHarness({ reply: 'completed result', onFollowup() {
    const agent = [...h.agents.values()][0]!
    const snapshot = agent.session.snapshotEvents
    let once = false
    agent.session.snapshotEvents = () => {
      const events = snapshot()
      if (!once && events.some((event) => event.type === 'turn/end')) {
        once = true
        queueMicrotask(() => queueMicrotask(() => runtime.dispatch(inbound({ text: '/cancel' }))))
      }
      return events
    }
  } })
  runtime = h.makeRuntime({ senderPerMinute: 0 })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  try {
    runtime.dispatch(inbound())
    await tick(60)
    assert.ok(adapter.sent.some((item) => item.outgoing.kind === 'reply' && item.outgoing.text === 'completed result'))
    assert.ok(!adapter.sent.some((item) => item.outgoing.text?.includes('当前任务已取消')))
  } finally { await runtime.dispose() }
})

test('a stalled receipt notice does not block execution or result delivery', async () => {
  const h = createHarness({ reply: 'finished despite stalled receipt' })
  const runtime = h.makeRuntime()
  const adapter = createFakeAdapter()
  const send = adapter.send
  adapter.send = async (target, outgoing) => outgoing.kind === 'notice' && outgoing.text?.includes('已接收') ? new Promise(() => {}) : send(target, outgoing)
  runtime.register(adapter)
  try {
    runtime.dispatch(inbound())
    await until(() => adapter.sent.some((item) => item.outgoing.text === 'finished despite stalled receipt'))
  } finally { await runtime.dispose() }
})

test('cancelling an input behind desktop work removes only that input and never cancels the desktop turn', async () => {
  const { h, runtime, text } = setup()
  let desktopCancellations = 0
  const removed: string[] = []
  try {
    runtime.dispatch(inbound({ text: 'queued in host' }))
    await until(() => h.followedUp.length === 1)
    const input = h.followedUp[0]!.message as { id: string }
    const agent = [...h.agents.values()][0]!
    h.events.push(
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, type: 'user/message', data: { id: 'desktop-input' } },
      { seq: 3, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [input] } },
    )
    Object.assign(agent, { cancel() { desktopCancellations++ }, inbox: { remove(id: string) { removed.push(id); return id === input.id } } })
    runtime.dispatch(inbound({ text: '/cancel' }))
    await until(() => /当前任务已取消/.test(text()))
    assert.equal(desktopCancellations, 0)
    assert.deepEqual(removed, [input.id])
  } finally { await runtime.dispose() }
})

test('a long-running task sends one progress reminder to its original chat', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let started!: () => void
  const submitted = new Promise<void>((resolve) => { started = resolve })
  const h = createHarness({ silent: true, maxTurnWaitMs: 180_000, onFollowup: started })
  const runtime = h.makeRuntime()
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  const progress = () => adapter.sent.filter((item) => item.outgoing.text?.includes('任务仍在处理'))
  try {
    runtime.dispatch(inbound({ conversationId: 'long-task-chat' }))
    await submitted
    t.mock.timers.tick(59_999)
    assert.equal(progress().length, 0)
    t.mock.timers.tick(1)
    assert.equal(progress().length, 1)
    assert.equal(progress()[0]?.target.conversationId, 'long-task-chat')
    t.mock.timers.tick(60_000)
    assert.equal(progress().length, 1)
  } finally { await runtime.dispose() }
})
