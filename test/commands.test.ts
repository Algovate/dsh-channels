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
  assert.match(notice.outgoing.text ?? '', /发送者 id：sender/)
  assert.match(notice.outgoing.text ?? '', /通道：fake/)
  assert.equal(h.created.length, 0, 'a command does not start a session')
  runtime.dispose()
})

test('/status reports the live health of the channel', async () => {
  const h = createHarness({ reply: '在' })
  const runtime = createChannelsRuntime({ ctx: h.ctx, config: { allowedSenders: ['sender'] } })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  runtime.dispatch(inbound({ text: '/status' }))
  await tick(50)
  const text = adapter.sent.find((entry) => entry.outgoing.kind === 'notice')?.outgoing.text ?? ''
  assert.match(text, /通道：fake/)
  assert.match(text, /允许的发送者：1/)
  assert.match(text, /待重发：0/)
  runtime.dispose()
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
  const confirmation = adapter.sent.find((entry) => entry.outgoing.kind === 'notice')?.outgoing.text ?? ''
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
  assert.equal(adapter.sent.length, 0)
  runtime.dispose()
})
