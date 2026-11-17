import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import type { InboundMessage } from '@derekluo/dsh-channels'
import { createAdapter } from '../packages/adapter-telegram/src/index.js'
import { mediaOf, normalizeInbound } from '../packages/adapter-telegram/src/normalize.js'
import { TelegramTransport } from '../packages/adapter-telegram/src/transport.js'
import { resolveConfig } from '../packages/core/src/config.js'
import { ChannelsRuntime } from '../packages/core/src/runtime.js'
import { FileCounterStore } from '../packages/core/src/store/counters.js'

const silent = { info: () => {}, warn: () => {} }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const baseUpdate = {
  update_id: 10,
  message: {
    message_id: 5,
    date: 1_700_000_000,
    text: '你好',
    from: { id: 7, is_bot: false, username: 'alice' },
    chat: { id: 7, type: 'private', username: 'alice' },
  },
}

test('a private text message becomes one normalized message', () => {
  const message = normalizeInbound(baseUpdate as never, 'bot')
  assert.ok(message !== null)
  assert.equal(message.channel, 'telegram')
  assert.equal(message.accountId, 'bot')
  assert.equal(message.conversationId, '7')
  assert.equal(message.senderId, '7')
  assert.equal(message.text, '你好')
  assert.equal(message.group, false)
  assert.equal(message.media.length, 0)
  assert.equal(message.at, 1_700_000_000_000)
})

test('a group message is marked as one', () => {
  const message = normalizeInbound({
    message: { ...baseUpdate.message, chat: { id: -1001, type: 'supergroup', title: 'Team' } },
  } as never, 'bot')
  assert.equal(message?.group, true)
  assert.equal(message?.conversationId, '-1001')
})

test('edits, channel posts, bot messages and empty messages are refused', () => {
  assert.equal(normalizeInbound({ message: { ...baseUpdate.message, edit_date: 1 } } as never, 'bot'), null)
  assert.equal(normalizeInbound({ channel_post: baseUpdate.message } as never, 'bot'), null)
  assert.equal(normalizeInbound({ message: { ...baseUpdate.message, from: { id: 9, is_bot: true } } } as never, 'bot'), null)
  assert.equal(normalizeInbound({ message: { ...baseUpdate.message, text: undefined } } as never, 'bot'), null)
})

test('a caption carries the words of a photo message', () => {
  const message = normalizeInbound({
    message: {
      ...baseUpdate.message,
      text: undefined,
      caption: '看看这张',
      photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'big', file_size: 900 }],
    },
  } as never, 'bot')
  assert.equal(message?.text, '看看这张')
  const media = mediaOf({ ...baseUpdate.message, photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'big', file_size: 900 }] } as never)
  assert.deepEqual(media.map((item) => item.fileId), ['big'], 'only the largest size is downloaded')
})

test('documents, voice notes and videos are described with their mime', () => {
  const media = mediaOf({
    document: { file_id: 'd', file_name: '合同.pdf', mime_type: 'application/pdf', file_size: 1200 },
    voice: { file_id: 'v', mime_type: 'audio/ogg', file_size: 300 },
    video: { file_id: 'm', mime_type: 'video/mp4', file_size: 9000 },
  } as never)
  assert.deepEqual(media.map((item) => [item.kind, item.fileId, item.mime]), [
    ['file', 'd', 'application/pdf'],
    ['voice', 'v', 'audio/ogg'],
    ['video', 'm', 'video/mp4'],
  ])
})

test('one poll advances the offset so a restart does not replay', async () => {
  const calls: Array<Record<string, unknown>> = []
  const transport = new TelegramTransport({
    token: 't',
    logger: silent,
    fetchImpl: async (_url, init) => {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
      calls.push(body ?? {})
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: [{ update_id: 41, message: {} }, { update_id: 42, message: {} }] }),
      }
    },
  })
  assert.equal((await transport.pollOnce()).length, 2)
  assert.equal(calls[0]?.['offset'], undefined, 'the first poll asks for everything')
  await transport.pollOnce()
  assert.equal(calls[1]?.['offset'], 43, 'the next poll starts after the last update seen')
})

test('a failed poll throws with the server description and keeps the offset', async () => {
  const transport = new TelegramTransport({
    token: 't',
    logger: silent,
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 5 } }) }),
  })
  await assert.rejects(transport.pollOnce(), /Too Many Requests/)
})

test('sending reports the message id, and a rate limit carries a retry delay', async () => {
  const transport = new TelegramTransport({
    token: 't',
    logger: silent,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string }
      if (body.text === 'slow') {
        return { ok: true, status: 200, json: async () => ({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 99 } }) }
    },
  })
  assert.deepEqual(await transport.sendText('7', 'hi'), { ok: true, messageId: '99' })
  const refused = await transport.sendText('7', 'slow')
  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false ? refused.code : '', 'rate-limited')
  assert.equal(refused.ok === false ? refused.retryAfterMs : 0, 3000)
})

test('a thrown send is a value, not an exception', async () => {
  const transport = new TelegramTransport({
    token: 't',
    logger: silent,
    fetchImpl: async () => {
      throw new Error('network down')
    },
  })
  const result = await transport.sendText('7', 'hi')
  assert.deepEqual(result, { ok: false, code: 'send-failed', detail: 'network down' })
})

test('stop aborts a long poll already waiting for its response body', async () => {
  const started = deferred<void>()
  const body = deferred<unknown>()
  let signal: unknown
  const adapter = await createAdapter({
    config: { token: '123:secret', mediaEnabled: false, fetchImpl: async (_url, init) => {
      signal = init?.signal
      return { ok: true, status: 200, json: () => { started.resolve(); return body.promise } }
    } },
  })
  await adapter.start()
  await started.promise
  const stopping = adapter.stop()
  try {
    assert.equal(await Promise.race([stopping.then(() => 'stopped'), delay(100, 'waiting')]), 'stopped')
    assert.ok(signal instanceof AbortSignal && signal.aborted)
  } finally {
    body.resolve({ ok: true, result: [] })
    await stopping
  }
})

test('a stalled send has a deadline even after receiving its response headers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const started = deferred<void>()
  const body = deferred<unknown>()
  let signal: unknown
  const transport = new TelegramTransport({
    token: '123:secret', logger: silent, fetchImpl: async (_url, init) => {
      signal = init?.signal
      return { ok: true, status: 200, json: () => { started.resolve(); return body.promise } }
    },
  })
  const result = transport.sendText('7', 'hi')
  await started.promise
  t.mock.timers.tick(120_000)
  await new Promise<void>((resolve) => setImmediate(resolve))
  try {
    assert.ok(signal instanceof AbortSignal && signal.aborted, 'the request exceeded its deadline')
    assert.equal((await result).ok, false)
  } finally {
    body.resolve({ ok: true, result: { message_id: 1 } })
  }
})

test('downloads cancel a stream as soon as it exceeds the file cap', async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-download-'))
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }))
  let cancelled = false
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  const nextPoll = deferred<Response>()
  const delivered = deferred<number>()
  let first = true
  const adapter = await createAdapter({
    stateRoot,
    config: { token: '123:secret', maxInboundBytes: 5, fetchImpl: async (url) => {
      if (url.endsWith('/getUpdates')) {
        if (!first) return nextPoll.promise
        first = false
        return Response.json({ ok: true, result: [{ ...baseUpdate, message: { ...baseUpdate.message, document: { file_id: 'd' } } }] })
      }
      if (url.endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: 'file' } })
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller
          controller.enqueue(new Uint8Array([1, 2, 3]))
          controller.enqueue(new Uint8Array([4, 5, 6]))
        },
        cancel() { cancelled = true },
      }))
    } },
  })
  adapter.onInbound((message) => delivered.resolve(message.media.length))
  await adapter.start()
  try {
    assert.equal(await Promise.race([delivered.promise, delay(100, 'stalled')]), 0)
    assert.equal(cancelled, true)
  } finally {
    const stopping = adapter.stop()
    if (!cancelled) stream?.close()
    nextPoll.resolve(Response.json({ ok: true, result: [] }))
    await stopping
  }
})

test('a failed update does not drop the next update in the same poll', async () => {
  const delivered = deferred<string>()
  const nextPoll = deferred<Response>()
  let first = true
  const adapter = await createAdapter({
    config: { token: '123:secret', mediaEnabled: false, fetchImpl: async () => {
      if (!first) return nextPoll.promise
      first = false
      return Response.json({ ok: true, result: [baseUpdate, { update_id: 11, message: { ...baseUpdate.message, text: 'later' } }] })
    } },
  })
  adapter.onInbound((message) => {
    if (message.text === baseUpdate.message.text) throw new Error('handler failed')
    delivered.resolve(message.text)
  })
  await adapter.start()
  try {
    assert.equal(await Promise.race([delivered.promise, delay(100, 'not delivered')]), 'later')
  } finally {
    const stopping = adapter.stop()
    nextPoll.resolve(Response.json({ ok: true, result: [] }))
    await stopping
  }
})

test('an ineligible inbound message never makes an attachment request', async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-media-'))
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }))
  const requests: string[] = []
  const delivered = deferred<InboundMessage>()
  const nextPoll = deferred<Response>()
  let admitted: InboundMessage | undefined
  let first = true
  const runtime = {
    logger: silent,
    canReceive(message: InboundMessage, hasAttachments: boolean) {
      if (message.senderId === '7') return false
      assert.equal(hasAttachments, true)
      admitted = message
      return true
    },
  }
  const adapter = await createAdapter({
    runtime,
    stateRoot,
    config: { token: '123:secret', fetchImpl: async (url, init) => {
      if (url.endsWith('/getFile')) {
        const fileId = JSON.parse(String(init?.body)).file_id as string
        requests.push(fileId)
        return Response.json({ ok: true, result: { file_path: fileId } })
      }
      if (!url.endsWith('/getUpdates')) return new Response('contents')
      if (!first) return nextPoll.promise
      first = false
      return Response.json({ ok: true, result: [
        { ...baseUpdate, message: { ...baseUpdate.message, document: { file_id: 'denied' } } },
        { update_id: 11, message: { ...baseUpdate.message, from: { id: 8 }, document: { file_id: 'allowed' } } },
      ] })
    } },
  })
  adapter.onInbound((message) => delivered.resolve(message))
  await adapter.start()
  try {
    const message = await Promise.race([delivered.promise, delay(100)])
    assert.ok(message)
    assert.deepEqual(requests, ['allowed'])
    assert.equal(message, admitted, 'enrichment preserves the message admission')
    assert.ok(message.media[0])
    assert.equal(fs.readFileSync(message.media[0].path, 'utf8'), 'contents')
  } finally {
    const stopping = adapter.stop()
    nextPoll.resolve(Response.json({ ok: true, result: [] }))
    await stopping
  }
})

test('restarting mid-batch lets the interrupted Telegram update use the remaining quota', async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-replay-'))
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }))
  const updates = [
    { ...baseUpdate, message: { ...baseUpdate.message, text: '/help' } },
    { update_id: 11, message: { ...baseUpdate.message, message_id: 6, text: undefined, caption: '/whoami', document: { file_id: 'report' } } },
  ]

  async function runBatch(interrupt: boolean) {
    const counters = new FileCounterStore({ stateRoot })
    await counters.load()
    const runtime = new ChannelsRuntime({
      ctx: {}, config: resolveConfig({ allowedSenders: ['7'], senderPerDay: 2 }),
      logger: silent, stateRoot, workingDirectory: stateRoot, counters,
    })
    const checkpoint = deferred<'downloading' | 'next poll'>()
    const block = deferred<Response>()
    const routed: Array<{ text: string; allowed: boolean; attachments: number }> = []
    let firstPoll = true
    const adapter = await createAdapter({
      runtime, stateRoot, config: { token: '123:secret', fetchImpl: async (url) => {
        if (url.endsWith('/getUpdates')) {
          if (!firstPoll) {
            checkpoint.resolve('next poll')
            return block.promise
          }
          firstPoll = false
          // Telegram can replay the whole batch if the previous adapter never sent an offset to confirm it.
          return Response.json({ ok: true, result: updates })
        }
        if (url.endsWith('/getFile')) {
          if (interrupt) {
            checkpoint.resolve('downloading')
            return block.promise
          }
          return Response.json({ ok: true, result: { file_path: 'report.txt' } })
        }
        return new Response('report contents')
      } },
    })
    adapter.onInbound((message) => {
      const decision = runtime.dispatch(message)
      routed.push({ text: message.text, allowed: decision.allow, attachments: message.media.length })
    })
    await adapter.start()
    try {
      assert.equal(await Promise.race([checkpoint.promise, delay(1000, 'stalled', { ref: false })]), interrupt ? 'downloading' : 'next poll')
      return routed
    } finally {
      const stopping = adapter.stop()
      block.resolve(Response.json({ ok: true, result: [] }))
      await stopping
      runtime.dispose()
    }
  }

  assert.deepEqual(await runBatch(true), [{ text: '/help', allowed: true, attachments: 0 }])
  assert.deepEqual(await runBatch(false), [{ text: '/whoami', allowed: true, attachments: 1 }])
})

test('account identity follows the Telegram bot across token rotation, independently of its display label', async () => {
  const [original, rotated, replacement] = await Promise.all(['123:old', '123:new', '456:new'].map((token) => createAdapter({
    config: { token, botId: 'my_bot', mediaEnabled: false },
  })))
  assert.ok(original && rotated && replacement)
  assert.deepEqual(await original.accounts.list(), [{ accountId: 'bot:123', label: 'my_bot', expired: false }])
  assert.deepEqual(await rotated.accounts.list(), await original.accounts.list())
  assert.deepEqual(await replacement.accounts.list(), [{ accountId: 'bot:456', label: 'my_bot', expired: false }])
})

test('a target for a different bot never uses the active token', async () => {
  const calls: string[] = []
  const adapter = await createAdapter({
    config: { token: '123:secret', mediaEnabled: false, fetchImpl: async (url) => {
      calls.push(url)
      return Response.json({ ok: true, result: { message_id: 1 } })
    } },
  })
  const stale = { channel: 'telegram', accountId: 'bot:456', conversationId: '7' }
  assert.equal((await adapter.send(stale, { text: 'hi', kind: 'reply' })).ok, false)
  await adapter.typing?.(stale)
  assert.deepEqual(calls, [])
  assert.equal((await adapter.send({ ...stale, accountId: 'bot:123' }, { text: 'hi', kind: 'reply' })).ok, true)
})

test('sending multiple files reports a failure even when a later file could succeed', async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-send-'))
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }))
  const present = path.join(stateRoot, 'present.txt')
  fs.writeFileSync(present, 'file content')
  const adapter = await createAdapter({
    config: { token: '123:secret', mediaEnabled: false, fetchImpl: async () => Response.json({ ok: true, result: { message_id: 1 } }) },
  })
  const result = await adapter.send({ channel: 'telegram', accountId: 'bot:123', conversationId: '7' }, {
    kind: 'reply',
    media: [{ kind: 'file', path: path.join(stateRoot, 'missing.txt') }, { kind: 'file', path: present }],
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'send-media-failed')
})

test('custom Telegram servers cannot share a scope with a different backend issuing the same bot ID', async () => {
  const [official, first, second] = await Promise.all([
    createAdapter({ config: { token: '123:old' } }),
    createAdapter({ config: { token: '123:old', apiBaseUrl: 'http://telegram-one.test' } }),
    createAdapter({ config: { token: '123:old', apiBaseUrl: 'http://telegram-two.test' } }),
  ])
  const scopes = await Promise.all([official, first, second].map(async (adapter) => (await adapter.accounts.list())[0]?.accountId))
  assert.equal(new Set(scopes).size, 3)
})

test('a stopped Telegram transport can start again without discarding its cursor', async () => {
  const offsets: Array<number | undefined> = []
  const transport = new TelegramTransport({ token: '123:test', logger: { info() {}, warn() {} }, fetchImpl: async (_url, init) => {
    offsets.push(JSON.parse(String(init?.body)).offset)
    return { ok: true, status: 200, json: async () => ({ ok: true, result: [{ update_id: 12 }] }) }
  } })
  await transport.pollOnce()
  transport.stop()
  assert.deepEqual(await transport.pollOnce(), [])
  transport.start()
  await transport.pollOnce()
  assert.deepEqual(offsets, [undefined, 13])
  transport.stop()
})

test('a failed durable Telegram handoff rewinds the offset instead of acknowledging later updates', async () => {
  const calls: number[] = []
  let count = 0
  const transport = new TelegramTransport({ token: '123:secret', logger: silent, fetchImpl: async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)).offset ?? 0)
    return Response.json({ ok: true, result: count++ === 0 ? [baseUpdate, { ...baseUpdate, update_id: 11 }] : [] })
  } })
  await transport.pollOnce()
  transport.retryFrom(10)
  await transport.pollOnce()
  assert.deepEqual(calls, [0, 10])
  transport.stop()
})

test('the Telegram adapter retries a failed durable handoff before confirming the update', { timeout: 5000 }, async () => {
  const delivered = deferred<void>()
  const offsets: number[] = []
  let attempts = 0
  const adapter = await createAdapter({ config: { token: '123:secret', mediaEnabled: false, fetchImpl: async (_url, init) => {
    offsets.push(JSON.parse(String(init?.body)).offset ?? 0)
    if (offsets.length <= 2) return Response.json({ ok: true, result: [baseUpdate] })
    return new Promise(() => {})
  } } })
  adapter.onInbound(() => {
    if (++attempts === 1) throw Object.assign(new Error('cannot persist'), { code: 'DSH_INBOUND_RETRY' })
    delivered.resolve()
  })
  await adapter.start()
  try {
    await delivered.promise
    assert.deepEqual(offsets.slice(0, 2), [0, baseUpdate.update_id])
  } finally { await adapter.stop() }
})
