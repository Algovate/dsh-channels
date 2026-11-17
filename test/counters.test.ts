import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createDurableRateLimiter } from '../packages/core/src/inbound/gates.js'
import { DomainCounterStore, FileCounterStore } from '../packages/core/src/store/counters.js'

function store() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-counters-'))
  return { root, instance: new FileCounterStore({ stateRoot: root }) }
}

test('a durable limiter refuses past the limit and remembers across a restart', async () => {
  const { root, instance } = store()
  await instance.load()
  const first = createDurableRateLimiter({ limit: 2, windowMs: 86_400_000, prefix: 'day', store: instance, now: () => 1_000 })
  assert.equal(first.take('sender'), true)
  assert.equal(first.take('sender'), true)
  assert.equal(first.take('sender'), false)

  // A restart builds a new limiter from the same file: the day's quota is spent.
  const reopened = new FileCounterStore({ stateRoot: root })
  await reopened.load()
  const second = createDurableRateLimiter({ limit: 2, windowMs: 86_400_000, prefix: 'day', store: reopened, now: () => 1_000 })
  assert.equal(second.take('sender'), false)
})

test('a new window starts a new count', async () => {
  const { instance } = store()
  await instance.load()
  let now = 0
  const limiter = createDurableRateLimiter({ limit: 1, windowMs: 60_000, prefix: 'minute', store: instance, now: () => now })
  assert.equal(limiter.take('sender'), true)
  assert.equal(limiter.take('sender'), false)
  now = 60_000
  assert.equal(limiter.take('sender'), true, 'the next minute is a different key')
})

test('limit 0 or a non-finite limit means unlimited', async () => {
  const { instance } = store()
  await instance.load()
  const limiter = createDurableRateLimiter({ limit: 0, windowMs: 1000, prefix: 'x', store: instance, now: () => 0 })
  for (let i = 0; i < 5; i += 1) assert.equal(limiter.take('s'), true)
})

test('the domain store reads a cached row and writes through', async () => {
  const rows = new Map<string, { count: number }>()
  const writes: Array<[string, number]> = []
  const table = {
    get: (key: string) => rows.get(key),
    put: async (key: string, value: { count: number }) => {
      rows.set(key, value)
      writes.push([key, value.count])
    },
  }
  const instance = new DomainCounterStore({ table })
  await instance.load()
  assert.equal(instance.get('day:sender:0'), 0)
  instance.set('day:sender:0', 3)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(instance.get('day:sender:0'), 3)
  assert.deepEqual(writes, [['day:sender:0', 3]])

  const another = new DomainCounterStore({ table })
  assert.equal(another.get('day:sender:0'), 3, 'a fresh instance reads the domain row')
})
