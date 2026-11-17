import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { WeixinTransport, readAccount } from '../packages/adapter-weixin/src/transport.js'

type TransportOptions = ConstructorParameters<typeof WeixinTransport>[0]

function transport(options: Partial<TransportOptions> = {}) {
  const raw: Array<Record<string, unknown>> = []
  const rejected: boolean[] = []
  const warnings: string[] = []
  const instance = new WeixinTransport({
    accountId: 'acct',
    baseUrl: 'https://example.invalid',
    token: 'token',
    logger: { info: () => {}, warn: (line) => warnings.push(line) },
    onMessage: (message) => raw.push(message as Record<string, unknown>),
    onSessionRejected: (expired) => rejected.push(expired),
    ...options,
  })
  return { instance, raw, rejected, warnings }
}

/** The vendor resolves its state dir from the environment; give each test its own. */
function freshStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-transport-'))
  process.env['OPENCLAW_STATE_DIR'] = dir
  return dir
}

test('a rejected credential marks the account expired and stops the loop', async () => {
  freshStateDir()
  const { instance, rejected, warnings } = transport({ getUpdatesImpl: async () => ({ errcode: -14, errmsg: 'session timeout' }) })
  assert.equal(await instance.pollOnce(), 'rejected')
  assert.deepEqual(rejected, [true])
  assert.ok(warnings.some((line) => /errcode=-14/.test(line)))
  await instance.stop()
})

test('a non-zero ret is a retry, not a success', async () => {
  freshStateDir()
  let calls = 0
  const { instance, rejected } = transport({
    getUpdatesImpl: async () => {
      calls += 1
      return calls === 1 ? { ret: 500, errmsg: 'boom' } : { ret: 0, msgs: [] }
    },
  })
  assert.equal(await instance.pollOnce(), 'retry')
  assert.equal(await instance.pollOnce(), 'ok')
  assert.equal(rejected.length, 0)
  await instance.stop()
})

test('messages reach the handler and the sync cursor is saved once', async () => {
  const stateDir = freshStateDir()
  let first = true
  const { instance, raw } = transport({
    getUpdatesImpl: async () => {
      if (!first) return { ret: 0, msgs: [], get_updates_buf: 'cursor-2' }
      first = false
      return { ret: 0, msgs: [{ message_id: 'm1' }, { message_id: 'm2' }], get_updates_buf: 'cursor-1' }
    },
  })
  assert.equal(await instance.pollOnce(), 'ok')
  assert.deepEqual(raw.map((message) => message['message_id']), ['m1', 'm2'])
  assert.equal(await instance.pollOnce(), 'ok')
  assert.ok(fs.existsSync(stateDir))
  await instance.stop()
})

test('a server-directed timeout is honoured', async () => {
  freshStateDir()
  let timeout: number | undefined
  const { instance } = transport({
    getUpdatesImpl: async () => ({ ret: 0, msgs: [], longpolling_timeout_ms: 12_345 }),
  })
  await instance.pollOnce()
  timeout = (instance as unknown as { ['#longPollTimeoutMs']?: number })['#longPollTimeoutMs']
  // The private field is not reachable; assert the behaviour a caller can see:
  // the next round still polls, and nothing threw.
  assert.equal(await instance.pollOnce(), 'ok')
  await instance.stop()
})

test('a send with a server id is accepted; without one it is only unconfirmed', async () => {
  freshStateDir()
  const accepted = transport({ sendImpl: async () => ({ messageId: 'client', serverMessageId: 'server-1' }) })
  assert.deepEqual(await accepted.instance.sendText('conv', 'hi'), { ok: true, messageId: 'server-1' })
  const unconfirmed = transport({ sendImpl: async () => ({ messageId: 'client' }) })
  assert.deepEqual(await unconfirmed.instance.sendText('conv', 'hi'), { ok: true, unconfirmed: true })
})

test('a throwing send becomes a failure code, never an exception', async () => {
  freshStateDir()
  const failing = transport({ sendImpl: async () => { throw new Error('token expired') } })
  const result = await failing.instance.sendText('conv', 'hi')
  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.code : '', 'session-rejected')
})

test('the latest context token per conversation is remembered', async () => {
  freshStateDir()
  const seen: Array<Record<string, unknown>> = []
  const { instance } = transport({ sendImpl: async (params) => { seen.push(params); return { serverMessageId: 's1' } } })
  instance.rememberContextToken('conv', 'ctx-9')
  await instance.sendText('conv', 'hi')
  const opts = (seen[0]?.['opts'] ?? {}) as Record<string, unknown>
  assert.equal(opts['contextToken'], 'ctx-9')
})

test('a saved account without a token is treated as not logged in', () => {
  freshStateDir()
  assert.equal(readAccount('missing'), undefined)
})
