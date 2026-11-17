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
  assert.equal(adapter.sent.length, 1)
  assert.equal(adapter.sent[0]?.outgoing.text, '在')
  runtime.dispose()
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
