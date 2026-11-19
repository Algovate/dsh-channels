import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createChannelsRuntime, createFakeAdapter } from './runtime-helper.js'
import { inbound } from './harness.js'
import { stateFile, resetStateFile } from '../packages/core/src/store/state.js'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-durable-'))
  const runtime = createChannelsRuntime({ ctx: {}, stateRoot: root })
  const adapter = createFakeAdapter({ maxTextChars: 3 })
  runtime.register(adapter)
  return { root, runtime, adapter, async close() { await runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }) } }
}

test('the complete reply is durable before the first platform send', async () => {
  const s = setup()
  const observed: string[][] = []
  s.adapter.send = async () => {
    const entry = s.runtime.outbox.list()[0]
    observed.push(entry ? [entry.outgoing.text!, ...(entry.remaining ?? [])] : [])
    return { ok: true, messageId: 'accepted' }
  }
  try {
    await s.runtime.send(inbound(), { kind: 'reply', text: 'ABCDEFGHI' })
    assert.deepEqual(observed, [['ABC', 'DEF', 'GHI'], ['DEF', 'GHI'], ['GHI']])
    assert.equal(s.runtime.outbox.list().length, 0)
  } finally { await s.close() }
})

test('a reply is never sent when the durable enqueue fails', async () => {
  const s = setup()
  try {
    stateFile(s.root).failNextWrite('outbox')
    const results = await s.runtime.send(inbound(), { kind: 'reply', text: 'secret' })
    assert.deepEqual(results, [{ ok: false, code: 'outbox-persist' }])
    assert.equal(s.adapter.sent.length, 0)
  } finally { await s.close() }
})

test('failed progress persistence stops the tail and leaves it recoverable after restart', async () => {
  const s = setup()
  const sent: string[] = []
  s.adapter.send = async (_target, outgoing) => {
    sent.push(outgoing.text!)
    stateFile(s.root).failNextWrite('outbox')
    return { ok: true, messageId: 'accepted' }
  }
  try {
    const results = await s.runtime.send(inbound(), { kind: 'reply', text: 'ABCDEF' })
    assert.deepEqual(sent, ['ABC'])
    assert.ok(results.some((result) => !result.ok && result.code === 'outbox-persist'))
    resetStateFile(s.root)
    const state = stateFile(s.root).read<{ items: Array<{ outgoing: { text: string }; remaining: string[] }> }>('outbox')!
    assert.equal(state.items[0]!.outgoing.text, 'ABC')
    assert.deepEqual(state.items[0]!.remaining, ['DEF'])
  } finally { await s.close() }
})

test('concurrent replies cannot overtake the first reply in the same chat', async () => {
  const s = setup()
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const sent: string[] = []
  s.adapter.send = async (_target, outgoing) => {
    sent.push(outgoing.text!)
    if (sent.length === 1) await blocked
    return { ok: true, messageId: `m${sent.length}` }
  }
  try {
    const first = s.runtime.send(inbound(), { kind: 'reply', text: 'ABCDEF' })
    await delay(5)
    const second = s.runtime.send(inbound(), { kind: 'reply', text: 'GHI' })
    await delay(5)
    assert.deepEqual(sent, ['ABC'])
    release()
    await Promise.all([first, second])
    assert.deepEqual(sent, ['ABC', 'DEF', 'GHI'])
  } finally { release(); await s.close() }
})

test('a blocked platform send in one chat does not block another chat', async () => {
  const s = setup()
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  s.adapter.send = async (target) => {
    if (target.conversationId === 'conv') await blocked
    return { ok: true, messageId: 'accepted' }
  }
  try {
    const first = s.runtime.send(inbound(), { kind: 'reply', text: 'ABC' })
    const other = await s.runtime.send(inbound({ conversationId: 'other' }), { kind: 'reply', text: 'DEF' })
    assert.equal(other[0]?.ok, true)
    release(); await first
  } finally { release(); await s.close() }
})

test('a partly unconfirmed reply retains its uncertainty in the durable tail', async () => {
  const s = setup()
  let calls = 0
  s.adapter.send = async () => ++calls === 1 ? { ok: true, unconfirmed: true } : { ok: false, code: 'offline' }
  try {
    await s.runtime.send(inbound(), { kind: 'reply', text: 'ABCDEF' })
    const pending = s.runtime.outbox.list()[0] as { unconfirmed?: boolean }
    assert.equal(pending.unconfirmed, true)
    resetStateFile(s.root)
    assert.equal(stateFile(s.root).read<{ items: Array<{ unconfirmed?: boolean }> }>('outbox')!.items[0]?.unconfirmed, true)
  } finally { await s.close() }
})

test('missing task attribution cannot authorize a task reply', async () => {
  const s = setup()
  try {
    assert.deepEqual(await s.runtime.send(inbound(), { kind: 'reply', text: 'private' }, 'missing-task'), [{ ok: false, code: 'task-delivery-blocked' }])
    assert.equal(s.adapter.sent.length, 0)
  } finally { await s.close() }
})

test('a whitespace-only reply cannot create an invalid durable queue entry', async () => {
  const s = setup()
  try {
    assert.deepEqual(await s.runtime.send(inbound(), { kind: 'reply', text: '   ' }), [])
    assert.equal(s.runtime.outbox.list().length, 0)
    resetStateFile(s.root)
    assert.doesNotThrow(() => stateFile(s.root).read('outbox'))
  } finally { await s.close() }
})
