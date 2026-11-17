import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAdapter as createTelegram } from '../packages/adapter-telegram/src/index.js'

/**
 * The point of the adapter seam: a second channel is a different package that
 * the core accepts without knowing it — no core change, no WeChat code shared.
 * These assertions are structural on purpose; behaviour is covered per adapter.
 */
const silent = { info: () => {}, warn: () => {} }

test('the Telegram adapter satisfies the same contract the core registers', async () => {
  const adapter = await createTelegram({
    stateRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'channels-tg-')),
    config: {
      token: '123:test-token',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: [] }) }),
    },
  })
  assert.equal(adapter.id, 'telegram')
  assert.deepEqual(adapter.label, { zh: '电报', en: 'Telegram' })
  assert.equal(adapter.capabilities.text, true)
  assert.equal(adapter.capabilities.maxTextChars > 0, true)
  assert.equal(typeof adapter.start, 'function')
  assert.equal(typeof adapter.stop, 'function')
  assert.equal(typeof adapter.send, 'function')
  assert.equal(typeof adapter.onInbound, 'function')
  assert.equal(adapter.interactions.format, 'numbered')

  // The numbered prompt the core would render for a question.
  const rendered = adapter.interactions.render({
    id: 'q1',
    kind: 'question',
    conversation: { channel: 'telegram', accountId: 'bot', conversationId: '7' },
    title: '选一个',
    options: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }],
    expiresAt: Date.now() + 60_000,
  })
  assert.match(rendered.text ?? '', /1\. 甲/)
  assert.deepEqual(adapter.interactions.parse('2', {
    id: 'q1',
    kind: 'question',
    conversation: { channel: 'telegram', accountId: 'bot', conversationId: '7' },
    title: '选一个',
    options: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }],
    expiresAt: Date.now() + 60_000,
  }), { value: 'b' })
})

test('a missing token is a clear error, not a half-started adapter', async () => {
  await assert.rejects(createTelegram({ stateRoot: '/tmp', config: {} }), /no Telegram bot token/)
})
