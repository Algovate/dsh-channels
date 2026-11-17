import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { uploadBufferToCdn } from '../packages/adapter-weixin/vendor/openclaw-weixin/cdn/cdn-upload.js'

async function server(handler: http.RequestListener) {
  const listener = http.createServer(handler)
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}`, close: async () => {
    listener.closeAllConnections()
    await new Promise<void>((resolve) => listener.close(() => resolve()))
  } }
}
const params = (url: string) => ({ buf: Buffer.from('test'), aeskey: Buffer.alloc(16), uploadFullUrl: url, label: 'test', timeoutMs: 80 })

test('CDN upload bounds stalled headers and error bodies across all retry attempts', async () => {
  for (const headers of [false, true]) {
    const host = await server((_req, res) => {
      if (headers) { res.writeHead(400); res.write('stalled') }
    })
    try {
      const started = Date.now()
      await assert.rejects(uploadBufferToCdn(params(host.url)), /timeout|aborted/i)
      assert.ok(Date.now() - started < 1000)
    } finally { await host.close() }
  }
})

test('CDN upload rejects oversized client errors without retry and cancels on shutdown', async () => {
  let calls = 0
  const host = await server((_req, res) => {
    calls++
    res.writeHead(400, { 'content-length': '100000' })
    res.write('large')
  })
  try {
    await assert.rejects(uploadBufferToCdn(params(host.url)), /exceeds 4096 bytes/)
    assert.equal(calls, 1)
  } finally { await host.close() }
  const stalled = await server(() => {})
  const controller = new AbortController()
  try {
    const pending = uploadBufferToCdn({ ...params(stalled.url), signal: controller.signal })
    setTimeout(() => controller.abort(), 5)
    await assert.rejects(pending, /aborted/i)
  } finally { await stalled.close() }
})

test('successful CDN uploads cancel unused response bodies', async () => {
  const host = await server((_req, res) => {
    res.writeHead(200, { 'x-encrypted-param': 'download-token' })
    res.write('unused body')
  })
  try {
    assert.deepEqual(await uploadBufferToCdn(params(host.url)), { downloadParam: 'download-token' })
  } finally { await host.close() }
})
