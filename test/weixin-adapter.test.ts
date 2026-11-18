import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer, type RequestListener } from 'node:http'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test, { type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { InboundMessage } from '@derekluo/dsh-channels'

import { createAdapter } from '../packages/adapter-weixin/src/index.js'
import { saveInboundItem } from '../packages/adapter-weixin/src/media.js'
import { WeixinTransport } from '../packages/adapter-weixin/src/transport.js'

async function listen(t: TestContext, handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const addr = server.address()
  assert.ok(addr !== null && typeof addr !== 'string')
  return `http://127.0.0.1:${addr.port}`
}

function stateDir(t: TestContext, baseUrl?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-weixin-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  if (baseUrl !== undefined) {
    const accounts = path.join(dir, 'openclaw-weixin', 'accounts')
    fs.mkdirSync(accounts, { recursive: true })
    fs.writeFileSync(path.join(accounts, 'acct.json'), JSON.stringify({ token: 'test-token', baseUrl }))
  }
  return dir
}

async function within(test: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!test()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for the adapter')
    await delay(10)
  }
}

function attachment(encrypted: string) {
  return { type: 2, image_item: { media: { encrypt_query_param: encrypted } } }
}

function inbound(sender: string, ...items: unknown[]) {
  return { from_user_id: sender, create_time_ms: 42, item_list: items }
}

function textItem(text: string) {
  return { type: 1, text_item: { text } }
}

test('the built Weixin request uses the vendored iLink identity and rejects HTTP 200 errcode failures', async (t) => {
  const requests: Array<{ appId: unknown; clientVersion: unknown; baseInfo: unknown }> = []
  const baseUrl = await listen(t, async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({
      appId: req.headers['ilink-app-id'],
      clientVersion: req.headers['ilink-app-clientversion'],
      baseInfo: JSON.parse(body).base_info,
    })
    res.end(JSON.stringify({ errcode: -14, errmsg: 'rejected' }))
  })
  const { createAdapter: createBuiltAdapter } = await import(pathToFileURL(path.resolve('packages/adapter-weixin/dist/src/index.js')).href)
  const adapter: Awaited<ReturnType<typeof createAdapter>> = await createBuiltAdapter({
    config: { accountId: 'acct', stateDir: stateDir(t, baseUrl), asrEnabled: false },
  })
  const sent = await adapter.send({ channel: 'weixin', accountId: 'acct', conversationId: 'person' }, { kind: 'reply', text: 'hello' })
  assert.equal(sent.ok, false)
  assert.equal(sent.ok === false && sent.code, 'session-rejected')
  assert.deepEqual(requests, [{
    appId: 'bot',
    clientVersion: '132106',
    baseInfo: { channel_version: '2.4.10', bot_agent: 'OpenClaw' },
  }])
})

test('an outbound target for a different Weixin account never reaches the server', async (t) => {
  let requests = 0
  const baseUrl = await listen(t, (_, res) => { requests += 1; res.end('{"ret":0}') })
  const adapter = await createAdapter({ config: { accountId: 'acct', stateDir: stateDir(t, baseUrl), asrEnabled: false } })
  const sent = await adapter.send({ channel: 'weixin', accountId: 'former', conversationId: 'person' }, { kind: 'reply', text: 'private' })
  assert.equal(sent.ok, false)
  assert.equal(requests, 0)
})

test('Weixin uses the configured upload CDN and returns the first rejected attachment', async (t) => {
  const requests: string[] = []
  const baseUrl = await listen(t, (req, res) => {
    requests.push(req.url ?? '')
    if (req.url === '/ilink/bot/getuploadurl') res.end('{"upload_param":"upload-token"}')
    else if (req.url?.startsWith('/cdn/upload?encrypted_query_param=upload-token&filekey=')) {
      res.writeHead(200, { 'x-encrypted-param': 'download-token' }).end()
    } else {
      res.end(requests.length === 3 ? '{"errcode":-14}' : '{"ret":0,"message_id":"sent"}')
    }
  })
  const state = stateDir(t, baseUrl)
  const filePath = path.join(state, 'photo.png')
  fs.writeFileSync(filePath, 'a picture')
  const adapter = await createAdapter({ config: { accountId: 'acct', stateDir: state, cdnBaseUrl: `${baseUrl}/cdn/`, asrEnabled: false } })
  const media = [{ kind: 'image' as const, path: filePath }, { kind: 'image' as const, path: filePath }]
  const sent = await adapter.send({ channel: 'weixin', accountId: 'acct', conversationId: 'person' }, { kind: 'reply', media })
  assert.equal(sent.ok === false && sent.code, 'session-rejected')
  assert.equal(requests.length, 3)
  assert.match(requests[1] ?? '', /^\/cdn\/upload\?encrypted_query_param=upload-token&filekey=/)
  assert.equal(requests[2], '/ilink/bot/sendmessage')
})

test('two same-kind Weixin attachments with the same timestamp retain their own bytes and type', async (t) => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)])
  const originalFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (!url.startsWith('https://cdn.test/')) return originalFetch(url)
    return new Response(Buffer.concat([png, Buffer.from(url.at(-1) ?? '')]))
  })
  t.mock.method(Date, 'now', () => 42)
  const options = {
    accountId: 'acct', mediaRoot: stateDir(t), cdnBaseUrl: 'https://cdn.test', messageId: 'same',
    logger: { info: () => {}, warn: () => {} },
  }
  const alpha = await saveInboundItem(attachment('a'), options)
  const beta = await saveInboundItem(attachment('b'), options)
  assert.ok(alpha.ok && beta.ok)
  assert.notEqual(alpha.media.path, beta.media.path)
  assert.equal(path.extname(alpha.media.path), '.png')
  assert.deepEqual(fs.readFileSync(alpha.media.path), Buffer.concat([png, Buffer.from('a')]))
  assert.deepEqual(fs.readFileSync(beta.media.path), Buffer.concat([png, Buffer.from('b')]))
})

test('slow Weixin media preserves conversation order without blocking other conversations or shutdown', async (t) => {
  const started: string[] = []
  let finishFirst: (() => void) | undefined
  let stalledClosed = false
  const cdnBaseUrl = await listen(t, (req, res) => {
    const key = new URL(req.url ?? '', 'http://localhost').searchParams.get('encrypted_query_param') ?? ''
    started.push(key)
    res.on('close', () => { if (key === 'stall') stalledClosed = true })
    res.writeHead(200)
    res.write(Buffer.from('photo'))
    if (key === 'first') finishFirst = () => res.end()
  })
  let round = 0
  const baseUrl = await listen(t, (_, res) => {
    round += 1
    if (round === 1) {
      res.end(JSON.stringify({
        ret: 0,
        msgs: [inbound('a', textItem('first'), attachment('first')), inbound('blocked', attachment('denied'))],
      }))
    } else if (round === 2) {
      res.end(JSON.stringify({ ret: 0, msgs: [inbound('a', textItem('second')), inbound('b', textItem('independent')), inbound('c', textItem('never delivered'), attachment('stall'))] }))
    }
  })
  const admitted = new Map<string, { message: InboundMessage; hasAttachments: boolean }>()
  const adapter = await createAdapter({
    config: { accountId: 'acct', stateDir: stateDir(t, baseUrl), cdnBaseUrl, asrEnabled: false },
    runtime: {
      canReceive: (message, hasAttachments) => {
        admitted.set(message.text, { message, hasAttachments })
        return message.senderId !== 'blocked'
      },
    },
  })
  const received: InboundMessage[] = []
  const receivedTexts = () => received.map((message) => message.text)
  adapter.onInbound((message) => received.push(message))
  await adapter.start()
  try {
    await within(() => finishFirst !== undefined && receivedTexts().includes('independent'))
    assert.deepEqual(receivedTexts(), ['independent'])
    finishFirst?.()
    await within(() => received.length === 3)
    assert.deepEqual(receivedTexts(), ['independent', 'first', 'second'])
    await within(() => started.includes('stall'))
  } finally {
    await adapter.stop()
  }
  await within(() => stalledClosed)
  assert.deepEqual(receivedTexts(), ['independent', 'first', 'second'])
  assert.deepEqual([...started].sort(), ['first', 'stall'])
  assert.equal(admitted.get('')?.hasAttachments, true)
  assert.equal(admitted.get('second')?.hasAttachments, false)
  assert.equal(admitted.get('first')?.message, received[1])
  assert.equal(received[1]?.media.length, 1)
})

test('stopping during a Weixin batch leaves the queued text available on restart', async (t) => {
  let downloads = 0
  const cdnBaseUrl = await listen(t, (_, res) => {
    downloads += 1
    res.writeHead(200)
    res.write('attachment')
    if (downloads > 1) res.end()
  })
  const cursors: string[] = []
  const baseUrl = await listen(t, async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const cursor = JSON.parse(body).get_updates_buf as string
    cursors.push(cursor)
    if (cursor !== 'before') return
    res.end(JSON.stringify({
      ret: 0,
      get_updates_buf: 'after',
      msgs: [inbound('same', attachment('stall')), inbound('same', textItem('still waiting'))],
    }))
  })
  const state = stateDir(t, baseUrl)
  const cursorFile = path.join(state, 'openclaw-weixin', 'accounts', 'acct.sync.json')
  fs.writeFileSync(cursorFile, JSON.stringify({ get_updates_buf: 'before' }))
  const admitted: string[] = []
  const released: string[] = []
  const runtime = {
    canReceive: (message: InboundMessage) => { admitted.push(message.text); return true },
    cancelReceive: (message: InboundMessage) => { released.push(message.text) },
  }
  const adapter = await createAdapter({
    config: { accountId: 'acct', stateDir: state, cdnBaseUrl, asrEnabled: false },
    runtime,
  })
  const received: string[] = []
  adapter.onInbound((message) => received.push(message.text))
  await adapter.start()
  try {
    await within(() => downloads === 1 && cursors.length === 2)
  } finally {
    await adapter.stop()
  }
  assert.deepEqual(received, [])
  assert.deepEqual(JSON.parse(fs.readFileSync(cursorFile, 'utf8')), { get_updates_buf: 'before' })
  assert.deepEqual(cursors, ['before', 'after'])
  assert.deepEqual(admitted, [''])
  assert.deepEqual(released, [''])

  await adapter.start()
  try {
    await within(() => received.length === 2 && cursors.length === 4)
    assert.deepEqual(received, ['', 'still waiting'])
    assert.deepEqual(cursors, ['before', 'after', 'before', 'after'])
    assert.deepEqual(admitted, ['', '', 'still waiting'])
    assert.deepEqual(JSON.parse(fs.readFileSync(cursorFile, 'utf8')), { get_updates_buf: 'after' })
  } finally {
    await adapter.stop()
  }
})

test('Weixin poll times out a stalled response body', async (t) => {
  const baseUrl = await listen(t, (_, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write('{"ret":0,')
  })
  const instance = new WeixinTransport({
    accountId: 'acct', token: 'token', baseUrl, longPollTimeoutMs: 100,
    logger: { info: () => {}, warn: () => {} },
    onMessage: () => assert.fail('incomplete batch delivered'),
    onSessionRejected: () => assert.fail('session rejected'),
  })
  const result = await Promise.race([instance.pollOnce(), delay(750, 'stalled', { ref: false })])
  assert.equal(result, 'ok')
})

test('Weixin rejects an oversized iLink body before waiting for it to finish', async (t) => {
  const baseUrl = await listen(t, (_, res) => {
    res.writeHead(200, { 'Content-Length': 16 * 1024 * 1024 })
    res.write('{"ret":0,')
  })
  const instance = new WeixinTransport({
    accountId: 'acct', token: 'token', baseUrl, longPollTimeoutMs: 3_000,
    logger: { info: () => {}, warn: () => {} },
    onMessage: () => assert.fail('oversized batch delivered'),
    onSessionRejected: () => assert.fail('session rejected'),
  })
  assert.equal(await Promise.race([instance.pollOnce(), delay(750, 'stalled', { ref: false })]), 'retry')
})

test('Weixin does not save an oversized streamed attachment', async (t) => {
  const chunk = Buffer.alloc(1024 * 1024)
  let remaining = 110
  const cdnBaseUrl = await listen(t, (_, res) => {
    const write = () => {
      while (remaining > 0) {
        remaining -= 1
        if (!res.write(chunk)) { res.once('drain', write); return }
      }
      res.end()
    }
    write()
  })
  const saved = await saveInboundItem(attachment('too-big'), {
    accountId: 'acct', mediaRoot: stateDir(t), cdnBaseUrl, messageId: 'same',
    logger: { info: () => {}, warn: () => {} },
  })
  assert.equal(saved.ok, false)
})

test('Weixin times out when the CDN stops sending an attachment', async (t) => {
  const timeout = AbortSignal.timeout
  t.mock.method(AbortSignal, 'timeout', () => timeout(100))
  const cdnBaseUrl = await listen(t, (_, res) => {
    res.writeHead(200)
    res.write('an incomplete attachment')
  })
  const saved = saveInboundItem(attachment('stall'), {
    accountId: 'acct', mediaRoot: stateDir(t), cdnBaseUrl, messageId: 'same',
    logger: { info: () => {}, warn: () => {} },
  })
  assert.deepEqual(await Promise.race([saved, delay(750, 'stalled', { ref: false })]), { ok: false, kind: 'image', reason: 'download-empty' })
})

test('task controls bypass stalled media, while ordinary text remains ordered and authorization still runs', async (t) => {
  let finish: (() => void) | undefined
  const cdnBaseUrl = await listen(t, (_, res) => { res.writeHead(200); res.write('media'); finish = () => res.end() })
  let first = true
  let replyContext: unknown
  const baseUrl = await listen(t, async (req, res) => {
    if (req.url?.endsWith('/sendmessage')) {
      let body = ''; for await (const chunk of req) body += chunk
      replyContext = JSON.parse(body).msg.context_token
      res.end(JSON.stringify({ ret: 0, message_id: 'sent' })); return
    }
    if (!first) return
    first = false
    res.end(JSON.stringify({ ret: 0, get_updates_buf: 'after', msgs: [{ ...inbound('same', attachment('stall')), context_token: 'old' }, { ...inbound('same', textItem('normal')), context_token: 'older-normal' }, inbound('blocked', textItem('/cancel')), { ...inbound('same', textItem('/cancel')), context_token: 'latest' }] }))
  })
  const checked: string[] = []; const seen: string[] = []
  const runtime = { canBypassInbound: (message: InboundMessage) => message.text === '/cancel', canReceive: (message: InboundMessage) => { checked.push(message.senderId); return message.senderId !== 'blocked' } }
  const adapter = await createAdapter({ config: { accountId: 'acct', stateDir: stateDir(t, baseUrl), cdnBaseUrl, asrEnabled: false }, runtime })
  adapter.onInbound((message) => seen.push(message.text || 'media'))
  await adapter.start()
  try {
    await within(() => finish !== undefined && seen.includes('/cancel'))
    assert.deepEqual(seen, ['/cancel']); assert.ok(checked.includes('blocked'))
    finish?.(); await within(() => seen.length === 3)
    assert.deepEqual(seen, ['/cancel', 'media', 'normal'])
    await adapter.send({ channel: 'weixin', accountId: 'acct', conversationId: 'same' }, { kind: 'notice', text: 'reply' })
    assert.equal(replyContext, 'latest')
  } finally { finish?.(); await adapter.stop() }
})

test('Weixin limits active media downloads across chats and releases a canceled waiter', async (t) => {
  const pending: Array<() => void> = []
  let active = 0; let peak = 0; let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++; active++; peak = Math.max(peak, active)
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { pending.push(() => { controller.enqueue(new Uint8Array(20)); controller.close(); active-- }) } }))
  })
  const base = { accountId: 'acct', mediaRoot: stateDir(t), cdnBaseUrl: 'https://cdn.test', messageId: 'budget', logger: { info() {}, warn() {} } }
  const abort = new AbortController()
  const first = saveInboundItem(attachment('one'), base)
  const second = saveInboundItem(attachment('two'), base)
  const canceled = saveInboundItem(attachment('cancel'), { ...base, signal: abort.signal })
  const fourth = saveInboundItem(attachment('four'), base)
  try {
    await within(() => calls >= 2)
    await delay(10)
    assert.equal(calls, 2)
    abort.abort()
    assert.equal((await canceled).ok, false)
    pending.shift()?.(); pending.shift()?.()
    await within(() => calls === 3)
    pending.shift()?.()
    assert.ok((await first).ok && (await second).ok && (await fourth).ok)
    assert.equal(peak, 2)
  } finally { for (const finish of pending) finish() }
})

test('Weixin enforces the remaining message byte budget before consuming a response', async (t) => {
  let canceled = false
  t.mock.method(globalThis, 'fetch', async () => {
    let timer: ReturnType<typeof setTimeout>
    return new Response(new ReadableStream({ start(controller) { timer = setTimeout(() => controller.close(), 40) }, cancel() { canceled = true; clearTimeout(timer) } }), { headers: { 'content-length': '100' } })
  })
  const options = { accountId: 'acct', mediaRoot: stateDir(t), cdnBaseUrl: 'https://cdn.test', messageId: 'bounded', maxBytes: 16, logger: { info() {}, warn() {} } }
  const result = await saveInboundItem(attachment('large'), options)
  assert.equal(result.ok, false)
  assert.equal(canceled, true)
})
