import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createRateLimiter } from '../packages/core/src/inbound/gates.js'
import { Outbox } from '../packages/core/src/store/outbox.js'
import { scanProducedFiles } from '../packages/core/src/produced.js'
import { createHarness, inbound } from './harness.js'
import { createFakeAdapter, createChannelsRuntime, createFakeUserMessage } from './runtime-helper.js'
import { resolveConfig } from '../packages/core/src/config.js'
import { stateFile } from '../packages/core/src/store/state.js'

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reliability-'))
const until = async (check: () => boolean) => { for (let i = 0; i < 100; i++) { if (check()) return; await delay(5) } assert.ok(check()) }

test('memory quota reservations are settled once, including clear followed by queue cleanup', () => {
  const limiter = createRateLimiter({ limit: 2, windowMs: 60000 })
  limiter.take('sender')
  const queued = limiter.reserve('sender')!
  queued(false); queued(false); queued(true)
  assert.equal(limiter.take('sender'), true)
  assert.equal(limiter.take('sender'), false)
})

test('outbox reports add/drop persistence failures and preserves the prior entry', () => {
  const root = temp()
  const box = new Outbox({ stateRoot: root })
  const first = box.add(inbound(), { kind: 'reply', text: 'first' }, {})!
  stateFile(root).failNextWrite('outbox')
  assert.equal(box.add(inbound(), { kind: 'reply', text: 'cannot save' }, {}), undefined)
  stateFile(root).failNextWrite('outbox')
  assert.equal(box.drop(first.id), false)
  assert.equal(box.list()[0]?.id, first.id)
  fs.rmSync(root, { recursive: true })
})

test('platform retry delay survives enqueue and subsequent failed retry', async () => {
  let now = 0
  const root = temp()
  const box = new Outbox({ stateRoot: root, now: () => now })
  const add = box.add.bind(box) as (target: ReturnType<typeof inbound>, outgoing: { kind: 'reply'; text: string }, result: { retryAfterMs: number }) => { nextAt: number }
  assert.equal(add(inbound(), { kind: 'reply', text: 'answer' }, { retryAfterMs: 3600000 }).nextAt, 3600000)
  now = 3600000
  await box.drain(async () => ({ ok: false, code: 'rate-limited', retryAfterMs: 7200000 }))
  assert.equal(box.list()[0]?.nextAt, now + 7200000)
  fs.rmSync(root, { recursive: true })
})

test('produced-file selection considers the newest candidate beyond the old prefix cap', async () => {
  const root = temp()
  for (const [i, name] of ['a', 'b', 'c', 'd', 'z'].entries()) { const file = path.join(root, name); fs.writeFileSync(file, 'x'); fs.utimesSync(file, 1000 + i, 1000 + i) }
  assert.equal((await scanProducedFiles({ dir: root, sinceMs: 0, maxFiles: 1 })).files[0]?.name, 'z')
  fs.rmSync(root, { recursive: true })
})

test('skipped output files prevent an all-sent task state and notify the chat', async () => {
  const root = temp()
  const small = path.join(root, 'small')
  const large = path.join(root, 'large')
  const h = createHarness({
    onFollowup: () => { fs.writeFileSync(small, 'x'); fs.writeFileSync(large, 'larger than cap') },
    deliverables: () => [{ path: small }, { path: large }],
  })
  const runtime = createChannelsRuntime({ stateRoot: root, workingDirectory: root, ctx: h.ctx, config: { maxProducedFiles: 1, maxProducedBytes: 8 } })
  const adapter = createFakeAdapter(); runtime.register(adapter)
  try {
    runtime.dispatch(inbound())
    await until(() => fs.existsSync(path.join(root, 'tasks.json')) && JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).some((t: { delivery: string }) => t.delivery !== 'none' && t.delivery !== 'sending'))
    const task = JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8'))[0]
    assert.equal(task.filesUnsent, true)
    assert.notEqual(task.delivery, 'sent')
    assert.ok(adapter.sent.some((e) => e.outgoing.kind === 'notice' && /附件.*未发送/.test(e.outgoing.text ?? '')))
  } finally { await runtime.dispose(); fs.rmSync(root, { recursive: true }) }
})

test('a blocked task explains the storage failure once while preserving accepted work', async () => {
  const root = temp(); const h = createHarness(); const runtime = createChannelsRuntime({ stateRoot: root, ctx: h.ctx })
  const adapter = createFakeAdapter(); runtime.register(adapter)
  stateFile(root).failNextWrite('tasks')
  try {
    runtime.dispatch(inbound())
    await until(() => adapter.sent.some((e) => /任务记录.*无法保存/.test(e.outgoing.text ?? '')))
    stateFile(root).failNextWrite('tasks')
    await runtime.resumePending(); await delay(20)
    assert.equal(h.followedUp.length, 0); assert.equal(runtime.pendingInputs(), 1)
    assert.equal(adapter.sent.filter((e) => /任务记录.*无法保存/.test(e.outgoing.text ?? '')).length, 1)
    await runtime.resumePending()
    await until(() => h.followedUp.length === 1)
    assert.equal(runtime.pendingInputs(), 0)
  } finally { await runtime.dispose(); fs.rmSync(root, { recursive: true }) }
})

test('configuration bounds timers, counts and sizes and returns independent defaults', () => {
  const config = resolveConfig({ maxTurnWaitMs: -1, turnPollMs: 0, maxProducedFiles: -2, maxProducedBytes: -4, bubbleGapMs: -2 })
  assert.ok(config.maxTurnWaitMs > 0); assert.ok(config.turnPollMs > 0); assert.ok(config.maxProducedFiles >= 0); assert.ok(config.maxProducedBytes >= 0); assert.ok(config.bubbleGapMs >= 0)
  const first = resolveConfig({}); first.allowedSenders.push('changed'); first.allowlistPerAccount['new'] = []
  assert.deepEqual(resolveConfig({}).allowedSenders, [])
  assert.deepEqual(resolveConfig({}).allowlistPerAccount, {})
  assert.equal(resolveConfig({ senderPerMinute: -1 }).senderPerMinute, 6)
})

test('clearing a queued message cannot grant extra execution slots', async () => {
  const h = createHarness({ silent: true }); const runtime = h.makeRuntime({ senderPerMinute: 2, senderPerDay: 0, autoSendFiles: false })
  runtime.register(createFakeAdapter())
  try {
    runtime.dispatch(inbound({ text: 'first' })); await until(() => h.followedUp.length === 1)
    runtime.dispatch(inbound({ text: 'clear me' })); runtime.dispatch(inbound({ text: '/clear' }))
    h.events.push({ seq: 1, type: 'turn/start', data: { turn: 1 } }, { seq: 2, type: 'user/message', data: h.followedUp[0]!.message as Record<string, unknown> }, { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await delay(30)
    assert.equal(runtime.dispatch(inbound({ text: 'second actual execution' })).allow, true)
    assert.equal(runtime.dispatch(inbound({ text: 'over limit' })).allow, false)
  } finally { await runtime.dispose() }
})

test('retry metadata reaches the runtime outbox on initial send and retry', async () => {
  const root = temp(); const h = createHarness(); const runtime = createChannelsRuntime({ stateRoot: root, ctx: h.ctx })
  const adapter = createFakeAdapter(); adapter.send = async () => ({ ok: false, code: 'rate-limited', retryAfterMs: 3600000 }); runtime.register(adapter)
  try {
    const before = Date.now()
    await runtime.send(inbound(), { kind: 'reply', text: 'retry later' })
    assert.ok(runtime.outbox.list()[0]!.nextAt >= before + 3600000)
    const file = path.join(root, 'outbox.json'); const saved = JSON.parse(fs.readFileSync(file, 'utf8')); saved.items[0].nextAt = 0; fs.writeFileSync(file, JSON.stringify(saved))
    runtime.startOutboxRetry(5)
    await until(() => runtime.outbox.list()[0]!.attempts === 1)
    assert.ok(runtime.outbox.list()[0]!.nextAt >= before + 3600000)
  } finally { await runtime.dispose(); fs.rmSync(root, { recursive: true }) }
})

test('priority classification does not bypass authorization or normal message ordering', async () => {
  const h = createHarness(); const runtime = h.makeRuntime()
  runtime.register(createFakeAdapter())
  try {
    assert.equal(runtime.canBypassInbound(inbound({ text: '/cancel' })), true)
    assert.equal(runtime.canReceive(inbound({ text: '/cancel', senderId: 'stranger' })), false)
    assert.equal(runtime.canBypassInbound(inbound({ text: 'ordinary' })), false)
    const target = inbound()
    const entry = { kind: 'question' as const, target, view: { title: 'choose', options: [] }, parse: () => null, expiredNotice: '', retiredNotice: '', retireValue: '' }
    const waiting = runtime.interactions.ask(entry).catch(() => '')
    assert.equal(runtime.canBypassInbound(inbound({ text: '1' })), true)
    runtime.interactions.retire(entry); await waiting
  } finally { await runtime.dispose() }
})

test('a bounded output scan reports incomplete traversal independently of the send limit', async () => {
  const { scanProducedFiles } = await import('../packages/core/src/produced.js')
  const root = temp()
  try {
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(root, `${i}.txt`), 'x')
    const limited = await scanProducedFiles({ dir: root, sinceMs: 0, maxEntries: 2, maxFiles: 1 })
    assert.equal(limited.incomplete, true); assert.equal(limited.files.length, 1); assert.equal(limited.skipped, 1)
    const complete = await scanProducedFiles({ dir: root, sinceMs: 0, maxFiles: 1 })
    assert.equal(complete.incomplete, false); assert.equal(complete.skipped, 7)
  } finally { fs.rmSync(root, { recursive: true }) }
})
