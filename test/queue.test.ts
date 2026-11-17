import assert from 'node:assert/strict'
import test from 'node:test'

import { ConversationQueue } from '../packages/core/src/inbound/queue.js'

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

test('one conversation never runs two tasks at once', async () => {
  const queue = new ConversationQueue()
  const order: string[] = []
  const slow = queue.push('a', async () => {
    order.push('slow:start')
    await tick(20)
    order.push('slow:end')
  })
  const next = queue.push('a', async () => {
    order.push('next')
  })
  await Promise.all([slow, next])
  assert.deepEqual(order, ['slow:start', 'slow:end', 'next'])
})

test('different conversations run in parallel', async () => {
  const queue = new ConversationQueue()
  const order: string[] = []
  const first = queue.push('a', async () => {
    order.push('a:start')
    await tick(30)
    order.push('a:end')
  })
  const second = queue.push('b', async () => {
    order.push('b:start')
    await tick(5)
    order.push('b:end')
  })
  await Promise.all([first, second])
  assert.deepEqual(order, ['a:start', 'b:start', 'b:end', 'a:end'])
})

test('a failing task still lets the next one run, and the failure reaches the caller', async () => {
  const queue = new ConversationQueue()
  const failed = queue.push('a', async () => {
    throw new Error('boom')
  })
  const after = queue.push('a', async () => 'after')
  await assert.rejects(failed, /boom/)
  assert.equal(await after, 'after')
})

test('abort reaches the running task through its signal', async () => {
  const queue = new ConversationQueue()
  let seen: string | undefined
  const running = queue.push('a', async (signal) => {
    await tick(20)
    seen = signal.aborted ? 'aborted' : 'live'
  })
  await tick(1) // let the first task start before cancelling it
  const queued = queue.push('a', async () => assert.fail('cancelled work ran'))
  queue.abort('a', 'stop')
  await assert.rejects(queued, (reason) => reason === 'stop')
  await running
  assert.equal(seen, 'aborted')
})
