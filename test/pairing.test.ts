import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { createFakeAdapter, createChannelsRuntime } from './runtime-helper.js'
import { createHarness, inbound } from './harness.js'

const tick = (ms = 0) => delay(ms)

test('an unknown sender becomes a pending request with one notice, not a log hunt', async () => {
  const h = createHarness()
  const runtime = createChannelsRuntime({ ctx: h.ctx, config: { allowedSenders: [] } })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  try {
    assert.equal(runtime.canReceive(inbound({ senderId: 'stranger', text: 'hello' })), false)
    await tick(20)
    assert.equal(runtime.pendingPairings().length, 1)
    assert.equal(adapter.sent.filter((entry) => entry.outgoing.text?.includes('尚未获准')).length, 1)
    // A second attempt inside the notice window does not spam the stranger.
    runtime.dispatch(inbound({ senderId: 'stranger', text: 'again' }))
    await tick(20)
    assert.equal(runtime.pendingPairings().length, 1)
    assert.equal(adapter.sent.filter((entry) => entry.outgoing.text?.includes('尚未获准')).length, 1)
    assert.equal(h.followedUp.length, 0)
  } finally { await runtime.dispose() }
})

test('approving a pending sender persists the allowlist before it takes effect', async () => {
  const h = createHarness()
  const runtime = createChannelsRuntime({ ctx: h.ctx, config: { allowedSenders: [] } })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  try {
    runtime.dispatch(inbound({ senderId: 'stranger', text: 'let me in' }))
    await tick(10)
    const pairing = runtime.pendingPairings()[0]!
    let patch: { allowedSenders?: string[]; allowlistPerAccount?: Record<string, string[]> } | undefined
    const result = runtime.resolvePairing(pairing.id, 'approve', (value) => { patch = value; return true })
    assert.deepEqual(result, { ok: true, senderId: 'stranger' })
    assert.deepEqual(patch, { allowedSenders: ['stranger'] })
    assert.deepEqual(runtime.config.allowedSenders, ['stranger'])
    assert.equal(runtime.pendingPairings().length, 0)
    assert.equal(runtime.dispatch(inbound({ senderId: 'stranger', text: 'now allowed' })).allow, true)
    await tick(20)
    assert.equal(adapter.sent.some((entry) => entry.outgoing.text?.includes('已获准')), true)
  } finally { await runtime.dispose() }
})

test('an account-scoped allowlist keeps its override when a pairing is approved', async () => {
  const h = createHarness()
  const runtime = createChannelsRuntime({ ctx: h.ctx, config: { allowedSenders: ['sender'], allowlistPerAccount: { acct: [] } } })
  runtime.register(createFakeAdapter())
  try {
    runtime.dispatch(inbound({ senderId: 'stranger', text: 'scoped' }))
    await tick(10)
    const pairing = runtime.pendingPairings()[0]!
    let patch: { allowedSenders?: string[]; allowlistPerAccount?: Record<string, string[]> } | undefined
    assert.ok(runtime.resolvePairing(pairing.id, 'approve', (value) => { patch = value; return true }))
    assert.deepEqual(patch, { allowlistPerAccount: { acct: ['stranger'] } })
    assert.deepEqual(runtime.config.allowlistPerAccount['acct'], ['stranger'])
    assert.equal(runtime.resolvePairing(pairing.id, 'deny'), undefined, 'an approved request is no longer pending')
  } finally { await runtime.dispose() }
})

test('a failed allowlist write does not approve or consume the request', async () => {
  const h = createHarness()
  const runtime = createChannelsRuntime({ ctx: h.ctx, config: { allowedSenders: [] } })
  runtime.register(createFakeAdapter())
  try {
    runtime.dispatch(inbound({ senderId: 'stranger' }))
    await tick(10)
    const pairing = runtime.pendingPairings()[0]!
    assert.equal(runtime.resolvePairing(pairing.id, 'approve', () => false), undefined)
    assert.deepEqual(runtime.config.allowedSenders, [])
    assert.equal(runtime.pendingPairings().length, 1)
  } finally { await runtime.dispose() }
})

test('denying a pending sender removes it without widening access', async () => {
  const h = createHarness()
  const runtime = createChannelsRuntime({ ctx: h.ctx, config: { allowedSenders: [] } })
  runtime.register(createFakeAdapter())
  try {
    runtime.dispatch(inbound({ senderId: 'stranger' }))
    await tick(10)
    const pairing = runtime.pendingPairings()[0]!
    assert.deepEqual(runtime.resolvePairing(pairing.id, 'deny'), { ok: true, senderId: 'stranger' })
    assert.deepEqual(runtime.config.allowedSenders, [])
    assert.equal(runtime.pendingPairings().length, 0)
  } finally { await runtime.dispose() }
})
