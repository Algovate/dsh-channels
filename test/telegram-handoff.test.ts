import type { IngressSink } from '../packages/core/src/types.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createAdapter } from '../packages/adapter-telegram/src/index.js'
import type { InboundMessage } from '../packages/core/src/types.js'
const update = (id: number, text: string, photo = false) => ({ update_id: id, message: { message_id: id, from: { id: 1 }, chat: { id: 1, type: 'private' }, ...(photo ? { photo: [{ file_id: String(id) }] } : { text }) } })
async function until(check: () => boolean) { for (let i = 0; i < 150 && !check(); i++) await delay(20); assert.ok(check()) }

test('Telegram keeps the offset before pending downloads while later polls deliver priority controls', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-handoff-')); const seen: InboundMessage[] = []; const offsets: number[] = []
  let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve }); let downloading = false
  const adapter = await createAdapter({ stateRoot: root, runtime: { canReceive: () => true, canBypassInbound: (message) => message.text === '/cancel' }, config: { token: '123:test', fetchImpl: async (url, init) => {
    if (url.endsWith('/getUpdates')) {
      const offset = JSON.parse(String(init?.body)).offset ?? 0; offsets.push(offset)
      const batch = offsets.length === 1 ? [update(10, '', true)] : [update(10, '', true), update(11, '/cancel')]
      if (offset > 11) return await new Promise<never>((_resolve, reject) => (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('stopped')), { once: true }))
      return Response.json({ ok: true, result: batch.filter((item) => item.update_id >= offset) })
    }
    if (url.endsWith('/getFile')) { downloading = true; await blocked; return Response.json({ ok: false, description: 'unavailable' }) }
    throw new Error('unexpected request')
  } } })
  const sink: IngressSink = { async offer(message) { seen.push(message) } }
  try {
    await adapter.startWithSink(sink); await until(() => downloading); await until(() => seen.some((message) => message.text === '/cancel'))
    assert.ok(offsets.every((offset) => offset <= 10), 'do not acknowledge a pending download')
    assert.equal(seen.length, 1)
    release(); await until(() => seen.length === 2); await until(() => offsets.some((offset) => offset === 12))
    const photo = seen.find((message) => message.text === '')!
    assert.match(JSON.stringify(photo), /attachmentErrors/)
    assert.equal(seen.filter((message) => message.text === '/cancel').length, 1)
  } finally { release(); await adapter.stop(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('Telegram bounds ordinary downloads across chats while controls bypass the occupied slots', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-slots-')); let downloads = 0; const seen: string[] = []
  const batch = [1, 2, 3].map((id) => { const item = update(id, '', true); item.message.chat.id = id; return item }); batch.push(update(4, '/cancel'))
  const adapter = await createAdapter({ stateRoot: root, runtime: { canReceive: () => true, canBypassInbound: (message) => message.text === '/cancel' }, config: { token: '123:test', fetchImpl: async (url, init) => {
    if (url.endsWith('/getUpdates')) return Response.json({ ok: true, result: batch })
    if (url.endsWith('/getFile')) { downloads++; return new Promise<never>((_resolve, reject) => (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('stopped')), { once: true })) }
    throw new Error('unexpected request')
  } } })
  const sink: IngressSink = { async offer(message) { seen.push(message.text) } }
  try { await adapter.startWithSink(sink); await until(() => seen.includes('/cancel')); await until(() => downloads === 2); await delay(120); assert.equal(downloads, 2); assert.deepEqual(seen, ['/cancel']) }
  finally { await adapter.stop(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('Telegram retries a failed durable handoff before delivering the next ordinary input in that chat', { timeout: 6000 }, async () => {
  const seen: string[] = []; let failed = false
  const adapter = await createAdapter({ runtime: { canReceive: () => true }, config: { token: '123:test', mediaEnabled: false, fetchImpl: async (_url, init) => {
    const offset = JSON.parse(String(init?.body)).offset ?? 0
    if (offset > 11) return new Promise<never>((_resolve, reject) => (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('stopped')), { once: true }))
    return Response.json({ ok: true, result: [update(10, 'first'), update(11, 'second')].filter((item) => item.update_id >= offset) })
  } } })
  const sink: IngressSink = { async offer(message) {
    seen.push(message.text)
    if (message.text === 'first' && !failed) { failed = true; throw Object.assign(new Error('cannot persist'), { code: 'DSH_INBOUND_RETRY' }) }
  } }
  try { await adapter.startWithSink(sink); await until(() => failed); await delay(50); assert.deepEqual(seen, ['first']); await until(() => seen.includes('second')); assert.deepEqual(seen, ['first', 'first', 'second']) }
  finally { await adapter.stop() }
})

test('Telegram reports local attachment save failures instead of dropping the input', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-write-')); fs.writeFileSync(path.join(root, 'media'), 'not a directory'); let first = true; const seen: InboundMessage[] = []
  const adapter = await createAdapter({ stateRoot: root, runtime: { canReceive: () => true }, config: { token: '123:test', fetchImpl: async (url, init) => {
    if (url.endsWith('/getUpdates')) {
      if (first) { first = false; return Response.json({ ok: true, result: [update(10, '', true)] }) }
      return new Promise<never>((_resolve, reject) => (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('stopped')), { once: true }))
    }
    if (url.endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: 'photo.jpg' } })
    return new Response('photo')
  } } })
  const sink: IngressSink = { async offer(message) { seen.push(message) } }
  try { await adapter.startWithSink(sink); await until(() => seen.length > 0); assert.equal(seen[0]?.media.length, 0); assert.ok(seen[0]?.attachmentErrors?.length) }
  finally { await adapter.stop(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('durable retry backoff keeps its chat position but releases capacity for healthy chats', async () => {
  const seen: number[] = []; const batch = [1, 2, 3].map((id) => { const item = update(id, 'ordinary'); item.message.chat.id = id; return item })
  const adapter = await createAdapter({ runtime: { canReceive: () => true }, config: { token: '123:test', mediaEnabled: false, fetchImpl: async () => Response.json({ ok: true, result: batch }) } })
  const sink: IngressSink = { async offer(message) { const id = Number(message.conversationId); seen.push(id); if (id < 3) throw Object.assign(new Error('route unavailable'), { code: 'DSH_INBOUND_RETRY' }) } }
  try { await adapter.startWithSink(sink); await until(() => seen.includes(3)); assert.deepEqual(seen.slice(0, 3), [1, 2, 3]) }
  finally { await adapter.stop() }
})

test('durable Telegram retries reuse enriched input rather than downloading the same attachment again', { timeout: 6000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-enriched-')); const seen: InboundMessage[] = []; let downloads = 0; let poll = 0
  const adapter = await createAdapter({ stateRoot: root, runtime: { canReceive: () => true }, config: { token: '123:test', fetchImpl: async (url, init) => {
    if (url.endsWith('/getUpdates')) {
      if (++poll === 1) return Response.json({ ok: true, result: [update(10, '', true)] })
      return new Promise<never>((_resolve, reject) => (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('stopped')), { once: true }))
    }
    if (url.endsWith('/getFile')) { downloads++; return Response.json({ ok: true, result: { file_path: 'photo.jpg' } }) }
    return new Response('photo')
  } } })
  const sink: IngressSink = { async offer(message) { seen.push(message); if (seen.length === 1) throw Object.assign(new Error('cannot persist'), { code: 'DSH_INBOUND_RETRY' }) } }
  try { await adapter.startWithSink(sink); await until(() => seen.length === 1); await until(() => seen.length === 2); assert.equal(downloads, 1); assert.equal(seen[0], seen[1]); assert.equal(seen[1]?.media.length, 1) }
  finally { await adapter.stop(); fs.rmSync(root, { recursive: true, force: true }) }
})
