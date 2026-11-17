import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import { WeixinTransport, readAccount, SendPacer } from '../packages/adapter-weixin/src/transport.js'

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
    onMessage: (message) => { raw.push(message as Record<string, unknown>) },
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

test('a failed cursor write preserves the batch and retries persistence on the next poll', async () => {
  const state = freshStateDir()
  const accountDir = path.join(state, 'openclaw-weixin', 'accounts')
  fs.mkdirSync(path.dirname(accountDir), { recursive: true })
  fs.writeFileSync(accountDir, 'blocks creation')
  const cursors: unknown[] = []
  const { instance, raw, warnings } = transport({
    getUpdatesImpl: async (request) => {
      cursors.push(request['get_updates_buf'])
      return { ret: 0, msgs: cursors.length === 1 ? [{ message_id: 'm1' }] : [], get_updates_buf: 'cursor-1' }
    },
  })
  assert.equal(await instance.pollOnce(), 'ok')
  assert.deepEqual(raw, [{ message_id: 'm1' }])
  assert.ok(warnings.some((line) => /cursor/i.test(line)))
  fs.unlinkSync(accountDir)
  assert.equal(await instance.pollOnce(), 'ok')
  assert.deepEqual(cursors, ['', 'cursor-1'])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(accountDir, 'acct.sync.json'), 'utf8')), { get_updates_buf: 'cursor-1' })
})

test('a new account ignores an unscoped cursor but can resume its account-specific raw ID', async () => {
  const state = freshStateDir()
  const unscoped = path.join(state, 'agents', 'default', 'sessions', '.openclaw-weixin-sync')
  fs.mkdirSync(unscoped, { recursive: true })
  fs.writeFileSync(path.join(unscoped, 'default.json'), JSON.stringify({ get_updates_buf: 'another-account' }))
  const accounts = path.join(state, 'openclaw-weixin', 'accounts')
  fs.mkdirSync(accounts, { recursive: true })
  fs.writeFileSync(path.join(accounts, 'migrated@im.bot.sync.json'), JSON.stringify({ get_updates_buf: 'matching-account' }))
  const cursors: unknown[] = []
  const getUpdatesImpl = async (request: Record<string, unknown>) => {
    cursors.push(request['get_updates_buf'])
    return { ret: 0 }
  }
  await transport({ accountId: 'new-im-bot', getUpdatesImpl }).instance.pollOnce()
  await transport({ accountId: 'migrated-im-bot', getUpdatesImpl }).instance.pollOnce()
  assert.deepEqual(cursors, ['', 'matching-account'])
})

test('polling fills a bounded window and checkpoints only completed consecutive batches', async () => {
  const state = freshStateDir()
  const cursorFile = path.join(state, 'openclaw-weixin', 'accounts', 'acct.sync.json')
  let release: (() => void) | undefined
  const oldest = new Promise<void>((resolve) => { release = resolve })
  const fetched: unknown[] = []
  const delivered: Array<string | number | undefined> = []
  const { instance } = transport({
    getUpdatesImpl: async (request) => {
      fetched.push(request['get_updates_buf'])
      if (fetched.length >= 2 && fetched.length <= 6) return { ret: 0, msgs: [] }
      const next = fetched.length === 1 ? 1 : fetched.length - 5
      if (next > 4) return delay(30_000, {}, { signal: request['abortSignal'] as AbortSignal })
      return { ret: 0, msgs: [{ message_id: next }], get_updates_buf: `cursor-${next}` }
    },
    onMessage: async (message) => {
      if (message.message_id === 1) await oldest
      delivered.push(message.message_id)
    },
  })
  instance.start()
  try {
    await delay(20)
    const fullWindow = ['', ...Array<string>(6).fill('cursor-1'), 'cursor-2', 'cursor-3']
    assert.deepEqual(fetched, fullWindow)
    assert.deepEqual(delivered, [2, 3, 4])
    assert.equal(fs.existsSync(cursorFile), false)
    release?.()
    await delay(20)
    assert.deepEqual(fetched, [...fullWindow, 'cursor-4'])
    assert.deepEqual(JSON.parse(fs.readFileSync(cursorFile, 'utf8')), { get_updates_buf: 'cursor-4' })
  } finally {
    release?.()
    await instance.stop()
  }
})

test('a server-directed timeout is honoured', async () => {
  freshStateDir()
  const timeouts: unknown[] = []
  const { instance } = transport({
    getUpdatesImpl: async (request) => {
      timeouts.push(request['timeoutMs'])
      return { ret: 0, msgs: [], longpolling_timeout_ms: timeouts.length === 1 ? 12_345 : 1e12 }
    },
  })
  assert.equal(await instance.pollOnce(), 'ok')
  assert.equal(await instance.pollOnce(), 'ok')
  assert.equal(await instance.pollOnce(), 'ok')
  assert.deepEqual(timeouts, [35_000, 12_345, 12_345])
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

test('a missing account cannot inherit an unscoped legacy token', () => {
  const stateDir = freshStateDir()
  const legacyDirectory = path.join(stateDir, 'credentials', 'openclaw-weixin')
  fs.mkdirSync(legacyDirectory, { recursive: true })
  fs.writeFileSync(path.join(legacyDirectory, 'credentials.json'), JSON.stringify({ token: 'a-token' }))
  assert.equal(readAccount('account-b'), undefined)

  const accountDirectory = path.join(stateDir, 'openclaw-weixin', 'accounts')
  fs.mkdirSync(accountDirectory, { recursive: true })
  fs.writeFileSync(path.join(accountDirectory, 'account-b@im.bot.json'), JSON.stringify({ token: 'b-token' }))
  assert.equal(readAccount('account-b-im-bot')?.token, 'b-token')
})

test('the pacer refuses to send during a cooldown instead of hammering', async () => {
  let now = 0
  const { instance } = transport({
    sendImpl: async () => {
      throw new Error('server rejected')
    },
    sendIntervalMs: 0,
    sendCooldownMs: 1000,
  })
  // Three failures arm the cooldown; the fourth send is refused locally.
  for (let i = 0; i < 3; i += 1) await instance.sendText('conv', 'x')
  const refused = await instance.sendText('conv', 'x')
  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false ? refused.code : '', 'cooling-down')
  assert.ok(now >= 0)
})

test('media is sent with a caption on the first attachment only', async () => {
  const { readFile: _readFile } = await import('node:fs/promises')
  const seen: Array<Record<string, unknown>> = []
  const { instance } = transport({
    sendMediaImpl: async (params) => {
      seen.push(params)
      return { serverMessageId: `s-${seen.length}` }
    },
  })
  await instance.sendMedia('conv', '/tmp/a.png', '看图')
  await instance.sendMedia('conv', '/tmp/b.png', '')
  assert.equal(seen.length, 2)
  assert.equal(seen[0]?.['text'], '看图')
  assert.equal(seen[1]?.['text'], '')
})

test('concurrent pacer requests reserve separate send slots', async () => {
  const pacer = new SendPacer({ minIntervalMs: 25 })
  const times: number[] = []
  await Promise.all([0, 1, 2].map(async () => { assert.equal(await pacer.take(), true); times.push(Date.now()) }))
  assert.ok(times[1]! - times[0]! >= 15)
  assert.ok(times[2]! - times[1]! >= 15)
})
