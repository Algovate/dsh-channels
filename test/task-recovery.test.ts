import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createChannelsRuntime, createFakeAdapter } from './runtime-helper.js'
import { createHarness, inbound } from './harness.js'
import { resetStateFile, stateFile } from '../packages/core/src/store/state.js'
import { Tasks } from '../packages/core/src/store/tasks.js'

function fixture(project = 'default') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-recover-'))
  const events: Array<Record<string, unknown>> = []
  const reads: number[] = []
  let closes = 0
  let afterRead: (() => void | Promise<void>) | undefined
  const header = { cwd: root }
  const message = inbound({ raw: { contextToken: 'original' } })
  const recovery = { message, sessionId: 'session', messageId: 'input', beforeSeq: -1, project }
  stateFile(root).write('tasks', [{ id: 'task', target: message, senderId: 'sender', summary: 'recover me', workingDirectory: root, startedAt: 1, execution: 'running', delivery: 'none', recovery }])
  resetStateFile(root)
  const runtime = createChannelsRuntime({ stateRoot: root, workingDirectory: root, config: { projects: { app: root } }, ctx: { get(name) {
    if (name !== 'sessionPersistence') return undefined
    return { async open(id: string, access: string) {
      assert.equal(id, 'session'); assert.equal(access, 'read')
      return { header, async read(offset: number, length: number) { reads.push(offset); await afterRead?.(); return { events: events.slice(offset, offset + length) } }, async close() { closes++ } }
    } }
  } } })
  const adapter = createFakeAdapter()
  let restored = 0
  adapter.restoreInbound = (input) => { assert.deepEqual(input.raw, { contextToken: 'original' }); restored++ }
  runtime.register(adapter)
  const turn = (id: string, text: string, complete = true) => {
    const number = events.length + 1
    for (const event of [
      { type: 'turn/start', data: { turn: number } },
      { type: 'user/message', data: { id } },
      { type: 'assistant/message', data: { turn: number, message: { content: [{ type: 'text', text }] } } },
      ...(complete ? [{ type: 'turn/end', data: { turn: number, reason: { kind: 'completed' } } }] : []),
    ]) events.push({ seq: events.length, ...event })
  }
  return { root, events, reads, runtime, adapter, turn, header, afterRead(fn: () => void | Promise<void>) { afterRead = fn }, restored: () => restored, closes: () => closes,
    tasks: () => stateFile(root).read<Array<{ execution: string; recovery?: unknown }>>('tasks')!,
    async close() { await runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }) } }
}

test('the exact host input binding is saved before followup can execute tools', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-submit-'))
  let binding: Record<string, unknown> | undefined
  const h = createHarness({ onFollowup() { binding = stateFile(root).read<Array<{ recovery?: Record<string, unknown> }>>('tasks')?.[0]?.recovery } })
  const runtime = createChannelsRuntime({ ctx: h.ctx, stateRoot: root })
  runtime.register(createFakeAdapter())
  try {
    runtime.dispatch(inbound())
    for (let i = 0; i < 100 && !h.followedUp.length; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.ok(binding)
    assert.equal(binding.messageId, (h.followedUp[0]!.message as { id: string }).id)
    assert.equal(binding.sessionId, h.created[0]!.sessionId)
  } finally { await runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('binding persistence failure prevents host submission', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-submit-fail-'))
  const h = createHarness()
  const runtime = createChannelsRuntime({ ctx: h.ctx, stateRoot: root, createUserMessage(fields) { stateFile(root).failNextWrite('tasks'); return h.createUserMessage(fields) } })
  runtime.register(createFakeAdapter())
  try {
    runtime.dispatch(inbound())
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(h.followedUp.length, 0)
  } finally { await runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('restart relays only the completed turn matching the persisted input, once', async () => {
  const f = fixture()
  try {
    f.turn('desktop', 'desktop secret')
    f.turn('input', 'recovered result')
    f.turn('later-desktop', 'another secret')
    await f.runtime.resumePending()
    await f.runtime.resumePending()
    assert.deepEqual(f.adapter.sent.filter((item) => item.outgoing.kind === 'reply').map((item) => item.outgoing.text), ['recovered result'])
    assert.equal(f.tasks()[0]!.execution, 'completed')
    assert.equal(f.tasks()[0]!.recovery, undefined)
    assert.ok(f.restored() >= 1)
    assert.equal(f.closes(), 1)
  } finally { await f.close() }
})

test('unfinished recovery saves its cursor and can relay a later completion without rerunning', async () => {
  const f = fixture()
  try {
    f.turn('input', 'eventual result', false)
    await f.runtime.resumePending()
    assert.equal(f.adapter.sent.length, 0)
    assert.equal(f.tasks()[0]!.execution, 'unknown')
    f.events.push({ seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await f.runtime.resumePending()
    assert.deepEqual(f.reads.slice(0, 3), [0, 3, 3])
    assert.equal(f.adapter.sent[0]?.outgoing.text, 'eventual result')
  } finally { await f.close() }
})

test('revocation during host reads prevents recovery delivery and preserves the binding', async () => {
  const f = fixture()
  try {
    f.turn('input', 'private result')
    f.afterRead(() => { f.runtime.updateAllowlist({ remove: 'sender' }) })
    await f.runtime.resumePending()
    assert.equal(f.adapter.sent.length, 0)
    assert.ok(f.tasks()[0]!.recovery)
    assert.equal(f.closes(), 1)
  } finally { await f.close() }
})

test('a queued recovered reply is not duplicated while its platform delivery is pending', async () => {
  const f = fixture()
  f.adapter.send = async () => ({ ok: false, code: 'offline' })
  try {
    f.turn('input', 'durable recovered result')
    await f.runtime.resumePending()
    await f.runtime.resumePending()
    assert.equal(f.runtime.outbox.list().length, 1)
    assert.equal(f.tasks()[0]!.recovery, undefined)
  } finally { await f.close() }
})

test('recovery ownership moves atomically to outbox before a platform send can start', async () => {
  const f = fixture()
  f.adapter.send = async () => {
    const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'state.json'), 'utf8'))
    assert.equal(saved.sections.tasks[0].recovery, undefined)
    assert.equal(saved.sections.outbox.items[0].outgoing.text, 'handoff result')
    return { ok: true, messageId: 'accepted' }
  }
  try {
    f.turn('input', 'handoff result')
    await f.runtime.resumePending()
    assert.equal(f.runtime.outbox.list().length, 0)
    assert.equal(f.tasks()[0]!.recovery, undefined)
  } finally { await f.close() }
})

test('removing the original project during recovery cannot deliver the result', async () => {
  const f = fixture('app')
  try {
    f.turn('input', 'removed project result')
    f.afterRead(() => { delete f.runtime.config.projects.app })
    await f.runtime.resumePending()
    assert.equal(f.adapter.sent.length, 0)
    assert.ok(f.tasks()[0]!.recovery)
  } finally { await f.close() }
})

test('a changed session directory is rejected and its read handle is closed', async () => {
  const f = fixture()
  try {
    f.turn('input', 'wrong directory result')
    f.header.cwd = os.tmpdir()
    await f.runtime.resumePending()
    assert.equal(f.adapter.sent.length, 0)
    assert.equal(f.closes(), 1)
    assert.ok(f.tasks()[0]!.recovery)
  } finally { await f.close() }
})

test('shutdown during a recovery read closes the handle and never sends a late result', async () => {
  const f = fixture()
  let entered = false
  let release!: () => void
  const wait = new Promise<void>((resolve) => { release = resolve })
  try {
    f.turn('input', 'late private result')
    f.afterRead(async () => { entered = true; await wait })
    const recovery = f.runtime.resumePending()
    for (let i = 0; i < 100 && !entered; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.ok(entered)
    await f.runtime.dispose()
    release(); await recovery
    assert.equal(f.adapter.sent.length, 0)
    assert.equal(f.closes(), 1)
    assert.ok(f.tasks()[0]!.recovery)
  } finally { release(); await f.close() }
})

test('revocation during the final account lookup blocks a recovered outbox send', async () => {
  const f = fixture()
  let accounts = 0
  f.adapter.accounts.list = async () => {
    if (++accounts === 3) f.runtime.updateAllowlist({ remove: 'sender' })
    return [{ accountId: 'acct', expired: false }]
  }
  try {
    f.turn('input', 'must remain private')
    await f.runtime.resumePending()
    assert.equal(f.adapter.sent.length, 0)
    assert.equal(f.runtime.outbox.list().length, 1)
  } finally { await f.close() }
})

test('a recovered host abort is recorded as cancellation rather than failure', async () => {
  const f = fixture()
  try {
    f.turn('input', '', false)
    f.events.push({ seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
    await f.runtime.resumePending()
    assert.equal(f.tasks()[0]!.execution, 'cancelled')
    assert.equal(f.tasks()[0]!.recovery, undefined)
  } finally { await f.close() }
})

test('recent-history retention cannot discard an unresolved host recovery', async () => {
  const f = fixture()
  try {
    const tasks = new Tasks(f.root, () => {})
    for (let i = 0; i < 12; i++) assert.equal(tasks.save({ id: `new-${i}`, target: inbound(), senderId: 'sender', summary: 'finished', startedAt: i + 2, execution: 'completed', delivery: 'sent' }), true)
    assert.equal(new Tasks(f.root, () => {}).recoverable()[0]?.id, 'task')
  } finally { await f.close() }
})

test('recovered file indexes are marked unsent before text ownership leaves recovery', async () => {
  const f = fixture()
  let unsentDuringText: unknown
  f.adapter.send = async () => {
    unsentDuringText = stateFile(f.root).read<Array<{ filesUnsent?: boolean }>>('tasks')?.[0]?.filesUnsent
    return { ok: false, code: 'offline' }
  }
  try {
    const file = path.join(f.root, 'report.txt')
    fs.writeFileSync(file, 'recovered report')
    f.turn('input', 'report ready', false)
    f.events.push({ seq: 3, type: 'deliverables/presented', data: { turn: 1, files: [{ path: file }] } },
      { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await f.runtime.resumePending()
    assert.equal(unsentDuringText, true)
    const task = stateFile(f.root).read<Array<{ artifacts: string[]; outputDirectory: string }>>('tasks')![0]!
    assert.deepEqual(task.artifacts, ['report.txt'])
    assert.equal(fs.readFileSync(path.join(task.outputDirectory, 'report.txt'), 'utf8'), 'recovered report')
  } finally { await f.close() }
})

test('pending delivery retains its sender and project through history turnover', async () => {
  const f = fixture()
  try {
    const tasks = new Tasks(f.root, () => {})
    tasks.save({ id: 'pending', target: inbound(), senderId: 'sender', summary: 'pending output', startedAt: 0, execution: 'completed', delivery: 'pending' })
    for (let i = 0; i < 12; i++) tasks.save({ id: `finished-${i}`, target: inbound(), senderId: 'sender', summary: 'finished', startedAt: i + 2, execution: 'completed', delivery: 'sent' })
    assert.ok(new Tasks(f.root, () => {}).get(inbound(), 'pending'))
  } finally { await f.close() }
})

test('incremental recovery retains the full assistant text until its later terminal event', async () => {
  const f = fixture()
  try {
    f.turn('input', 'X'.repeat(20000), false)
    await f.runtime.resumePending()
    f.events.push({ seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await f.runtime.resumePending()
    assert.equal(f.adapter.sent.filter((item) => item.outgoing.kind === 'reply').map((item) => item.outgoing.text).join(''), 'X'.repeat(20000))
  } finally { await f.close() }
})

test('final outbox removal and task uncertainty are committed together', async () => {
  const f = fixture()
  f.adapter.send = async () => ({ ok: true, unconfirmed: true })
  try {
    await f.runtime.send(inbound(), { kind: 'reply', text: 'unconfirmed result' }, 'task')
    const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'state.json'), 'utf8'))
    assert.equal(saved.sections.outbox.items.length, 0)
    assert.equal(saved.sections.tasks[0].unconfirmed, true)
    assert.equal(saved.sections.tasks[0].delivery, 'unknown')
  } finally { await f.close() }
})

test('a result blocked before durable handoff keeps recovery for later reauthorization', async () => {
  const f = fixture()
  const send = f.adapter.send
  f.adapter.send = async (target, outgoing) => {
    if (outgoing.kind === 'notice') f.runtime.updateAllowlist({ remove: 'sender' })
    return send(target, outgoing)
  }
  try {
    f.turn('input', 'recover after reauthorization', false)
    f.events.push({ seq: 3, type: 'deliverables/presented', data: { turn: 1, files: [{ path: path.join(f.root, 'missing.txt') }] } },
      { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await f.runtime.resumePending()
    assert.equal(f.adapter.sent.filter((item) => item.outgoing.kind === 'reply').length, 0)
    assert.equal(f.runtime.outbox.list().length, 0)
    assert.ok(f.tasks()[0]!.recovery)
    f.adapter.send = send
    f.runtime.updateAllowlist({ add: 'sender' })
    await f.runtime.resumePending()
    assert.equal(f.adapter.sent.find((item) => item.outgoing.kind === 'reply')?.outgoing.text, 'recover after reauthorization')
  } finally { await f.close() }
})
