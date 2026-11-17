import assert from 'node:assert/strict'
import test from 'node:test'
import { createHarness, inbound } from './harness.js'
import { createFakeAdapter } from './runtime-helper.js'
import { TurnDriver } from '../packages/core/src/turns.js'
import { approvalEntry } from '../packages/core/src/interaction/approval.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
test('queued messages lose admission when the sender is revoked', async () => {
  const h = createHarness({ silent: true, maxTurnWaitMs: 90 })
  const runtime = h.makeRuntime()
  runtime.register(createFakeAdapter())
  runtime.dispatch(inbound())
  await tick()
  runtime.dispatch(inbound({ text: 'queued' }))
  runtime.updateAllowlist({ remove: 'sender' })
  await new Promise((resolve) => setTimeout(resolve, 180))
  assert.equal(h.followedUp.length, 1)
  runtime.dispose()
})
test('settled channel turns do not claim desktop interactions', async () => {
  const h = createHarness()
  const runtime = h.makeRuntime()
  runtime.register(createFakeAdapter())
  runtime.dispatch(inbound())
  await tick()
  assert.equal(runtime.targetForAgent([...h.agents.values()][0]), undefined)
  runtime.dispose()
})
test('attach consults the current host agent rather than a stale cache', async () => {
  const h = createHarness()
  const driver = new TurnDriver({ ctx: h.ctx, workingDirectory: '/tmp', logger: { info() {}, warn() {} } })
  const first = await driver.attach(inbound())
  h.agentsService.remove(first.sessionId)
  const second = await driver.attach(inbound())
  assert.notEqual(first.handle.agent, second.handle.agent)
})
test('approvals require a fresh request code', () => {
  const entry = approvalEntry({ target: inbound({ group: true }), request: { toolName: 'bash' } })
  assert.notEqual(entry.parse('1')?.ok, true)
  assert.notEqual(entry.parse('yes')?.ok, true)
  const code = entry.view.hint?.match(/[a-f0-9]{6}/)?.[0]
  assert.ok(code)
  assert.deepEqual(entry.parse(`${code} 1`), { ok: true, value: 'allowed-once' })
  assert.notEqual(approvalEntry({ target: inbound(), request: {} }).parse(`${code} 1`)?.ok, true)
})

test('only the exact active channel turn owns its questions, including group identity', async () => {
  const h = createHarness({ silent: true })
  const driver = new TurnDriver({ ctx: h.ctx, workingDirectory: '/tmp', logger: { info() {}, warn() {} }, createUserMessage: h.createUserMessage, pollMs: 1 })
  const message = inbound({ group: true })
  const pending = driver.run({ message })
  await tick()
  const agent = [...h.agents.values()][0]!
  assert.equal(driver.targetForAgent(agent), undefined)
  h.events.push({ seq: 1, type: 'turn/start', data: { turn: 1 } })
  h.events.push({ seq: 2, type: 'user/message', data: { id: 'desktop' } })
  assert.equal(driver.targetForAgent(agent), undefined)
  h.events.push({ seq: 3, type: 'turn/end', data: { turn: 1 } })
  h.events.push({ seq: 4, type: 'turn/start', data: { turn: 2 } })
  h.events.push({ seq: 5, type: 'user/message', data: h.followedUp[0]!.message as Record<string, unknown> })
  assert.deepEqual(driver.targetForAgent(agent), message)
  h.events.push({ seq: 6, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  h.events.push({ seq: 7, type: 'turn/start', data: { turn: 3 } })
  assert.equal(driver.targetForAgent(agent), undefined)
  await pending
  await driver.dispose()
})

test('owned handles are disposed once while borrowed desktop handles remain live', async () => {
  let disposed = 0
  const agent = { session: { id: 'owned' } }
  const agents = { get: (id: string) => id === 'borrowed' ? {} : undefined, create: async () => ({ agent, dispose: async () => { disposed++ } }) }
  const driver = new TurnDriver({ ctx: { get: () => agents }, workingDirectory: '/tmp', logger: { info() {}, warn() {} } })
  await driver.attach(inbound(), { sessionId: 'owned' })
  await driver.attach(inbound(), { sessionId: 'borrowed' })
  await driver.dispose()
  await driver.dispose()
  assert.equal(disposed, 1)
})

test('a stuck attach is bounded by the whole-turn deadline and cannot submit later', async () => {
  let release!: (value: { agent: { followup: () => void }; dispose: () => void }) => void
  let submitted = 0
  let disposed = 0
  const agents = { create: () => new Promise((resolve) => { release = resolve }) }
  const driver = new TurnDriver({ ctx: { get: (name) => name === 'agents' ? agents : undefined }, workingDirectory: '/tmp', logger: { info() {}, warn() {} }, maxTurnWaitMs: 15 })
  const reply = await driver.run({ message: inbound() })
  assert.equal(reply.failed, true)
  release({ agent: { followup: () => { submitted++ } }, dispose: () => { disposed++ } })
  await tick()
  assert.equal(submitted, 0)
  assert.equal(disposed, 1)
  await driver.dispose()
})

test('attachment failure is reported to the chat and empty output directories are removed', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-empty-output-'))
  const { createChannelsRuntime } = await import('./runtime-helper.js')
  const runtime = createChannelsRuntime({ ctx: {}, workingDirectory: root })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  runtime.dispatch(inbound())
  await tick()
  assert.match(adapter.sent[0]?.outgoing.text ?? '', /\/status/)
  assert.deepEqual(fs.readdirSync(root), [])
  await runtime.dispose()
  fs.rmSync(root, { recursive: true })
})

test('a different authorized group member cannot approve the initiating sender’s request', async () => {
  const { InteractionQueue } = await import('../packages/core/src/interaction/queue.js')
  const queue = new InteractionQueue({ send: async () => [{ ok: true, unconfirmed: true }], logger: { info() {}, warn() {} } })
  const entry = approvalEntry({ target: inbound({ group: true }), request: {} })
  const pending = queue.ask(entry)
  await tick()
  const answer = `${entry.view.hint?.match(/[a-f0-9]{6}/)?.[0]} 1`
  assert.equal(queue.claim(inbound({ senderId: 'other' }), answer).status, 'invalid')
  assert.equal(queue.claim(inbound(), answer).status, 'answered')
  assert.equal(await pending, 'allowed-once')
  queue.dispose()
})
