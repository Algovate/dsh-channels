import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseLiveSettingsPatch } from '../packages/core/src/live-settings.js'
import { copyBounded } from '../packages/core/src/file-copy.js'
import { readSessionEvents, type SessionPersistence } from '../packages/core/src/session-reader.js'

test('live settings retain known fields and reject invalid values', () => {
  assert.deepEqual(parseLiveSettingsPatch({ senderPerMinute: 0, senderPerDay: 100000, autoSendFiles: false, unknown: true }), { senderPerMinute: 0, senderPerDay: 100000, autoSendFiles: false })
  assert.deepEqual(parseLiveSettingsPatch({ senderPerMinute: undefined, unknown: true }), {})
  for (const value of [-1, 100001, 1.5, NaN, Infinity, '1', null]) assert.throws(() => parseLiveSettingsPatch({ senderPerMinute: value }), /must be an integer/)
  for (const key of ['autoSendFiles', 'questionsEnabled', 'approvalsEnabled']) {
    assert.deepEqual(parseLiveSettingsPatch({ [key]: true }), { [key]: true })
    assert.throws(() => parseLiveSettingsPatch({ [key]: 1 }), /must be a boolean/)
  }
})

test('bounded descriptor copying handles multiple chunks, exact limits, overflow and empty files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'channel-copy-test-'))
  try {
    for (const [size, limit, valid] of [[131073, 131073, true], [131073, 131072, false], [0, 10, false]] as const) {
      const bytes = Buffer.alloc(size, 73)
      await fs.writeFile(path.join(root, 'source'), bytes)
      const source = await fs.open(path.join(root, 'source'), 'r')
      const destination = await fs.open(path.join(root, 'destination'), 'w')
      try {
        if (valid) { await copyBounded(source, destination, limit); assert.deepEqual(await fs.readFile(path.join(root, 'destination')), bytes) }
        else await assert.rejects(copyBounded(source, destination, limit))
        // The helper does not own the descriptors.
        await source.stat(); await destination.stat()
      } finally { await source.close(); await destination.close() }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('session reader closes on early completion, invalid cwd, cancellation and stalled pages; bounds reads', async () => {
  let closed = 0; let reads = 0
  const controller = new AbortController()
  let cwd = process.cwd(); let stalled = false; let abort = false
  const persistence: SessionPersistence = { async open() { return { header: { cwd }, async read(offset, length) {
    reads++; assert.equal(length, 256)
    if (abort) controller.abort()
    return { events: stalled ? [{ seq: offset - 1 }] : Array.from({ length }, (_, index) => ({ seq: offset + index })) }
  }, async close() { closed++ } } } }
  for await (const _event of readSessionEvents(persistence, 's', process.cwd(), 0, controller.signal)) break
  assert.equal(closed, 1); assert.equal(reads, 1)
  reads = 0
  let count = 0
  for await (const _event of readSessionEvents(persistence, 's', process.cwd(), 0, controller.signal)) count++
  assert.equal(reads, 16); assert.equal(count, 4096); assert.equal(closed, 2)
  const consume = async () => { for await (const _event of readSessionEvents(persistence, 's', process.cwd(), 0, controller.signal)) {} }
  stalled = true
  await assert.rejects(consume(), /did not advance/); assert.equal(closed, 3)
  stalled = false; cwd = os.tmpdir()
  await assert.rejects(consume(), /directory/); assert.equal(closed, 4)
  cwd = process.cwd(); abort = true
  await assert.rejects(consume(), /abort/i); assert.equal(closed, 5)
})

test('session reader stops and closes when aborted between buffered events', async () => {
  const controller = new AbortController()
  let closed = false
  const persistence: SessionPersistence = { async open() { return {
    header: { cwd: process.cwd() },
    async read() { return { events: [{ seq: 0 }, { seq: 1 }] } },
    async close() { closed = true },
  } } }
  const reader = readSessionEvents(persistence, 's', process.cwd(), 0, controller.signal)
  assert.deepEqual(await reader.next(), { done: false, value: { seq: 0 } })
  controller.abort()
  await assert.rejects(reader.next(), /abort/i)
  assert.equal(closed, true)
})
