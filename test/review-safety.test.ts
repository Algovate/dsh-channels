import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TurnDriver } from '../packages/core/src/turns.js'
import { Outbox } from '../packages/core/src/store/outbox.js'
import { stateFile } from '../packages/core/src/store/state.js'
import { createHarness, inbound } from './harness.js'
import { createChannelsRuntime, createFakeAdapter } from './runtime-helper.js'
import { InteractionQueue } from '../packages/core/src/interaction/queue.js'
import { answerUserQuestion } from '../packages/core/src/interaction/questions.js'
import { answerApproval } from '../packages/core/src/interaction/approval.js'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { startChannels } from '../packages/core/src/index.js'
import { resolveConfig } from '../packages/core/src/config.js'

const logger = { info() {}, warn() {} }

test('a rejected host event subscription falls back to polling completed turns', async () => {
  const h = createHarness({ reply: 'fallback result' })
  const driver = new TurnDriver({ ctx: { get: h.ctx.get, on() { throw new Error('subscription refused') } }, logger,
    workingDirectory: os.tmpdir(), createUserMessage: h.createUserMessage, maxTurnWaitMs: 50, pollMs: 1 })
  try {
    const reply = await driver.run({ message: inbound() })
    assert.equal(reply.text, 'fallback result')
    assert.equal(reply.pending, undefined)
  } finally { await driver.dispose() }
})

test('a rejected native activation guard disables schedule creation', async () => {
  const h = createHarness()
  let creates = 0
  const runtime = createChannelsRuntime({ ctx: { get(name) {
    if (name === 'schedule') return { async create() { creates++; return {} }, catalog() { return [] }, async edit() {}, async history() { return {} } }
    if (name === 'sessionPersistence') return { async open() {} }
    return h.ctx.get(name)
  }, ...{ on() { throw new Error('activation hooks unavailable') } } } })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  try {
    runtime.dispatch(inbound({ text: '/schedule after 1 run later' }))
    for (let i = 0; i < 100 && !adapter.sent.length; i++) await new Promise((resolve) => setTimeout(resolve, 2))
    assert.equal(creates, 0)
    assert.ok(adapter.sent.some((item) => /不可用|宿主/.test(item.outgoing.text ?? '')))
  } finally { await runtime.dispose() }
})

test('an unreadable outbox cannot report an enqueued reply as accepted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-outbox-'))
  try {
    const box = new Outbox({ stateRoot: root })
    const entry = box.enqueue(inbound(), ['result'])!
    stateFile(root).write('outbox', { schemaVersion: 1, items: [null] })
    let sends = 0
    assert.deepEqual(await box.sendPending(entry, async () => { sends++; return { ok: true, messageId: 'unexpected' } }), [{ ok: false, code: 'outbox-persist' }])
    assert.equal(sends, 0)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a question deadline withdraws its original prompt before rejecting the seam', async () => {
  const queue = new InteractionQueue({ send: async () => [{ ok: true, messageId: 'question' }], logger })
  const ask = queue.ask.bind(queue)
  // Delay prompt expiration independently of the host interaction deadline.
  queue.ask = (entry, options) => ask(entry, { signal: options?.signal })
  try {
    await assert.rejects(answerUserQuestion({ queue, target: inbound(), questions: [{ question: 'Continue?' }], request: { deadlineAt: Date.now() + 15 }, next: () => new Promise(() => {}) }))
    assert.equal(queue.pendingCount(), 0)
    assert.notEqual(queue.claim(inbound(), 'late answer').status, 'answered')
  } finally { queue.dispose() }
})

test('simultaneous startup grants only one process ownership of a fresh state root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-lock-'))
  const moduleUrl = pathToFileURL(path.resolve('dist-test/packages/core/src/store/state.js')).href
  const worker = `
    import fs from 'node:fs'; import path from 'node:path';
    import { stateFile } from ${JSON.stringify(moduleUrl)};
    const root = ${JSON.stringify(root)};
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      try { return read.call(this, file, ...args) }
      catch (error) {
        if (String(file) === path.join(root, 'state.lock') && error.code === 'ENOENT') {
          fs.writeFileSync(path.join(root, 'ready-' + process.pid), 'ready');
          const limit = Date.now() + 150;
          while (fs.readdirSync(root).filter(name => name.startsWith('ready-')).length < 2 && Date.now() < limit) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        throw error;
      }
    };
    try { stateFile(root).read('lines'); console.log('owner') }
    catch { console.log('refused') }
    await new Promise(resolve => {
      const timeout = setTimeout(() => { clearInterval(timer); resolve() }, 10000);
      const timer = setInterval(() => {
        if (fs.existsSync(path.join(root, 'release'))) { clearInterval(timer); clearTimeout(timeout); resolve() }
      }, 5);
    });
  `
  const run = () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker], { stdio: ['ignore', 'pipe', 'pipe'] })
    const closed = new Promise<void>((resolve) => { child.on('close', () => resolve()) })
    const reported = new Promise<string>((resolve, reject) => {
      let output = ''; let errors = ''
      child.stdout.on('data', (data) => { output += String(data); if (output.includes('\n')) resolve(output.trim()) })
      child.stderr.on('data', (data) => { errors += String(data) })
      child.on('error', reject)
      child.on('close', () => { if (!output.includes('\n')) reject(new Error(errors || 'worker exited without reporting ownership')) })
    })
    return { reported, closed }
  }
  const workers = [run(), run()]
  try { assert.deepEqual((await Promise.all(workers.map((worker) => worker.reported))).sort(), ['owner', 'refused']) }
  finally {
    fs.writeFileSync(path.join(root, 'release'), '')
    await Promise.all(workers.map((worker) => worker.closed))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an approval already past its deadline cannot accept a fast desktop allowance', async () => {
  const queue = new InteractionQueue({ send: async () => [{ ok: true, messageId: 'question' }], logger })
  try {
    assert.equal(await answerApproval({ queue, target: inbound(), request: { deadlineAt: Date.now() - 1 }, next: async () => 'allowed-once' }), 'unavailable')
    assert.equal(queue.pendingCount(), 0)
  } finally { queue.dispose() }
})

test('a stalled chat does not prevent other chats from retrying again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-retries-'))
  let now = 0
  const box = new Outbox({ stateRoot: root, now: () => now })
  box.add(inbound(), { kind: 'reply', text: 'stalled' }, {})
  box.add(inbound({ conversationId: 'other' }), { kind: 'reply', text: 'retry' }, {})
  let release!: () => void
  const wait = new Promise<void>((resolve) => { release = resolve })
  let attempts = 0
  now = 30000
  const first = box.drain(async (entry) => {
    if (entry.target.conversationId === 'conv') { await wait; return { ok: true } }
    attempts++; return { ok: false, code: 'offline' }
  })
  try {
    for (let i = 0; i < 100 && !attempts; i++) await new Promise((resolve) => setTimeout(resolve, 2))
    assert.equal(attempts, 1)
    now = 300000
    const retried = await box.drain(async (entry) => {
      assert.equal(entry.target.conversationId, 'other')
      attempts++; return { ok: true }
    })
    assert.equal(retried, 1)
    assert.equal(attempts, 2)
  } finally { release(); await first; fs.rmSync(root, { recursive: true, force: true }) }
})

test('failed plugin hook registration removes every subscription already installed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-startup-'))
  const previous = process.env.DSH_CHANNELS_STATE_DIR
  process.env.DSH_CHANNELS_STATE_DIR = root
  const subscriptions = new Set<symbol>()
  try {
    await assert.rejects(startChannels({ config: resolveConfig({ adapters: [] }), ctx: {
      get() { return undefined }, on(event) {
        if (event === 'approval/request') throw new Error('approval registration unavailable')
        const subscription = Symbol(event)
        subscriptions.add(subscription)
        return () => { subscriptions.delete(subscription) }
      },
    } }), /approval registration unavailable/)
    assert.equal(subscriptions.size, 0)
  } finally {
    if (previous === undefined) delete process.env.DSH_CHANNELS_STATE_DIR
    else process.env.DSH_CHANNELS_STATE_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an interrupted lock claim fails closed without rewriting the previous owner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-claim-'))
  try {
    const lock = JSON.stringify({ pid: process.pid, startedAt: 1 })
    fs.writeFileSync(path.join(root, 'state.lock'), lock)
    fs.writeFileSync(path.join(root, 'state.claim'), '{"pid":123}')
    assert.throws(() => stateFile(root).read('lines'), /state\.claim/)
    assert.equal(fs.readFileSync(path.join(root, 'state.lock'), 'utf8'), lock)
    assert.equal(fs.existsSync(path.join(root, 'state.json')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a dead owner can be replaced and normal acquisition removes its short-lived claim', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-stale-lock-'))
  try {
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
    assert.equal(child.status, 0)
    fs.writeFileSync(path.join(root, 'state.lock'), JSON.stringify({ pid: Number(child.stdout), startedAt: 1 }))
    assert.equal(stateFile(root).read('lines'), undefined)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state.lock'), 'utf8')).pid, process.pid)
    assert.equal(fs.existsSync(path.join(root, 'state.claim')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
