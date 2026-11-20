import assert from 'node:assert/strict'
import test from 'node:test'

import { canBypassPolicy, groupText } from '../packages/core/src/inbound/policy.js'
import type { ChannelsConfig } from '../packages/core/src/config.js'
import { inbound } from './harness.js'

const config = (overrides: Partial<ChannelsConfig> = {}): ChannelsConfig => ({
  ...({
    enabled: true, allowedSenders: [], owners: [], groupTrigger: 'prefix', groupPrefix: '/ask', groupMention: '',
    allowlistPerAccount: {}, allowedChats: [], adapters: [], adapterConfig: {}, maxTextChars: 600, bubbleGapMs: 0,
    maxTurnWaitMs: 1000, turnPollMs: 1, senderPerMinute: 0, senderPerDay: 0, questionsEnabled: true,
    approvalsEnabled: true, interactionTimeoutMs: 1000, autoSendFiles: false, maxProducedFiles: 1,
    maxProducedBytes: 1024, workingDirectory: '/tmp', projects: {},
  } as ChannelsConfig),
  ...overrides,
})

test('pair chats are always addressed and unchanged', () => {
  assert.deepEqual(groupText(inbound({ group: false, text: '/ask hi' }), config(), false), { addressed: true, text: '/ask hi' })
})

test('prefix mode strips only the configured prefix and ignores others', () => {
  const c = config()
  assert.deepEqual(groupText(inbound({ group: true, text: '/ask   check' }), c, false), { addressed: true, text: 'check' })
  assert.deepEqual(groupText(inbound({ group: true, text: '/ask\ncheck' }), c, false), { addressed: true, text: 'check' })
  assert.deepEqual(groupText(inbound({ group: true, text: 'hello' }), c, false), { addressed: false, text: 'hello' })
  assert.deepEqual(groupText(inbound({ group: true, text: '/asking' }), c, false), { addressed: false, text: '/asking' })
})

test('mention mode accepts the handle case-insensitively and needs a boundary', () => {
  const c = config({ groupTrigger: 'mention', groupMention: '@My_Bot' })
  assert.deepEqual(groupText(inbound({ group: true, text: '@my_bot check' }), c, false), { addressed: true, text: 'check' })
  assert.deepEqual(groupText(inbound({ group: true, text: '@my_bot: check' }), c, false), { addressed: true, text: ': check' }, 'only the handle is stripped')
  assert.equal(groupText(inbound({ group: true, text: '@my_botx check' }), c, false).addressed, false)
  // The prefix still works in mention mode.
  assert.deepEqual(groupText(inbound({ group: true, text: '/ask check' }), c, false), { addressed: true, text: 'check' })
})

test('an unaddressed group message may still answer a waiting interaction', () => {
  assert.deepEqual(groupText(inbound({ group: true, text: '1' }), config(), true), { addressed: true, text: '1' })
})

test('only controls, approval replies and waiting answers bypass the media queue', () => {
  const c = config()
  assert.equal(canBypassPolicy(inbound({ text: '/cancel' }), c, false), true)
  assert.equal(canBypassPolicy(inbound({ text: '/status' }), c, false), true)
  assert.equal(canBypassPolicy(inbound({ text: 'a1b2c3 1' }), c, false), true)
  assert.equal(canBypassPolicy(inbound({ text: 'ordinary task' }), c, false), false)
  assert.equal(canBypassPolicy(inbound({ text: 'ordinary task' }), c, true), true)
  assert.equal(canBypassPolicy(inbound({ group: true, text: '/cancel' }), c, false), false, 'a group control still needs addressing')
})
