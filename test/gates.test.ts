import assert from 'node:assert/strict'
import test from 'node:test'

import { createRateLimiter, gateMessage, type GateContext } from '../packages/core/src/inbound/gates.js'
import { inbound } from './harness.js'

function context(overrides: Partial<GateContext> = {}): GateContext {
  return {
    expiredAccounts: new Set<string>(),
    allowlistFor: () => ['sender'],
    allowedChats: [],
    minute: createRateLimiter({ limit: 0, windowMs: 60_000 }),
    day: createRateLimiter({ limit: 0, windowMs: 86_400_000 }),
    keyOf: (message) => `${message.accountId}|${message.senderId}`,
    ...overrides,
  }
}

test('an empty allowlist denies everyone', () => {
  const decision = gateMessage(inbound(), context({ allowlistFor: () => [] }))
  assert.deepEqual(decision, { allow: false, reason: 'not-allowed', detail: '0 allowed sender(s)' })
})

test('an expired account is refused before the allowlist is even read', () => {
  const decision = gateMessage(inbound(), context({ expiredAccounts: new Set(['acct']), allowlistFor: () => { throw new Error('must not be read') } }))
  assert.deepEqual(decision, { allow: false, reason: 'not-logged-in' })
})

test('an allowed sender in a disallowed conversation is refused', () => {
  const decision = gateMessage(inbound({ conversationId: 'other' }), context({ allowedChats: ['conv'] }))
  assert.deepEqual(decision, { allow: false, reason: 'chat-not-allowed' })
})

test('the minute gate fires before the day gate and names itself', () => {
  const minute = createRateLimiter({ limit: 1, windowMs: 60_000 })
  const day = createRateLimiter({ limit: 10, windowMs: 86_400_000 })
  const ctx = context({ minute, day })
  assert.deepEqual(gateMessage(inbound(), ctx), { allow: true })
  assert.deepEqual(gateMessage(inbound(), ctx), { allow: false, reason: 'rate-minute' })
})

test('a per-minute allowance does not reset the day allowance', () => {
  let now = 0
  const minute = createRateLimiter({ limit: 100, windowMs: 60_000, now: () => now })
  const day = createRateLimiter({ limit: 2, windowMs: 86_400_000, now: () => now })
  const ctx = context({ minute, day })
  assert.equal(gateMessage(inbound(), ctx).allow, true)
  now += 61_000
  assert.equal(gateMessage(inbound(), ctx).allow, true)
  assert.deepEqual(gateMessage(inbound(), ctx), { allow: false, reason: 'rate-day' })
})

test('a zero limit disables the limiter', () => {
  const limiter = createRateLimiter({ limit: 0, windowMs: 1000 })
  for (let i = 0; i < 50; i += 1) assert.equal(limiter.take('k'), true)
})
