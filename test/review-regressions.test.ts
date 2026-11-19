import { readSectionJson, writeSectionJson } from './state-helper.js'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { startChannels } from '../packages/core/src/index.js'
import { resolveConfig } from '../packages/core/src/config.js'
import { ChannelsRuntime } from '../packages/core/src/runtime.js'
import { FileCounterStore } from '../packages/core/src/store/counters.js'
import { Outbox } from '../packages/core/src/store/outbox.js'
import { stateInventory } from '../packages/core/src/store/inventory.js'
import { createHarness, inbound } from './harness.js'
import { createChannelsRuntime, createFakeAdapter } from './runtime-helper.js'

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'channels-regression-'))

test('/status does not disclose another conversation’s reply', async () => {
  const runtime = createHarness().makeRuntime()
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  await runtime.send(inbound({ conversationId: 'private' }), { kind: 'reply', text: 'private reply' })
  runtime.dispatch(inbound({ conversationId: 'other', text: '/status' }))
  assert.doesNotMatch(adapter.sent.at(-1)?.outgoing.text ?? '', /private reply/)
  runtime.dispose()
})

test('automatic attachments ignore recent files in the shared workspace', async () => {
  const workspace = temp()
  fs.writeFileSync(path.join(workspace, 'other-chat.txt'), 'other conversation')
  const runtime = createChannelsRuntime({ ctx: createHarness().ctx, workingDirectory: workspace })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  runtime.dispatch(inbound())
  await delay(30)
  assert.equal(adapter.sent.filter((entry) => entry.outgoing.kind === 'reply').length, 1)
  assert.ok(adapter.sent.every((entry) => entry.outgoing.media === undefined))
  runtime.dispose()
})

test('retry preserves newly queued replies and visits every due entry once', async () => {
  let now = 0
  const outbox = new Outbox({ stateRoot: temp(), now: () => now })
  const target = inbound()
  for (const text of ['one', 'two', 'three']) outbox.enqueue(target, [text])
  now = 90_000
  const attempted: Array<string | undefined> = []
  const delivered = await outbox.drain(async (entry) => {
    attempted.push(entry.outgoing.text)
    if (entry.outgoing.text === 'one') {
      outbox.enqueue(target, ['new'])
      assert.equal(await outbox.drain(async () => ({ ok: true })), 0)
    }
    return { ok: true }
  })
  assert.equal(delivered, 3)
  assert.deepEqual(attempted, ['one', 'two', 'three'])
  assert.deepEqual(outbox.list().map((entry) => entry.outgoing.text), ['new'])
})

test('rate limit follows the sender across chats while other group members get their own quota', () => {
  const runtime = createHarness().makeRuntime({ allowedSenders: ['sender', 'other'], senderPerMinute: 1 })
  assert.equal(runtime.dispatch(inbound({ text: '/whoami' })).allow, true)
  assert.equal(runtime.dispatch(inbound({ text: '/whoami', conversationId: 'other-chat' })).allow, false)
  assert.equal(runtime.dispatch(inbound({ text: '/whoami', senderId: 'other' })).allow, true)
  runtime.dispose()
})

test('startup and documented ASR paths are recognized by inventory', async () => {
  const root = temp()
  process.env.DSH_CHANNELS_STATE_DIR = root
  try {
    fs.mkdirSync(path.join(root, 'asr-models'))
    const plugin = await startChannels({ ctx: {}, config: resolveConfig({}) })
    await plugin.dispose()
    assert.deepEqual(stateInventory(root).unlisted, [])
  } finally {
    delete process.env.DSH_CHANNELS_STATE_DIR
  }
})

test('absent optional injection services do not hang startup', async () => {
  process.env.DSH_CHANNELS_STATE_DIR = temp()
  try {
    const ctx = { logger: { info() {} }, inject() {} }
    const plugin = await Promise.race([
      startChannels({ ctx, config: resolveConfig({}) }),
      delay(100).then(() => null),
    ])
    assert.ok(plugin)
    await plugin.dispose()
  } finally {
    delete process.env.DSH_CHANNELS_STATE_DIR
  }
})

test('failed overlay write is not reported as a saved revocation', async () => {
  const root = temp()
  process.env.DSH_CHANNELS_STATE_DIR = root
  const routes = new Map<string, { handler: (req: unknown, res: unknown) => void }>()
  const ctx = {
    get: () => ({
      requestRejection: () => undefined,
      getOrigin: () => 'http://localhost:9000',
      register: (route: { path: string; handler: (req: unknown, res: unknown) => void }) => {
        routes.set(route.path, route)
        return () => {}
      },
    }),
  }
  try {
    const plugin = await startChannels({ ctx, config: resolveConfig({ allowedSenders: ['sender'] }) })
    fs.mkdirSync(path.join(root, 'config.json'))
    const req = Object.assign(new EventEmitter(), { method: 'POST', headers: { origin: 'http://localhost:9000' } })
    let status = 0
    routes.get('/channels/allowlist')?.handler(req, {
      writeHead: (code: number) => { status = code },
      end: () => {},
    })
    req.emit('data', '{"remove":"sender"}')
    req.emit('end')
    assert.equal(status, 500)
    assert.deepEqual(plugin.runtime.config.allowedSenders, ['sender'])
    await plugin.dispose()
  } finally {
    delete process.env.DSH_CHANNELS_STATE_DIR
  }
})


test('attachment admission reserves quota exactly once', async () => {
  const runtime = createHarness().makeRuntime({ senderPerDay: 1 })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  const admitted = inbound({ text: '/whoami' })
  const denied = inbound({ text: '/whoami' })
  assert.equal(runtime.canReceive(admitted, true), true)
  assert.equal(runtime.canReceive(denied, true), false)
  assert.equal(runtime.dispatch(admitted).allow, true)
  assert.equal(adapter.sent.length, 1)
  runtime.dispose()
})

test('provider receipts suppress replays only within the same channel account and conversation', () => {
  const runtime = createHarness().makeRuntime()
  const first = inbound({ text: '/whoami', platformMessageId: 'message:42' })
  assert.equal(runtime.dispatch(first).allow, true)
  assert.equal(runtime.canReceive({ ...first }), false)
  assert.deepEqual(runtime.dispatch({ ...first }), { allow: false, reason: 'duplicate' })
  for (const scope of [
    { channel: 'other' },
    { accountId: 'other' },
    { conversationId: 'other' },
  ]) {
    assert.equal(runtime.dispatch({ ...first, ...scope }).allow, true)
  }
  runtime.dispose()
})

test('an interrupted attachment does not spend the last durable slot before replay', async () => {
  const stateRoot = temp()
  const open = async () => {
    const counters = new FileCounterStore({ stateRoot })
    await counters.load()
    return new ChannelsRuntime({
      ctx: {}, config: resolveConfig({ allowedSenders: ['sender'], senderPerDay: 1 }),
      counters, stateRoot, workingDirectory: stateRoot, logger: { info() {}, warn() {} },
    })
  }
  const original = await open()
  const interrupted = inbound({ text: '/whoami' })
  assert.equal(original.canReceive(interrupted, true), true)
  assert.equal(original.canReceive(inbound(), true), false)
  original.cancelReceive(interrupted)
  // A second reservation models a process exit before an adapter can clean up.
  assert.equal(original.canReceive(inbound(), true), true)
  original.dispose()
  const restarted = await open()
  const replay = inbound({ text: '/whoami' })
  assert.equal(restarted.canReceive(replay, true), true)
  assert.equal(restarted.dispatch(replay).allow, true)
  restarted.dispose()
  const afterDelivery = await open()
  assert.equal(afterDelivery.canReceive(inbound(), true), false)
  afterDelivery.dispose()
})

test('shutdown preserves queued work and rejects duplicate provider replay', async () => {
  const stateRoot = temp()
  const open = async () => {
    const counters = new FileCounterStore({ stateRoot })
    await counters.load()
    return new ChannelsRuntime({
      ctx: {}, config: resolveConfig({ allowedSenders: ['sender'], senderPerDay: 1 }),
      counters, stateRoot, workingDirectory: stateRoot, logger: { info() {}, warn() {} },
    })
  }
  const runtime = await open()
  const message = inbound({ text: 'queued work', platformMessageId: 'message:5' })
  assert.equal(runtime.dispatch(message).allow, true)
  assert.equal(runtime.canReceive({ ...message }), false)
  runtime.dispose() // no microtask has started the queued turn
  const restarted = await open()
  assert.equal(restarted.canReceive({ ...message }), false)
  assert.equal(JSON.parse(readSectionJson(stateRoot, 'inbox')).length, 1)
  restarted.dispose()
})

test('a permitted sender can answer an active approval after exhausting the turn quota', async () => {
  const runtime = createHarness().makeRuntime({ senderPerDay: 1 })
  runtime.register(createFakeAdapter())
  const target = inbound({ text: '/whoami' })
  assert.equal(runtime.dispatch(target).allow, true)
  const reply = runtime.interactions.ask({
    kind: 'approval',
    target,
    view: { title: 'Approval', options: [{ id: 'always', label: 'Allow' }] },
    parse: (text) => text === '1' ? { ok: true, value: 'allowed-once' } : { ok: false, hint: 'Choose a number' },
    expiredNotice: '',
    retiredNotice: '',
    retireValue: 'unavailable',
  })
  await delay(0)
  const badAnswer = inbound({ text: 'invalid' })
  assert.equal(runtime.canReceive(badAnswer), true)
  assert.equal(runtime.dispatch(badAnswer).allow, false)
  const answer = inbound({ text: '1' })
  assert.equal(runtime.canReceive(inbound({ text: '1' }), true), false)
  assert.equal(runtime.canReceive(answer), true)
  assert.equal(runtime.dispatch(answer).allow, true)
  assert.equal(await reply, 'allowed-once')
  runtime.dispose()
})

test('outbox does not retry via a replacement account', async () => {
  const harness = createHarness()
  const runtime = harness.makeRuntime()
  runtime.register(createFakeAdapter({ failWith: 'network' }))
  const target = inbound()
  await runtime.send(target, { kind: 'reply', text: 'old account private reply' })
  const file = path.join(path.dirname(path.dirname(runtime.journal.file())), 'outbox.json')
  const persisted = JSON.parse(readSectionJson(path.dirname(file), 'outbox'))
  persisted.items[0].nextAt = 0
  writeSectionJson(path.dirname(file), 'outbox', JSON.stringify(persisted))
  const replacement = createFakeAdapter()
  replacement.accounts.list = async () => [{ accountId: 'replacement', expired: false }]
  // Use the same runtime and remove the prior adapter as if the loader restarted it.
  Object.assign(runtime.adapter('fake')!, replacement)
  runtime.startOutboxRetry(5)
  await delay(25)
  assert.equal(replacement.sent.length, 0)
  assert.equal(runtime.outbox.list()[0]?.lastCode, 'account-unavailable')
  runtime.dispose()
})

test('a declared deliverable cannot be a symlink to another directory’s private file', async () => {
  const workspace = temp()
  const shared = temp()
  const source = path.join(workspace, 'report.txt')
  fs.writeFileSync(path.join(shared, 'private.txt'), 'private file')
  fs.symlinkSync(path.join(shared, 'private.txt'), source)
  const harness = createHarness({ deliverables: () => [{ path: source }] })
  const runtime = createChannelsRuntime({ ctx: harness.ctx, workingDirectory: workspace })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  try {
    runtime.dispatch(inbound())
    await delay(50)
    assert.equal(adapter.sent.filter((entry) => entry.outgoing.kind === 'reply').length, 1)
    assert.ok(adapter.sent.every((entry) => entry.outgoing.media === undefined))
    assert.equal(fs.readFileSync(path.join(shared, 'private.txt'), 'utf8'), 'private file')
  } finally {
    await runtime.dispose()
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('/status does not disclose another conversation’s queued sends or pending approvals', async () => {
  const runtime = createHarness().makeRuntime()
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  const target = inbound({ conversationId: 'private' })
  runtime.outbox.enqueue(target, ['private reply'])
  const prompt = runtime.interactions.ask({
    kind: 'approval',
    target,
    view: { title: 'Approval', options: [] },
    parse: () => null,
    expiredNotice: '',
    retiredNotice: '',
    retireValue: 'unavailable',
  })
  const retired = assert.rejects(prompt)
  runtime.dispatch(inbound({ conversationId: 'other', text: '/status' }))
  const status = adapter.sent.at(-1)?.outgoing.text ?? ''
  assert.match(status, /待重发：0/)
  assert.doesNotMatch(status, /等待审批|提示发送中|Approval/)
  runtime.dispose()
  await retired
})

test('a failed retry callback backs off without blocking other replies', async () => {
  let now = 0
  const outbox = new Outbox({ stateRoot: temp(), now: () => now })
  const target = inbound()
  outbox.enqueue(target, ['bad adapter'])
  outbox.enqueue({ ...target, conversationId: 'healthy-chat' }, ['healthy adapter'])
  now = 90_000
  const sent = await outbox.drain(async (entry) => {
    if (entry.outgoing.text === 'bad adapter') throw new Error('account lookup failed')
    return { ok: true }
  })
  assert.equal(sent, 1)
  assert.deepEqual(outbox.list().map((entry) => entry.outgoing.text), ['bad adapter'])
  assert.ok((outbox.list()[0]?.nextAt ?? 0) > now)
})

test('an unmigrated account override does not fall back to a broader global allowlist', () => {
  const runtime = createHarness().makeRuntime({ allowlistPerAccount: { default: [] } })
  const message = inbound({ channel: 'telegram', accountId: 'bot:123456' })
  assert.equal(runtime.canReceive(message, false, 'default'), false)
  runtime.config.allowlistPerAccount['bot:123456'] = ['sender']
  assert.equal(runtime.canReceive(message, false, 'default'), true)
  assert.equal(runtime.dispatch(message).allow, true)
  runtime.dispose()
})
