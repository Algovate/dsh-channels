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
  assert.equal(adapter.capabilities.maxTextChars > 0, true)
  assert.equal(typeof adapter.start, 'function')
  assert.equal(typeof adapter.stop, 'function')
  assert.equal(typeof adapter.send, 'function')
  assert.equal(typeof adapter.onInbound, 'function')

})

test('a missing token is a clear error, not a half-started adapter', async () => {
  await assert.rejects(createTelegram({ stateRoot: '/tmp', config: {} }), /no Telegram bot token/)
})
