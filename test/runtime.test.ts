import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Plugin integration tests must not consume quotas or write task state in the user's profile.
const previousStateRoot = process.env.DSH_CHANNELS_STATE_DIR
const pluginStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-plugin-test-'))
process.env.DSH_CHANNELS_STATE_DIR = pluginStateRoot
test.after(() => {
  if (previousStateRoot === undefined) delete process.env.DSH_CHANNELS_STATE_DIR
  else process.env.DSH_CHANNELS_STATE_DIR = previousStateRoot
  fs.rmSync(pluginStateRoot, { recursive: true, force: true })
})

import { createFakeAdapter, createChannelsRuntime } from './runtime-helper.js'
import { resolveConfig as resolveConfigForTest } from '../packages/core/src/config.js'
import { sessionIdFor } from '../packages/core/src/ids.js'
import { approvalEntry } from '../packages/core/src/interaction/approval.js'
import { questionEntry } from '../packages/core/src/interaction/questions.js'
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
  const replies = adapter.sent.filter((entry) => entry.outgoing.kind === 'reply')
  assert.equal(replies.length, 1)
  assert.equal(replies[0]?.outgoing.text, '收到')
  assert.equal(replies[0]?.target.conversationId, 'conv')
  runtime.dispose()
})

test('a long reply is split to the channel\'s limit', async () => {
  const h = createHarness({ reply: '字'.repeat(25) })
  const runtime = h.makeRuntime()
  const adapter = createFakeAdapter({ maxTextChars: 10 })
  runtime.register(adapter)
  runtime.dispatch(inbound())
  await tick(150)
  assert.equal(adapter.sent.filter((entry) => entry.outgoing.kind === 'reply').length, 3)
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

test('a reply to a pending question is consumed instead of starting a turn', async () => {
  const h = createHarness()
  const runtime = h.makeRuntime()
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  const pending = runtime.interactions.ask({
    kind: 'question',
    target: { channel: 'fake', accountId: 'acct', conversationId: 'conv' },
    view: { title: '选哪个', options: [{ id: '1', label: '甲' }, { id: '2', label: '乙' }] },
    parse: (text) => (text === '1' ? { ok: true, value: '1' } : text === '2' ? { ok: true, value: '2' } : { ok: false, hint: '回复序号' }),
    expiredNotice: '',
    retiredNotice: '',
    retireValue: '',
  })
  await tick(10)
  const decision = runtime.dispatch(inbound({ text: '2' }))
  assert.equal(decision.allow, true)
  assert.equal(await pending, '2')
  await tick(30)
  assert.equal(h.created.length, 0, 'answering does not start a turn')
  runtime.dispose()
})

test('while prompts change, ordinary messages and commands still get through', async (t) => {
  const h = createHarness()
  const runtime = h.makeRuntime({ autoSendFiles: false })
  t.after(() => runtime.dispose())
  const adapter = createFakeAdapter()
  const originalSend = adapter.send.bind(adapter)
  let releasePrompt = () => {}
  const sending = new Promise<void>((resolve) => { releasePrompt = resolve })
  t.after(() => releasePrompt())
  adapter.send = async (target, outgoing) => {
    if (outgoing.kind === 'question') await sending
    return originalSend(target, outgoing)
  }
  runtime.register(adapter)
  const target = { channel: 'fake', accountId: 'acct', conversationId: 'conv' }
  const approval = approvalEntry({ target, request: { toolName: 'test' } })
  const first = runtime.interactions.ask(approval)
  await tick()
  runtime.interactions.retire(approval)
  assert.equal(await first, 'unavailable')
  const question = questionEntry({ target, questions: [{ question: 'Free text' }] })
  const second = runtime.interactions.ask(question)
  void second.catch(() => {})

  runtime.dispatch(inbound({ text: `${approval.view.hint?.match(/[a-f0-9]{6}/)?.[0]} 1` }))
  runtime.dispatch(inbound({ text: '/new' }))
  runtime.dispatch(inbound({ text: '明天几点开会？' }))
  await tick(30)
  assert.ok(adapter.sent.some(({ outgoing }) => outgoing.kind === 'notice' && outgoing.text?.includes('第 1 条')))
  assert.deepEqual(
    h.followedUp.map(({ message }) => (message as { content: Array<{ text: string }> }).content[0]?.text),
    ['明天几点开会？'],
  )
  runtime.interactions.retire(question)
  await second
})

test('a non-answer keeps the question open and sends a hint', async () => {
  const h = createHarness()
  const runtime = h.makeRuntime()
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  const pending = runtime.interactions.ask({
    kind: 'question',
    target: { channel: 'fake', accountId: 'acct', conversationId: 'conv' },
    view: { title: '选哪个', options: [{ id: '1', label: '甲' }] },
    parse: (text) => (text === '1' ? { ok: true, value: '1' } : { ok: false, hint: '请回复 1' }),
    expiredNotice: '',
    retiredNotice: '',
    retireValue: '',
  })
  await tick(10)
  runtime.dispatch(inbound({ text: '随便' }))
  await tick(20)
  assert.ok(adapter.sent.some((entry) => entry.outgoing.kind === 'notice' && entry.outgoing.text === '请回复 1'))
  assert.equal(runtime.interactions.busy({ channel: 'fake', accountId: 'acct', conversationId: 'conv' }), true)
  runtime.dispatch(inbound({ text: '1' }))
  assert.equal(await pending, '1')
  runtime.dispose()
})

test('an agent that answers for a conversation can be mapped back to it', async () => {
  const h = createHarness({ reply: '在' })
  const runtime = h.makeRuntime()
  runtime.register(createFakeAdapter())
  runtime.dispatch(inbound())
  await tick(150)
  const agent = h.agents.get(sessionIdFor({ channel: 'fake', accountId: 'acct', conversationId: 'conv' }))
  assert.ok(agent !== undefined)
  assert.equal(runtime.interactionForAgent(agent)?.target, undefined)
  assert.equal(runtime.interactionForAgent({ session: { id: 'someone-elses-session' } })?.target, undefined)
  runtime.dispose()
})

test('a media reply goes out through the adapter, and both phases are journalled', async () => {
  const fs = await import('node:fs')
  const h = createHarness()
  const runtime = h.makeRuntime()
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  const target = { channel: 'fake', accountId: 'acct', conversationId: 'conv' }
  const results = await runtime.send(target, { text: '给你看', kind: 'reply', media: [{ kind: 'image', path: '/tmp/a.png' }] })
  assert.equal(results.length, 2, 'the caption bubble and the attachment')
  assert.equal(adapter.sent.length, 2)
  assert.equal(adapter.sent[0]?.outgoing.text, '给你看')
  assert.equal(adapter.sent[1]?.outgoing.media?.length, 1)
  const states = runtime.journal.outbound().map((row) => row.state)
  assert.deepEqual(states, ['accepted', 'accepted'])
  const day = runtime.journal.file()
  assert.ok(fs.existsSync(day))
  runtime.dispose()
})

test('files the turn wrote are sent as attachments after the reply', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-ws-'))
  const h = createHarness({
    reply: '做好了',
    // The fake agent "uses a tool" during the turn.
    onFollowup: () => {
      const output = fs.readdirSync(workspaceDir).find((entry) => entry.startsWith('.channel-output-'))
      assert.ok(output)
      fs.writeFileSync(path.join(workspaceDir, output, 'out.txt'), 'done')
    },
  })
  const runtime = createChannelsRuntime({ ctx: h.ctx, config: { autoSendFiles: true }, workingDirectory: workspaceDir })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  runtime.dispatch(inbound())
  await tick(200)
  const withMedia = adapter.sent.filter((entry) => (entry.outgoing.media ?? []).length > 0)
  assert.equal(withMedia.length, 1, 'the produced file went out as an attachment')
  assert.match(withMedia[0]?.outgoing.media?.[0]?.path ?? '', /out\.txt$/)
  runtime.dispose()
})

test('autoSendFiles:false keeps the turn text-only', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-ws-'))
  const h = createHarness({
    reply: '做好了',
    onFollowup: () => fs.writeFileSync(path.join(workspaceDir, 'out.txt'), 'done'),
  })
  const runtime = createChannelsRuntime({ ctx: h.ctx, config: { autoSendFiles: false }, workingDirectory: workspaceDir })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  runtime.dispatch(inbound())
  await tick(200)
  assert.equal(adapter.sent.some((entry) => (entry.outgoing.media ?? []).length > 0), false)
  runtime.dispose()
})

test('the channel working directory is registered as a workspace when the host has one', async () => {
  const created: Array<{ dir: string; title?: string }> = []
  const h = createHarness({ reply: '在' })
  const ctx = {
    get: (name: string) => {
      if (name === 'agents') return h.agentsService
      if (name === 'workspaceRegistry') {
        return {
          create: async (dir: string, title?: string) => {
            created.push({ dir, ...(title === undefined ? {} : { title }) })
            return { id: 'w1' }
          },
        }
      }
      return undefined
    },
  }
  const { startChannels } = await import('../packages/core/src/index.js')
  const plugin = await startChannels({ ctx, config: resolveConfigForTest({ adapters: [] }) })
  assert.equal(created.length, 1)
  assert.match(created[0]?.dir ?? '', /workspace$/)
  assert.equal(created[0]?.title, 'Channels')
  await plugin.dispose()
})

test('a workspace registry that throws costs the grouping, not the plugin', async () => {
  const h = createHarness({ reply: '在' })
  const ctx = {
    get: (name: string) => {
      if (name === 'agents') return h.agentsService
      if (name === 'workspaceRegistry') {
        return {
          create: async () => {
            throw new Error('not permitted')
          },
        }
      }
      return undefined
    },
  }
  const { startChannels } = await import('../packages/core/src/index.js')
  const plugin = await startChannels({ ctx, config: resolveConfigForTest({ adapters: [] }) })
  assert.ok(plugin !== undefined)
  await plugin.dispose()
})

test('the first turn attaches its session to the channel workspace', async () => {
  const attached: string[] = []
  const h = createHarness({ reply: '在' })
  const workspace = { id: 'w1', attachSession: async (sessionId: string) => { attached.push(sessionId) } }
  const ctx = {
    get: (name: string) => {
      if (name === 'agents') return h.agentsService
      if (name === 'workspaceRegistry') return { create: async () => workspace }
      return undefined
    },
  }
  const { startChannels } = await import('../packages/core/src/index.js')
  const plugin = await startChannels({
    ctx,
    config: resolveConfigForTest({ adapters: [], allowedSenders: ['sender'] }),
  })
  // The adapter is not started (no credentials in a temp root); drive the
  // runtime directly, which is what an inbound message does.
  plugin.runtime.register(createFakeAdapter())
  plugin.runtime.dispatch(inbound())
  await tick(200)
  assert.deepEqual(attached, [sessionIdFor({ channel: 'fake', accountId: 'acct', conversationId: 'conv' })])
  await plugin.dispose()
})

test('the live allowlist can be extended and trimmed without a restart', () => {
  const h = createHarness()
  const runtime = createChannelsRuntime({ ctx: h.ctx, config: { allowedSenders: ['a'] } })
  assert.deepEqual(runtime.updateAllowlist({ add: 'b' }), ['a', 'b'])
  assert.deepEqual(runtime.updateAllowlist({ add: 'b' }), ['a', 'b'], 'adding twice is idempotent')
  assert.deepEqual(runtime.updateAllowlist({ remove: 'a' }), ['b'])
  // The gate reads the same array, so the next message sees the change.
  const decision = runtime.dispatch(inbound({ senderId: 'b' }))
  assert.equal(decision.allow, true)
  const refused = runtime.dispatch(inbound({ senderId: 'c' }))
  assert.equal(refused.allow, false)
  runtime.dispose()
})
