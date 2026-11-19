import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { FeishuTransport } from '../packages/adapter-feishu/src/transport.js'

const silent = { info: () => {}, warn: () => {} }
const APP_ID = 'cli_0000000000000001'
const SECRET = 'secret'

function recorded(calls: Array<{ url: string; init?: Record<string, unknown> }>, answer: (url: string, init: Record<string, unknown>) => unknown) {
  return async (url: string, init: Record<string, unknown> = {}) => {
    calls.push({ url, init })
    const body = answer(url, init)
    return { ok: true, status: 200, json: async () => body, body: null }
  }
}

test('the tenant token is fetched once and reused while valid', async () => {
  const calls: Array<{ url: string; init?: Record<string, unknown> }> = []
  const transport = new FeishuTransport({
    appId: APP_ID, appSecret: SECRET, logger: silent,
    fetchImpl: recorded(calls, (url) =>
      url.endsWith('/tenant_access_token/internal')
        ? { code: 0, data: { tenant_access_token: 't-1', expire: 7200 } }
        : { code: 0, data: { message_id: 'om_9' } }),
  })
  await transport.sendText('oc_1', 'hi')
  await transport.sendText('oc_1', 'hi')
  assert.equal(calls.filter((call) => call.url.endsWith('/tenant_access_token/internal')).length, 1)
  const send = calls.find((call) => call.url.includes('/im/v1/messages'))
  assert.equal((send?.init?.['headers'] as Record<string, string>)['authorization'], 'Bearer t-1')
})

test('a failed token exchange throws rather than sending unauthenticated', async () => {
  const transport = new FeishuTransport({
    appId: APP_ID, appSecret: SECRET, logger: silent,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 99991663, msg: 'app secret invalid' }), body: null }),
  })
  await assert.rejects(transport.tenantToken(), /app secret invalid/)
})

test('a plain send posts a text message and reports its id', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = []
  const transport = new FeishuTransport({
    appId: APP_ID, appSecret: SECRET, logger: silent,
    fetchImpl: recorded(calls, (url) =>
      url.endsWith('/tenant_access_token/internal')
        ? { code: 0, data: { tenant_access_token: 't', expire: 7200 } }
        : { code: 0, data: { message_id: 'om_9' } }),
  })
  const result = await transport.sendText('oc_1', '你好')
  assert.deepEqual(result, { ok: true, messageId: 'om_9' })
  const send = calls.find((call) => call.url.includes('/im/v1/messages'))!
  const body = JSON.parse(String(send.init['body']))
  assert.equal(send.url, 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id')
  assert.equal(body['receive_id'], 'oc_1')
  assert.equal(body['msg_type'], 'text')
  assert.deepEqual(JSON.parse(body['content']), { text: '你好' })
})

test('actions are sent as an interactive card whose value round-trips on tap', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = []
  const transport = new FeishuTransport({
    appId: APP_ID, appSecret: SECRET, logger: silent,
    fetchImpl: recorded(calls, (url) =>
      url.endsWith('/tenant_access_token/internal')
        ? { code: 0, data: { tenant_access_token: 't', expire: 7200 } }
        : { code: 0, data: { message_id: 'om_card' } }),
  })
  const result = await transport.sendText('oc_1', '需要批准', [{ label: '允许一次', value: 'a1b2c3 1' }])
  assert.equal(result.ok, true)
  const body = JSON.parse(String(calls.find((call) => call.url.includes('/im/v1/messages'))!.init['body']))
  assert.equal(body['msg_type'], 'interactive')
  const card = JSON.parse(body['content'])
  const button = card['elements'].find((element: { tag: string }) => element.tag === 'action')['actions'][0]
  assert.equal(button['text']['content'], '允许一次')
  assert.deepEqual(button['value'], { value: 'a1b2c3 1' })
})

test('a rate limit envelope becomes a retryable send result', async () => {
  const transport = new FeishuTransport({
    appId: APP_ID, appSecret: SECRET, logger: silent,
    fetchImpl: async (url) => ({
      ok: true, status: 200, body: null,
      json: async () => url.endsWith('/tenant_access_token/internal')
        ? { code: 0, data: { tenant_access_token: 't', expire: 7200 } }
        : { code: 99991663, msg: 'rate limited' },
    }),
  })
  const result = await transport.sendText('oc_1', 'slow')
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'rate-limited')
})

test('edit patches the same message id in place', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = []
  const transport = new FeishuTransport({
    appId: APP_ID, appSecret: SECRET, logger: silent,
    fetchImpl: recorded(calls, (url) =>
      url.endsWith('/tenant_access_token/internal')
        ? { code: 0, data: { tenant_access_token: 't', expire: 7200 } }
        : { code: 0, data: { message_id: 'om_12' } }),
  })
  const result = await transport.editMessage('oc_1', 'om_12', '任务已完成。')
  assert.deepEqual(result, { ok: true, messageId: 'om_12' })
  const patch = calls.find((call) => call.url.endsWith('/im/v1/messages/om_12'))!
  assert.equal(patch.init['method'], 'PATCH')
})

test('an image upload returns its image_key and then sends as an image message', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-upload-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'pic.png')
  fs.writeFileSync(file, 'png-bytes')
  const calls: Array<{ url: string; init: Record<string, unknown> }> = []
  const transport = new FeishuTransport({
    appId: APP_ID, appSecret: SECRET, logger: silent,
    fetchImpl: recorded(calls, (url) => {
      if (url.endsWith('/tenant_access_token/internal')) return { code: 0, data: { tenant_access_token: 't', expire: 7200 } }
      if (url.endsWith('/im/v1/images')) return { code: 0, data: { image_key: 'img_k' } }
      return { code: 0, data: { message_id: 'om_img' } }
    }),
  })
  const key = await transport.uploadImage(file)
  assert.equal(key, 'img_k')
  const result = await transport.sendResource('oc_1', 'image', key, '')
  assert.equal(result.ok, true)
  const send = calls.find((call) => call.url.includes('/im/v1/messages'))!
  const body = JSON.parse(String(send.init['body']))
  assert.equal(body['msg_type'], 'image')
  assert.deepEqual(JSON.parse(body['content']), { image_key: 'img_k' })
})

test('a download aborts as soon as the stream exceeds the byte cap', async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-download-'))
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }))
  let cancelled = false
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  const transport = new FeishuTransport({
    appId: APP_ID, appSecret: SECRET, logger: silent,
    fetchImpl: async (url) => {
      if (url.endsWith('/tenant_access_token/internal')) {
        return { ok: true, status: 200, body: null, json: async () => ({ code: 0, data: { tenant_access_token: 't', expire: 7200 } }) }
      }
      return {
        ok: true, status: 200, json: async () => ({}),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller
            controller.enqueue(new Uint8Array([1, 2, 3]))
            controller.enqueue(new Uint8Array([4, 5, 6]))
          },
          cancel() { cancelled = true },
        }),
      }
    },
  })
  const result = await transport.downloadResource('om_1', 'f_k', 'file', 5)
  assert.equal('error' in result, true)
  assert.equal(cancelled, true)
  // The cap path already cancelled the stream, which closes its controller.
  if (stream !== undefined) try { stream.close() } catch { /* already closed */ }
})
