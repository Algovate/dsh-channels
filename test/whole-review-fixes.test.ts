import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Outbox } from '../packages/core/src/store/outbox.js'
import { saveConfigOverlay } from '../packages/core/src/store/root.js'
import { readConfigOverlay, apply } from '../packages/core/src/index.js'
import { createChannelsRuntime, createFakeAdapter } from './runtime-helper.js'
import { createHarness, inbound } from './harness.js'
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'whole-review-'))

test('invalid outbox refuses mutations and retries without overwriting recoverable bytes', async () => {
  for (const original of ['{"items":[{"id":"recover-me"}', '{"schemaVersion":1,"items":[{"id":"invalid"}]}', '{"schemaVersion":2,"items":[]}']) {
    const root = temp(); const file = path.join(root, 'outbox.json'); fs.writeFileSync(file, original)
    const box = new Outbox({ stateRoot: root })
    try {
      assert.equal(box.add(inbound(), { kind: 'reply', text: 'new' }, {}), undefined)
      assert.equal(box.drop('invalid'), false)
      let sends = 0; assert.equal(await box.drain(async () => { sends++; return { ok: true } }), 0)
      assert.equal(sends, 0); assert.equal(fs.readFileSync(file, 'utf8'), original)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }
})

test('invalid config cannot widen startup permissions or be overwritten by a settings save', async () => {
  const root = temp(); const previous = process.env['DSH_CHANNELS_STATE_DIR']; process.env['DSH_CHANNELS_STATE_DIR'] = root
  try {
    assert.deepEqual(readConfigOverlay(root), {})
    for (const original of ['{"allowedSenders":["restricted"],', '[]', 'null', '{"allowedChats":null}', '{"allowlistPerAccount":{"acct":null}}', '{"allowedSenders":[7]}', '{"enabled":"false"}']) {
      fs.writeFileSync(path.join(root, 'config.json'), original)
      assert.throws(() => readConfigOverlay(root))
      await assert.rejects(apply({}, { allowedSenders: ['broad'] }))
      assert.equal(saveConfigOverlay(root, { senderPerDay: 5 }), false)
      assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), original)
    }
  } finally {
    if (previous === undefined) delete process.env['DSH_CHANNELS_STATE_DIR']; else process.env['DSH_CHANNELS_STATE_DIR'] = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('unavailable route remains retriable without consuming quota, and sends one recovery notice', async () => {
  const root = temp(); const h = createHarness()
  fs.writeFileSync(path.join(root, 'lines.json'), JSON.stringify({ 'fake|acct|conv': { project: 'removed', sessions: {} } }))
  const runtime = createChannelsRuntime({ ctx: h.ctx, stateRoot: root, workingDirectory: root, config: { senderPerMinute: 1 } }); const adapter = createFakeAdapter(); runtime.register(adapter)
  try {
    for (let i = 0; i < 2; i++) assert.throws(() => runtime.dispatch(inbound({ platformMessageId: 'retry' })), (error: unknown) => (error as { code?: string }).code === 'DSH_INBOUND_RETRY')
    await delay(20)
    assert.equal(runtime.pendingInputs(), 0); assert.equal(h.followedUp.length, 0)
    assert.equal(adapter.sent.filter((entry) => entry.outgoing.text?.includes('/project default')).length, 1)
    runtime.dispatch(inbound({ text: '/project default' })); await delay(20)
    assert.equal(runtime.dispatch(inbound({ platformMessageId: 'retry' })).allow, true)
    await delay(30); assert.equal(h.followedUp.length, 1)
  } finally { await runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('failed attachment-only input gives a notice without a model turn or a quota charge', async () => {
  const h = createHarness(); const runtime = createChannelsRuntime({ ctx: h.ctx, config: { senderPerMinute: 1 } }); const adapter = createFakeAdapter(); runtime.register(adapter)
  try {
    runtime.dispatch(inbound({ text: '', attachmentErrors: ['图片未能下载，请重新发送。'], platformMessageId: 'failed-photo' }))
    await delay(20)
    assert.equal(h.followedUp.length, 0); assert.equal(runtime.pendingInputs(), 0)
    assert.match(adapter.sent.at(-1)?.outgoing.text ?? '', /未能下载/)
    assert.equal(runtime.dispatch(inbound({ text: 'next' })).allow, true)
  } finally { await runtime.dispose() }
})

test('partial attachment failures are visible in the model input', async () => {
  const h = createHarness(); const runtime = createChannelsRuntime({ ctx: h.ctx }); runtime.register(createFakeAdapter())
  try {
    runtime.dispatch(inbound({ text: 'compare both', attachmentErrors: ['第二个文件未能下载。'] }))
    await delay(40)
    assert.match(JSON.stringify(h.followedUp), /第二个文件未能下载/)
  } finally { await runtime.dispose() }
})

test('automatic delivery uploads a bounded private snapshot and cleans it after the adapter reads it', async () => {
  const root = temp()
  const source = path.join(root, 'result.txt')
  const h = createHarness({
    deliverables: () => [{ path: source }],
    onFollowup: () => { fs.writeFileSync(source, 'original') },
  })
  const runtime = createChannelsRuntime({ ctx: h.ctx, stateRoot: root, workingDirectory: root })
  const adapter = createFakeAdapter(); let staged = ''; let uploaded = ''
  adapter.send = async (_target, outgoing) => {
    for (const item of outgoing.media ?? []) {
      staged = item.path
      fs.writeFileSync(source, 'changed-after-capture')
      uploaded = fs.readFileSync(staged, 'utf8')
    }
    return { ok: true, messageId: 'sent' }
  }
  runtime.register(adapter)
  try {
    runtime.dispatch(inbound())
    for (let i = 0; i < 100 && !staged; i++) await delay(5)
    assert.ok(staged); assert.equal(uploaded, 'original')
    assert.notEqual(staged, source)
    for (let i = 0; i < 100 && fs.existsSync(staged); i++) await delay(5)
    assert.equal(fs.existsSync(staged), false)
  } finally { await runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('idle owned handles are bounded while running and desktop-owned agents are retained', async () => {
  const { TurnDriver } = await import('../packages/core/src/turns.js')
  const disposed: string[] = []; const agents = new Map<string, { session: { id: string }; status: 'idle' | 'running' }>()
  agents.set('desktop', { session: { id: 'desktop' }, status: 'idle' })
  const driver = new TurnDriver({ ctx: { get: () => ({ get: (id: string) => agents.get(id), create: async (options: Record<string, unknown>) => {
    const id = String(options.sessionId); const agent = { session: { id }, status: id === 'running' ? 'running' as const : 'idle' as const }; agents.set(id, agent)
    return { agent, dispose: async () => { disposed.push(id); agents.delete(id) } }
  } }) }, workingDirectory: '/tmp', logger: { info() {}, warn() {} } })
  try {
    await driver.attach(inbound(), { sessionId: 'running' }); await driver.attach(inbound(), { sessionId: 'desktop' })
    for (let i = 0; i < 40; i++) await driver.attach(inbound(), { sessionId: `idle-${i}` })
    assert.ok(disposed.length >= 8); assert.ok(!disposed.includes('running')); assert.ok(!disposed.includes('desktop'))
    assert.ok(agents.has('running')); assert.ok(agents.has('desktop'))
  } finally { await driver.dispose() }
  assert.equal(disposed.length, new Set(disposed).size, 'dispose each owned handle once')
})

test('turn waiting asks for only events after its last observed sequence', async () => {
  const { TurnDriver } = await import('../packages/core/src/turns.js')
  const events: Array<Record<string, unknown>> = [{ seq: 0, type: 'old-event' }]; const ranges: Array<number | undefined> = []
  const agent = { session: { id: 'incremental', get seq() { return events.length }, snapshotEvents(from?: number) { ranges.push(from); return events.filter((event) => Number(event.seq) >= (from ?? 0)) } }, followup(input: unknown) {
    events.push({ seq: 1, type: 'turn/start', data: { turn: 1 } }, { seq: 2, type: 'user/message', data: input })
    setTimeout(() => { events.push({ seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'done' }] } } }, { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }) }, 20)
  } }
  const driver = new TurnDriver({ ctx: { get: (name) => name === 'agents' ? { get: () => agent } : undefined }, workingDirectory: '/tmp', logger: { info() {}, warn() {} }, pollMs: 2, createUserMessage: (fields) => ({ ...fields, id: 'incremental-input' }) })
  try { assert.equal((await driver.run({ message: inbound(), sessionId: 'incremental' })).text, 'done'); assert.ok(ranges.length > 1); assert.ok(ranges.every((from) => from !== undefined && from >= 1)); assert.ok(ranges.some((from) => from === 3)) }
  finally { await driver.dispose() }
})

test('attachment callbacks stay cosmetic and run once when borrowing a live agent', async () => {
  const { TurnDriver } = await import('../packages/core/src/turns.js')
  const agent = { session: { id: 'borrowed' } }; let callbacks = 0
  const driver = new TurnDriver({ ctx: { get: () => ({ get: () => agent }) }, workingDirectory: '/tmp', logger: { info() {}, warn() {} }, onAttach: () => { callbacks++; throw new Error('grouping failed') } })
  try {
    const first = await driver.attach(inbound(), { sessionId: 'borrowed' })
    assert.equal((await driver.attach(inbound(), { sessionId: 'borrowed' })).handle.agent, first.handle.agent)
    assert.equal(callbacks, 1)
  } finally { await driver.dispose() }
})
