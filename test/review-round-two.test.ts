import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { AsrBridge } from '../packages/adapter-weixin/src/asr.js'
import { ChannelsRuntime } from '../packages/core/src/runtime.js'
import { TurnDriver } from '../packages/core/src/turns.js'
import { FileCounterStore } from '../packages/core/src/store/counters.js'
import { resolveConfig } from '../packages/core/src/config.js'
import { parseCommand } from '../packages/core/src/commands.js'
import { splitIntoBubbles } from '../packages/core/src/outbound.js'
import { extractDocumentText } from '../packages/core/src/documents.js'
import { createFakeAdapter } from './runtime-helper.js'
import { createHarness, inbound } from './harness.js'

const logger = { info() {}, warn() {} }
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'channels-round-two-'))

test('prototype properties are ordinary messages, never commands', () => {
  for (const word of ['constructor', '__proto__', 'hasOwnProperty']) assert.equal(parseCommand(`/${word}`), null)
})

test('emoji survive hard splits, including a one-character budget', () => {
  for (const limit of [1, 2, 3]) {
    const text = 'ab😀🐕cd'
    const bubbles = splitIntoBubbles(text, limit)
    assert.equal(bubbles.join(''), text)
    assert.ok(bubbles.every((bubble) => [...bubble].length <= limit))
    assert.ok(bubbles.every((bubble) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(bubble)))
  }
})

test('ASR buffers JSON lines and split UTF-8 before starting the next request', async () => {
  const root = temp()
  const script = path.join(root, 'bridge')
  fs.writeFileSync(script, '')
  let count = 0
  const emitter = new EventEmitter()
  const child = Object.assign(emitter, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, kill() { this.exitCode = 0; emitter.emit('exit', 0); return true } })
  child.stdin.on('data', () => {
    const bytes = Buffer.from(JSON.stringify({ ok: true, text: `第${++count}条` }) + '\n')
    child.stdout.write(bytes.subarray(0, 5))
    setTimeout(() => child.stdout.write(bytes.subarray(5, bytes.length - 6)), 2)
    setTimeout(() => child.stdout.write(bytes.subarray(bytes.length - 6)), 4)
  })
  const asr = new AsrBridge({ scriptPath: script, modelDir: root, logger, timeoutMs: 100, spawnImpl: (() => child) as unknown as typeof import('node:child_process').spawn })
  try {
    assert.deepEqual(await asr.transcribe('/tmp/one.wav'), { ok: true, text: '第1条' })
    assert.deepEqual(await asr.transcribe('/tmp/two.wav'), { ok: true, text: '第2条' })
  } finally { child.kill(); await asr.dispose(); fs.rmSync(root, { recursive: true }) }
})

test('/new reports a failed durable write and keeps the old session across restart', async () => {
  const root = temp()
  fs.mkdirSync(path.join(root, 'counters.json'))
  // The session identity store must also refuse its write here.
  const h = createHarness()
  const open = () => new ChannelsRuntime({ ctx: h.ctx, config: resolveConfig({ allowedSenders: ['sender'], autoSendFiles: false }), counters: new FileCounterStore({ stateRoot: root }), stateRoot: root, workingDirectory: root, logger, createUserMessage: h.createUserMessage })
  const runtime = open()
  fs.mkdirSync(path.join(root, 'lines.json'))
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  runtime.dispatch(inbound({ text: '/new' }))
  await tick()
  assert.match(adapter.sent[0]?.outgoing.text ?? '', /未能|无法|失败/)
  assert.doesNotMatch(adapter.sent[0]?.outgoing.text ?? '', /好，这条聊天/)
  runtime.dispatch(inbound())
  await tick()
  const before = [...h.agents.keys()][0]
  await runtime.dispose()
  fs.rmdirSync(path.join(root, 'lines.json'))
  const reopened = open()
  reopened.register(createFakeAdapter())
  reopened.dispatch(inbound())
  await tick()
  assert.equal([...h.agents.keys()].at(-1), before)
  await reopened.dispose()
  fs.rmSync(root, { recursive: true })
})

test('document cancellation and oversized binary files are rejected before parsing', async () => {
  const root = temp()
  const file = path.join(root, 'large.docx')
  fs.writeFileSync(file, Buffer.alloc(9 * 1024 * 1024))
  assert.match(JSON.stringify(await extractDocumentText(file)), /exceeds|too large|过大/)
  // The public entry must observe cancellation before doing any I/O.
  const controller = new AbortController()
  controller.abort()
  const result = await (extractDocumentText as (file: string, options: { signal: AbortSignal }) => Promise<unknown>)(file, { signal: controller.signal })
  assert.match(JSON.stringify(result), /abort|cancel/i)
  fs.rmSync(root, { recursive: true })
})

test('turn timeout cancels only its active host turn and withdraws approvals even if desktop never settles', async () => {
  const { InteractionQueue } = await import('../packages/core/src/interaction/queue.js')
  const { answerApproval } = await import('../packages/core/src/interaction/approval.js')
  const events: Array<Record<string, unknown>> = []
  let canceled = 0
  let inputId = ''
  const sent: string[] = []
  const queue = new InteractionQueue({ send: async (_target, outgoing) => { sent.push(outgoing.text ?? ''); return [{ ok: true, unconfirmed: true }] }, logger })
  const agent = {
    session: { id: 'session', snapshotEvents: () => events },
    followup(input: unknown) {
      inputId = (input as { id: string }).id
      events.push({ seq: 1, type: 'turn/start', data: { turn: 1 } }, { seq: 2, type: 'user/message', data: input })
    },
    cancel(_cause: unknown, options?: { keepInbox?: boolean }) { assert.equal(options?.keepInbox, true); canceled++; events.push({ seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } }) },
  }
  const driver = new TurnDriver({ ctx: { get: (name) => name === 'agents' ? { get: () => agent } : undefined }, logger, workingDirectory: '/tmp', createUserMessage: (fields) => ({ ...fields, id: 'channel-input' }), maxTurnWaitMs: 70, pollMs: 2 })
  const running = driver.run({ message: inbound() })
  try {
    await tick()
    assert.equal(inputId, 'channel-input')
    const lookup = (driver as unknown as { interactionForAgent?: (agent: unknown) => { target: ReturnType<typeof inbound>; signal: AbortSignal } | undefined }).interactionForAgent
    assert.ok(lookup, 'interactions must share the owning turn lifetime')
    const interaction = lookup.call(driver, agent)!
    const approval = answerApproval({ queue, target: interaction.target, request: { signal: interaction.signal }, next: () => new Promise(() => {}) })
    await tick()
    const code = sent.join('\n').match(/[a-f0-9]{6}/)![0]
    assert.equal((await running).failed, true)
    assert.equal(await Promise.race([approval, tick(50).then(() => 'hung')]), 'unavailable')
    assert.equal(queue.pendingCount(), 0)
    assert.notEqual(queue.claim(inbound(), `${code} 1`).status, 'answered')
    assert.equal(canceled, 1)
  } finally { queue.dispose(); await driver.dispose(); await running }
})

test('a timed-out input queued behind desktop work removes only its inbox entry', async () => {
  let canceled = 0
  const removed: string[] = []
  const events: Array<Record<string, unknown>> = []
  const agent = {
    session: { id: 'desktop', snapshotEvents: () => events },
    followup(input: unknown) { events.push(
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, type: 'user/message', data: { id: 'desktop-input' } },
      { seq: 3, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [input] } },
    ) },
    cancel() { canceled++ },
    inbox: { remove(id: string) { removed.push(id); return true } },
  }
  const driver = new TurnDriver({ ctx: { get: (name) => name === 'agents' ? { get: () => agent } : undefined }, logger, workingDirectory: '/tmp', createUserMessage: (fields) => ({ ...fields, id: 'channel-input' }), maxTurnWaitMs: 20, pollMs: 1 })
  try {
    assert.equal((await driver.run({ message: inbound() })).failed, true)
    assert.equal(canceled, 0)
    assert.deepEqual(removed, ['channel-input'])
  } finally { await driver.dispose() }
})

test('a cancelled question releases its seam even when the desktop answerer hangs', async () => {
  const { InteractionQueue } = await import('../packages/core/src/interaction/queue.js')
  const { answerUserQuestion } = await import('../packages/core/src/interaction/questions.js')
  const queue = new InteractionQueue({ send: async () => [{ ok: true, unconfirmed: true }], logger })
  const controller = new AbortController()
  const pending = answerUserQuestion({ queue, target: inbound(), questions: [{ question: 'Choose' }], request: { signal: controller.signal }, next: () => new Promise(() => {}) })
  controller.abort(new Error('turn canceled'))
  await assert.rejects(pending, /turn canceled/)
  assert.equal(queue.pendingCount(), 0)
  queue.dispose()
})

test('confirmed /new survives restart and advances a legacy counter line', async () => {
  const { sessionIdFor, lineKey } = await import('../packages/core/src/ids.js')
  const root = temp()
  const counters = new FileCounterStore({ stateRoot: root })
  counters.set(`line:${lineKey(inbound())}`, 2)
  const h = createHarness()
  const open = () => new ChannelsRuntime({ ctx: h.ctx, config: resolveConfig({ allowedSenders: ['sender'], autoSendFiles: false }), counters, stateRoot: root, workingDirectory: root, logger, createUserMessage: h.createUserMessage })
  const runtime = open()
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  runtime.dispatch(inbound({ text: '/new' }))
  await tick()
  assert.match(adapter.sent[0]?.outgoing.text ?? '', /第 3 条/)
  await runtime.dispose()
  const reopened = open()
  reopened.register(createFakeAdapter())
  reopened.dispatch(inbound())
  await tick()
  assert.equal(h.created[0]?.sessionId, sessionIdFor({ ...inbound(), conversationId: 'conv#3' }))
  await reopened.dispose()
  fs.rmSync(root, { recursive: true })
})

test('PDF extraction stops at the page/text budget and destroys resources on success and error', async () => {
  const { pdfText } = await import('../packages/core/src/documents.js')
  for (const fail of [false, true]) {
    let destroyed = 0
    let cleaned = 0
    let visited = 0
    const loader = { getDocument: () => ({
      promise: Promise.resolve({ numPages: 1000, getPage: async () => {
        visited++
        return { getTextContent: async () => { if (fail) throw new Error('bad page'); return { items: [{ str: 'sample' }] } }, cleanup() { cleaned++ } }
      } }),
      async destroy() { destroyed++ },
    }) }
    if (fail) await assert.rejects(pdfText(loader, new Uint8Array(), 4000), /bad page/)
    else {
      const result = await pdfText(loader, new Uint8Array(), 4000)
      assert.equal(result.truncated, true)
      assert.equal(visited, 20)
    }
    assert.equal(destroyed, 1)
    assert.equal(cleaned, visited)
  }
  let visited = 0
  const clipped = await pdfText({ getDocument: () => ({
    promise: Promise.resolve({ numPages: 10, getPage: async () => { visited++; return { getTextContent: async () => ({ items: [{ str: 'x'.repeat(10000) }] }), cleanup() {} } } }),
    async destroy() {},
  }) }, new Uint8Array(), 100)
  assert.equal(visited, 1)
  assert.equal(clipped.text.length, 100)
  assert.equal(clipped.truncated, true)
})
