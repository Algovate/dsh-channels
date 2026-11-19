import assert from 'node:assert/strict'
import test from 'node:test'

import { helpText, parseCommand } from '../packages/core/src/commands.js'
import { sessionIdFor } from '../packages/core/src/ids.js'
import { createFakeAdapter, createChannelsRuntime } from './runtime-helper.js'
import { createHarness, inbound } from './harness.js'

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

test('a slash word is a command; anything else is a message', () => {
  assert.deepEqual(parseCommand('/status'), { name: 'status', args: '' })
  assert.deepEqual(parseCommand('  /help  '), { name: 'help', args: '' })
  assert.deepEqual(parseCommand('/new@my_bot'), { name: 'new', args: '' })
  assert.equal(parseCommand('hello /status'), null)
  assert.equal(parseCommand('/unknown'), null)
  assert.equal(parseCommand(''), null)
})

test('help lists every command once', () => {
  const text = helpText()
  assert.match(text, /^【可用命令】\n\n/)
  assert.match(text, /\n\n\/cancel.*\n\n\/clear/)
  for (const name of ['help', 'status', 'whoami', 'new']) assert.match(text, new RegExp(`/${name}`))
})

test('/whoami answers with the ids an allowlist needs, and starts no turn', async () => {
  const h = createHarness({ reply: '在' })
  const runtime = createChannelsRuntime({ ctx: h.ctx })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  runtime.dispatch(inbound({ text: '/whoami' }))
  await tick(50)
  const notice = adapter.sent.find((entry) => entry.outgoing.kind === 'notice')
  assert.ok(notice !== undefined)
  assert.match(notice.outgoing.text ?? '', /^【当前聊天】\n\n发送者 ID：sender\n\n聊天 ID：conv/)
  assert.match(notice.outgoing.text ?? '', /通道：fake/)
  assert.equal(h.created.length, 0, 'a command does not start a session')
  runtime.dispose()
})

test('/status keeps task and queue state without reading or repeating journal previews', async () => {
  const runtime = createHarness().makeRuntime()
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  try {
    const target = inbound()
    await runtime.send(target, { kind: 'reply', text: '第一行\n第二行' })
    await runtime.send(target, { kind: 'reply', text: '第一行\n第二行' })
    await runtime.send(target, { kind: 'notice', text: '已接收，准备处理。' })
    const outbound = runtime.journal.outbound.bind(runtime.journal)
    let reads = 0
    runtime.journal.outbound = (...args) => { reads++; return outbound(...args) }
    runtime.dispatch(inbound({ text: '/status' }))
    runtime.dispatch(inbound({ text: '/status' }))
    await tick(50)
    const text = adapter.sent.at(-1)?.outgoing.text ?? ''
    assert.match(text, /^【任务状态 · 测试】\n\n当前任务：无\n\n【队列】排队：0 条　｜　待重发：0 条/)
    assert.doesNotMatch(text, /最近结果|第一行|状态目录|允许的发送者|accepted|已接收/)
    assert.equal(reads, 0)
    assert.equal(outbound(undefined, target, 'reply').length, 2, 'delivery diagnostics remain available to the desktop')
    assert.equal(text.match(/【任务状态/g)?.length, 1)
  } finally { await runtime.dispose() }
})

test('/new moves the conversation to a new session line, and the old line is untouched', async () => {
  const h = createHarness({ reply: '在' })
  const runtime = createChannelsRuntime({ ctx: h.ctx })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  const first = inbound({ text: '你好' })
  runtime.dispatch(first)
  await tick(120)
  const firstSession = sessionIdFor(first)
  assert.ok(h.created.some((entry) => entry.sessionId === firstSession))

  runtime.dispatch(inbound({ text: '/new' }))
  await tick(50)
  const confirmation = adapter.sent.find((entry) => entry.outgoing.kind === 'notice' && entry.outgoing.text?.includes('开新会话'))?.outgoing.text ?? ''
  assert.match(confirmation, /开新会话/)

  runtime.dispatch(inbound({ text: '再来' }))
  await tick(120)
  const secondSession = h.created.at(-1)?.sessionId
  assert.ok(secondSession !== undefined)
  assert.notEqual(secondSession, firstSession, 'the second message went to a new session')
  assert.equal(
    sessionIdFor({ ...first, conversationId: `${first.conversationId}#1` }),
    secondSession,
    'the line is derived from the conversation, so a restart lands on the same session',
  )
  runtime.dispose()
})

test('a refused sender cannot run commands', async () => {
  const h = createHarness()
  const runtime = createChannelsRuntime({ ctx: h.ctx, config: { allowedSenders: ['someone-else'] } })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  const decision = runtime.dispatch(inbound({ text: '/status' }))
  assert.equal(decision.allow, false)
  await tick(30)
  assert.equal(adapter.sent.filter((entry) => entry.outgoing.text?.includes('尚未获准')).length, 1)
  assert.equal(adapter.sent.some((entry) => entry.outgoing.text?.includes('【可用命令】')), false)
  runtime.dispose()
})

test('retired session controls give migration guidance without starting a turn or spending quota', async () => {
  const h = createHarness()
  const runtime = createChannelsRuntime({ ctx: h.ctx, config: { senderPerMinute: 1, senderPerDay: 1, autoSendFiles: false } })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  try {
    assert.doesNotMatch(helpText(), /\/sessions?\b/)
    for (const message of [inbound({ text: '/sessions' }), inbound({ text: '/session 0' }), inbound({ text: '/session@my_bot 99' }), inbound({ text: '/ask /session@my_bot 0', group: true })]) {
      const count = adapter.sent.length
      assert.equal(runtime.dispatch(message).allow, true)
      for (let i = 0; i < 100 && adapter.sent.length === count; i++) await tick(5)
      assert.match(adapter.sent.at(-1)?.outgoing.text ?? '', /已移除.*DSH.*历史会话/)
    }
    assert.equal(h.followedUp.length, 0)
    assert.equal(runtime.dispatch(inbound({ text: '/session 0', senderId: 'stranger' })).allow, false)
    assert.equal(runtime.dispatch(inbound({ text: 'still have a turn' })).allow, true)
    for (let i = 0; i < 100 && h.followedUp.length === 0; i++) await tick(5)
    assert.equal(h.followedUp.length, 1)
  } finally { await runtime.dispose() }
})
