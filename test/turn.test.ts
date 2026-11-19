import assert from 'node:assert/strict'
import test from 'node:test'

import { assistantTextOf, TurnDriver } from '../packages/core/src/turns.js'
import { sessionIdFor } from '../packages/core/src/ids.js'
import { createHarness, inbound } from './harness.js'

test('assistantTextOf reads joined text blocks and ignores other events', () => {
  assert.equal(assistantTextOf({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } } }), 'a\nb')
  assert.equal(assistantTextOf({ type: 'turn/end', data: {} }), undefined)
  assert.equal(assistantTextOf({ type: 'assistant/message', data: {} }), undefined)
})

test('a conversation resumes its own session instead of creating a second one', async () => {
  const h = createHarness({ reply: '在' })
  const runtime = h.makeRuntime()
  const adapter = (await import('./runtime-helper.js')).createFakeAdapter()
  runtime.register(adapter)
  runtime.dispatch(inbound())
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(h.created.length, 1, 'one session was created')
  const replies = adapter.sent.filter((entry) => entry.outgoing.kind === 'reply')
  assert.equal(replies.length, 1)
  assert.equal(replies[0]?.outgoing.text, '在')
  runtime.dispose()
})

test('a reply arrives from the session event feed, not from polling the log', async () => {
  const h = createHarness({ reply: '在' })
  const driver = new TurnDriver({ ctx: h.ctx, logger: { info: () => {}, warn: () => {} }, workingDirectory: '/tmp', createUserMessage: h.createUserMessage })
  const reply = await driver.run({ message: inbound() })
  assert.equal(reply.text, '在')
  assert.equal(h.snapshotReads(), 0, 'the event feed must satisfy the wait without snapshotEvents()')
  await driver.dispose()
})

test('a second message reuses the attached session', async () => {
  const h = createHarness({ reply: '在' })
  const runtime = h.makeRuntime()
  const { createFakeAdapter } = await import('./runtime-helper.js')
  runtime.register(createFakeAdapter())
  runtime.dispatch(inbound())
  await new Promise((resolve) => setTimeout(resolve, 200))
  runtime.dispatch(inbound({ text: '第二条' }))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(h.created.length, 1, 'still one session')
  assert.equal(h.followedUp.length, 2)
  runtime.dispose()
})

test('the person\'s message stays their own words and carries the channel as its source', async () => {
  const h = createHarness({ reply: '在' })
  const driver = new TurnDriver({ ctx: h.ctx, logger: { info: () => {}, warn: () => {} }, workingDirectory: '/tmp', pollMs: 5, createUserMessage: h.createUserMessage })
  await driver.run({ message: inbound({ channel: 'weixin', text: '只有这句话' }) })
  const message = h.followedUp[0]?.message as { content: Array<{ text: string }>; source: Record<string, unknown> }
  assert.equal(message.content[0]?.text, '只有这句话')
  assert.equal(message.source['kind'], 'weixin')
  assert.equal(message.source['form'], 'message')
  assert.equal(message.source['group'], false)
})

test('per-turn context is injected as one sourced snapshot before the message', async () => {
  const h = createHarness({ reply: '在' })
  const driver = new TurnDriver({ ctx: h.ctx, logger: { info: () => {}, warn: () => {} }, workingDirectory: '/tmp', pollMs: 5, createUserMessage: h.createUserMessage })
  await driver.run({ message: inbound(), context: [{ name: 'channels:memory', text: 'MEMORY' }, { name: 'channels:life', text: 'LIFE' }] })
  const injected = h.injected[0] as { content: Array<{ text: string }>; source: Record<string, unknown> }
  assert.equal(injected.content[0]?.text, 'MEMORY\n\nLIFE')
  assert.equal(injected.source['kind'], 'channels-context')
  assert.deepEqual((injected.source['sections'] as Array<{ name: string }>).map((section) => section.name), ['channels:memory', 'channels:life'])
  // The followup after it is only the person's words.
  const followed = h.followedUp[0]?.message as { content: Array<{ text: string }> }
  assert.equal(followed.content[0]?.text, '你好')
})

test('the persona goes to the system prompt, not to the message', async () => {
  const h = createHarness({ reply: '在' })
  const driver = new TurnDriver({ ctx: h.ctx, logger: { info: () => {}, warn: () => {} }, workingDirectory: '/tmp', pollMs: 5, createUserMessage: h.createUserMessage })
  await driver.run({ message: inbound(), system: 'PERSONA' })
  assert.deepEqual(h.sections[0], { name: 'channels:persona', order: 60, text: 'PERSONA', interpolate: false })
})

test('a persisted session is resumed on a cold start, not recreated', async () => {
  const target = { channel: 'fake', accountId: 'acct', conversationId: 'conv' }
  const h = createHarness({ reply: '在', existing: [sessionIdFor(target)] })
  const driver = new TurnDriver({ ctx: h.ctx, logger: { info: () => {}, warn: () => {} }, workingDirectory: '/tmp', pollMs: 5, createUserMessage: h.createUserMessage })
  const attached = await driver.attach(target)
  assert.equal(h.created.length, 0, 'a session that exists on disk must be resumed')
  assert.equal(attached.sessionId, attached.handle.agent.session?.id)
})

test('a session the GUI is already running is adopted', async () => {
  const target = { channel: 'fake', accountId: 'acct', conversationId: 'conv' }
  const h = createHarness({ reply: '在' })
  h.agents.set(sessionIdFor(target), {
    session: { id: sessionIdFor(target), snapshotEvents: () => h.events },
    inbox: { clear: () => {} },
    inject: () => {},
    followup: () => {},
  })
  const driver = new TurnDriver({ ctx: h.ctx, logger: { info: () => {}, warn: () => {} }, workingDirectory: '/tmp', pollMs: 5, createUserMessage: h.createUserMessage })
  const attached = await driver.attach(target)
  assert.equal(h.created.length, 0)
  assert.equal(attached.sessionId, sessionIdFor(target))
})

test('a turn that never settles reports a timeout instead of hanging', async () => {
  const h = createHarness({ silent: true })
  const driver = new TurnDriver({ ctx: h.ctx, logger: { info: () => {}, warn: () => {} }, workingDirectory: '/tmp', pollMs: 5, maxTurnWaitMs: 30, createUserMessage: h.createUserMessage })
  const reply = await driver.run({ message: inbound() })
  assert.equal(reply.failed, true)
  assert.match(reply.text, /超时/)
})

test('only the final answer from the submitted turn is returned after it completes', async () => {
  const h = createHarness({ silent: true })
  const driver = new TurnDriver({ ctx: h.ctx, logger: { info: () => {}, warn: () => {} }, workingDirectory: '/tmp', pollMs: 1, maxTurnWaitMs: 1000, createUserMessage: h.createUserMessage })
  const append = (type: string, data: Record<string, unknown>) => h.events.push({ seq: h.events.length + 1, type, data })
  const assistant = (turn: number, text: string) => append('assistant/message', { turn, message: { content: [{ type: 'text', text }] } })
  append('turn/start', { turn: 1 })
  let settled = false
  const pending = driver.run({ message: inbound() }).then((result) => {
    settled = true
    return result
  })
  await new Promise((resolve) => setImmediate(resolve))
  assistant(1, 'desktop answer')
  append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  append('turn/start', { turn: 2 })
  append('user/message', h.followedUp[0]?.message as Record<string, unknown>)
  assistant(2, 'I will check')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(settled, false)
  assistant(2, 'Final answer')
  append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.equal((await pending).text, 'Final answer')
})

test('a completed turn without final text returns an empty reply', async () => {
  const h = createHarness({ silent: true })
  const driver = new TurnDriver({ ctx: h.ctx, logger: { info: () => {}, warn: () => {} }, workingDirectory: '/tmp', pollMs: 1, maxTurnWaitMs: 150, createUserMessage: h.createUserMessage })
  const pending = driver.run({ message: inbound() })
  await new Promise((resolve) => setImmediate(resolve))
  h.events.push(
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: h.followedUp[0]?.message as Record<string, unknown> },
    { seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'not an answer' }] } } },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  const reply = await pending
  assert.equal(reply.text, '')
  assert.equal(reply.failed, undefined)
})

test('a failure after an interim assistant message takes precedence over its text', async () => {
  const h = createHarness({ silent: true })
  const driver = new TurnDriver({ ctx: h.ctx, logger: { info: () => {}, warn: () => {} }, workingDirectory: '/tmp', pollMs: 1, maxTurnWaitMs: 150, createUserMessage: h.createUserMessage })
  const pending = driver.run({ message: inbound() })
  await new Promise((resolve) => setImmediate(resolve))
  h.events.push(
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: h.followedUp[0]?.message as Record<string, unknown> },
    { seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Working on it' }] } } },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'provider disconnected' } } } },
  )
  const reply = await pending
  assert.equal(reply.text, 'provider disconnected')
  assert.equal(reply.failed, true)
})

test('a failure before the first model step is attributed to the claimed inbox message', async () => {
  const h = createHarness({ silent: true })
  const driver = new TurnDriver({ ctx: h.ctx, logger: { info: () => {}, warn: () => {} }, workingDirectory: '/tmp', pollMs: 1, maxTurnWaitMs: 150, createUserMessage: h.createUserMessage })
  const pending = driver.run({ message: inbound() })
  await new Promise((resolve) => setImmediate(resolve))
  h.events.push(
    { seq: 1, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 1, inserted: [h.followedUp[0]?.message] } },
    { seq: 2, type: 'turn/start', data: { turn: 1 } },
    { seq: 3, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'desktop failure' } } } },
    { seq: 5, type: 'turn/start', data: { turn: 2 } },
    { seq: 6, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { seq: 7, type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: 'missing provider' } } } },
  )
  const reply = await pending
  assert.equal(reply.text, 'missing provider')
  assert.equal(reply.failed, true)
})

test('an aborted request is not submitted to the host', async () => {
  const h = createHarness({ silent: true })
  const driver = new TurnDriver({ ctx: h.ctx, logger: { info: () => {}, warn: () => {} }, workingDirectory: '/tmp', pollMs: 1, maxTurnWaitMs: 150, createUserMessage: h.createUserMessage })
  const reply = await driver.run({ message: inbound(), signal: AbortSignal.abort(), context: [{ name: 'context', text: 'do not inject' }] })
  assert.equal(reply.failed, true)
  assert.equal(h.followedUp.length, 0)
  assert.equal(h.injected.length, 0)
})

test('a session is created with the host\'s default model route', async () => {
  const h = createHarness({ reply: '在' })
  const ctx = {
    get: (name: string) => {
      if (name === 'agents') return h.agentsService
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
      return undefined
    },
  }
  const driver = new TurnDriver({ ctx, logger: { info: () => {}, warn: () => {} }, workingDirectory: '/tmp', pollMs: 5, createUserMessage: h.createUserMessage })
  await driver.run({ message: inbound() })
  const created = h.created[0] as { agentOptions?: { provider?: string; model?: string } }
  assert.deepEqual(created.agentOptions, { provider: 'deepseek-official', model: 'deepseek-flash' })
})

test('no default route means no agentOptions, not a broken one', async () => {
  const h = createHarness({ reply: '在' })
  const driver = new TurnDriver({ ctx: h.ctx, logger: { info: () => {}, warn: () => {} }, workingDirectory: '/tmp', pollMs: 5, createUserMessage: h.createUserMessage })
  await driver.run({ message: inbound() })
  assert.equal((h.created[0] as { agentOptions?: unknown }).agentOptions, undefined)
})

test('the host preset is mounted during setup, which is what brings the tools', async () => {
  const h = createHarness({ reply: '在' })
  const mounted: string[] = []
  const ctx = {
    get: (name: string) => {
      if (name === 'agents') return h.agentsService
      if (name === 'agentPresets') {
        return {
          resolve: async () => ({ id: 'coder' }),
          mount: async (_agentCtx: unknown, id: string) => {
            mounted.push(id)
          },
        }
      }
      return undefined
    },
  }
  const driver = new TurnDriver({ ctx, logger: { info: () => {}, warn: () => {} }, workingDirectory: '/tmp', pollMs: 5, createUserMessage: h.createUserMessage })
  await driver.run({ message: inbound() })
  assert.deepEqual(mounted, ['coder'])
})

test('a new session is named once so the GUI lists it', async () => {
  const h = createHarness({ reply: '在' })
  const renamed: Array<{ sessionId: string; title: string }> = []
  const ctx = {
    get: (name: string) => {
      if (name === 'agents') return h.agentsService
      if (name === 'sessionTitle') {
        return {
          // The host's signature is rename(session, title) with a live session.
          rename: async (session: { id?: string }, title: string) => {
            renamed.push({ sessionId: String(session?.id), title })
          },
        }
      }
      return undefined
    },
  }
  const driver = new TurnDriver({
    ctx,
    logger: { info: () => {}, warn: () => {} },
    workingDirectory: '/tmp',
    pollMs: 5,
    createUserMessage: h.createUserMessage,
    titleFor: (message) => `${message.senderId.split('@')[0]}: ${message.text.slice(0, 10)}`,
  })
  await driver.run({ message: inbound({ text: '明天几点开会' }) })
  assert.equal(renamed.length, 1)
  assert.match(renamed[0]?.title ?? '', /^sender: 明天几点开会$/)
  assert.match(renamed[0]?.sessionId ?? '', /^chan-fake-[0-9a-f]{16}$/, 'a live session object is passed')
})

test('the output instruction travels on the identified followup, not the active desktop turn', async () => {
  const h = createHarness()
  const driver = new TurnDriver({ ctx: h.ctx, logger: { info() {}, warn() {} }, workingDirectory: '/tmp', pollMs: 5, createUserMessage: h.createUserMessage })
  await driver.run({ message: inbound({ text: 'make a file' }), deliverFiles: true })
  const message = h.followedUp[0]?.message as { content: Array<{ text: string }>; source: Record<string, unknown> }
  assert.equal(h.injected.length, 0)
  assert.match(message.content[0]?.text ?? '', /call present/)
  assert.match(message.content[0]?.text ?? '', /Inline local Markdown image/)
  assert.equal(message.content[1]?.text, 'make a file')
  assert.equal(message.source['hasOutputInstruction'], true)
})

test('a length-limited turn still returns the text the model produced', async () => {
  const h = createHarness({ silent: true })
  const driver = new TurnDriver({ ctx: h.ctx, logger: { info() {}, warn() {} }, workingDirectory: '/tmp', pollMs: 1, maxTurnWaitMs: 150, createUserMessage: h.createUserMessage })
  const pending = driver.run({ message: inbound() })
  await new Promise((resolve) => setImmediate(resolve))
  h.events.push(
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: h.followedUp[0]?.message as Record<string, unknown> },
    { seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Available answer' }] } } },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } },
  )
  assert.equal((await pending).text, 'Available answer')
})
