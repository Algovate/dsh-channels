import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createChannelsRuntime } from './runtime-helper.js'
import { createHarness, inbound } from './harness.js'

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

test('a new per-minute limit applies to the next message, without a restart', () => {
  const h = createHarness({ reply: '在' })
  const runtime = createChannelsRuntime({ ctx: h.ctx, config: { allowedSenders: ['sender'], senderPerMinute: 5 } })
  assert.equal(runtime.dispatch(inbound({ text: 'a' })).allow, true)
  runtime.updateSettings({ senderPerMinute: 1 })
  assert.equal(runtime.dispatch(inbound({ text: 'b' })).allow, false, 'the second message is over the new limit')
  runtime.dispose()
})

test('a limit of zero means unlimited', () => {
  const h = createHarness({ reply: '在' })
  const runtime = createChannelsRuntime({ ctx: h.ctx, config: { allowedSenders: ['sender'], senderPerMinute: 1 } })
  runtime.updateSettings({ senderPerMinute: 0 })
  for (let i = 0; i < 5; i += 1) assert.equal(runtime.dispatch(inbound({ text: `m${i}` })).allow, true)
  runtime.dispose()
})

test('the live settings mirror what the card should show', () => {
  const h = createHarness()
  const runtime = createChannelsRuntime({ ctx: h.ctx, config: { autoSendFiles: false, questionsEnabled: true, approvalsEnabled: false } })
  assert.deepEqual(runtime.liveSettings(), {
    senderPerMinute: 6,
    senderPerDay: 60,
    autoSendFiles: false,
    questionsEnabled: true,
    approvalsEnabled: false,
  })
  runtime.updateSettings({ autoSendFiles: true, senderPerDay: 42 })
  assert.equal(runtime.liveSettings().autoSendFiles, true)
  assert.equal(runtime.liveSettings().senderPerDay, 42)
  runtime.dispose()
})
