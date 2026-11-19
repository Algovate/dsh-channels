import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { startChannels, managementRejection } from '../packages/core/src/index.js'
import { readManagementBody } from '../packages/core/src/management.js'
import { resolveConfig } from '../packages/core/src/config.js'

test('management fails closed without host authentication, including service errors', () => {
  assert.equal(managementRejection({}, {}), 503)
  assert.equal(managementRejection({ get: () => ({ requestRejection() { throw new Error() } }) }, {}), 503)
})

test('all management routes require host authorization before reading or mutating state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-management-'))
  const previous = process.env.DSH_CHANNELS_STATE_DIR
  process.env.DSH_CHANNELS_STATE_DIR = root
  interface Route { path: string; handler?: (req: unknown, res: unknown) => void; resource?: (req: Request) => Promise<Response> }
  const routes = new Map<string, Route>()
  const ctx = { get: (name: string) => name === 'connection' ? {
    requestRejection: ({ headers }: { headers: Record<string, unknown> }) => headers['cookie'] === 'session=valid' ? undefined : 401,
  } : name === 'webServer' ? {
    getOrigin: () => 'http://localhost:9000',
    register: (route: Route) => { routes.set(route.path, route); return () => {} },
  } : undefined }
  const plugin = await startChannels({ ctx, config: resolveConfig({ adapters: [], allowedSenders: ['sender'] }) })
  const post = (route: string, body: string, cookie?: string): number => {
    const req = Object.assign(new EventEmitter(), { method: 'POST', headers: { origin: 'http://localhost:9000', cookie } })
    let status = 0
    routes.get(route)!.handler!(req, { writeHead: (code: number) => { status = code }, end() {} })
    req.emit('data', body)
    req.emit('end')
    return status
  }
  try {
    const status = routes.get('/channels/status')!.resource!
    assert.equal((await status(new Request('http://localhost:9000/channels/status'))).status, 401)
    assert.equal(post('/channels/allowlist', '{"remove":"sender"}'), 401)
    assert.equal(post('/channels/settings', '{"senderPerDay":0}'), 401)
    assert.deepEqual(plugin.runtime.config.allowedSenders, ['sender'])
    assert.equal(post('/channels/allowlist', '{"remove":"sender"}', 'session=valid'), 200)
    assert.deepEqual(plugin.runtime.config.allowedSenders, [])
    assert.equal(post('/channels/settings', '{"senderPerDay":0}', 'session=valid'), 200)
    assert.equal(post('/channels/settings', '{"senderPerDay":1}' + ' '.repeat(4096), 'session=valid'), 413)
    assert.equal(plugin.runtime.config.senderPerDay, 0)
    const response = await status(new Request('http://localhost:9000/channels/status', { headers: { cookie: 'session=valid' } }))
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { settings: { senderPerDay: number } }).settings.senderPerDay, 0)
  } finally {
    await plugin.dispose()
    if (previous === undefined) delete process.env.DSH_CHANNELS_STATE_DIR
    else process.env.DSH_CHANNELS_STATE_DIR = previous
    fs.rmSync(root, { recursive: true })
  }
})

test('body reader preserves split UTF-8 and rejects stalled, aborted and oversized bodies once', async () => {
  const req = new EventEmitter()
  let received = ''
  readManagementBody(req, (body) => { received = body }, () => assert.fail())
  const bytes = Buffer.from('{"add":"微信"}')
  req.emit('data', bytes.subarray(0, 9))
  req.emit('data', bytes.subarray(9))
  req.emit('end')
  assert.equal(received, bytes.toString('utf8'))
  for (const event of ['aborted', 'error', 'large', 'timeout']) {
    const input = new EventEmitter()
    const statuses: number[] = []
    readManagementBody(input, () => assert.fail(), (status) => statuses.push(status), 5)
    if (event === 'large') input.emit('data', Buffer.alloc(4097))
    else if (event !== 'timeout') input.emit(event)
    await new Promise((resolve) => setTimeout(resolve, 10))
    input.emit('end')
    assert.deepEqual(statuses, [event === 'large' ? 413 : event === 'timeout' ? 408 : 400])
  }
})

test('startup rejects duplicate channels, installs seams before polling, and exposes actual scoped accounts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-startup-'))
  const previous = process.env.DSH_CHANNELS_STATE_DIR
  process.env.DSH_CHANNELS_STATE_DIR = root
  const moduleFile = path.join(root, 'adapter.mjs')
  fs.writeFileSync(moduleFile, `
    export function createAdapter({ ctx, config }) {
      const audit = ctx.get('audit')
      return {
        id: 'fake', label: { zh: '测试', en: 'Fake' }, capabilities: { media: { image: false, file: false, voice: false, video: false }, maxTextChars: 600 },
        accounts: { list: async () => [{ accountId: 'actual', expired: true }] },
        async startWithSink() { audit.push('start'); if (config.fail) throw new Error('start') },
        async stop() { audit.push('stop') },
        async send() { return { ok: true, unconfirmed: true } },
      }
    }
  `)
  const audit: string[] = []
  let status!: (request: Request) => Promise<Response>
  const ctx = {
    get: (name: string) => name === 'audit' ? audit : name === 'connection' ? { requestRejection: () => undefined } : name === 'webServer' ? {
      register: (route: { path: string; resource: typeof status }) => { if (route.path === '/channels/status') status = route.resource; return () => {} },
    } : undefined,
    on: () => { audit.push('seam'); return () => {} },
  }
  try {
    const config = resolveConfig({ adapters: [moduleFile, moduleFile], allowedSenders: ['global'], allowlistPerAccount: { actual: [] } })
    const plugin = await startChannels({ ctx, config })
    assert.equal(audit.filter((event) => event === 'start').length, 1)
    assert.ok(audit.indexOf('seam') < audit.indexOf('start'))
    const response = await status(new Request('http://localhost/channels/status'))
    const payload = await response.json() as { channels: Array<{ accounts: unknown[] }> }
    assert.deepEqual(payload.channels[0]?.accounts, [{ accountId: 'actual', expired: true, allowedSenders: 0 }])
    await plugin.dispose()
    for (const failure of [{ fail: true }]) {
      const failed = await startChannels({ ctx, config: resolveConfig({ adapters: [moduleFile], adapterConfig: { [moduleFile]: failure } }) })
      assert.equal(failed.runtime.adapters().length, 0)
      assert.equal(failed.adapters.length, 0)
      await failed.dispose()
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_CHANNELS_STATE_DIR
    else process.env.DSH_CHANNELS_STATE_DIR = previous
    fs.rmSync(root, { recursive: true })
  }
})

test('startup refuses legacy-only adapters before registration or polling', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-legacy-adapter-'))
  const previous = process.env.DSH_CHANNELS_STATE_DIR
  process.env.DSH_CHANNELS_STATE_DIR = root
  const moduleFile = path.join(root, 'legacy.mjs')
  fs.writeFileSync(moduleFile, `export function createAdapter() { return {
    id: 'legacy', label: { zh: '旧', en: 'Legacy' },
    capabilities: { media: {}, maxTextChars: 600 },
    accounts: { list: async () => [] },
    onInbound() { throw new Error('legacy subscription must not run') },
    async start() { throw new Error('legacy polling must not run') },
    async stop() {}, async send() { return { ok: true, unconfirmed: true } },
  } }`)
  const warnings: string[] = []
  try {
    const plugin = await startChannels({ ctx: { logger: { warn: (line: string) => warnings.push(line), info() {} } }, config: resolveConfig({ adapters: [moduleFile] }) })
    try {
      assert.equal(plugin.adapters.length, 0)
      assert.equal(plugin.runtime.adapters().length, 0)
      assert.match(warnings.join('\n'), /startWithSink/)
    } finally { await plugin.dispose() }
  } finally {
    if (previous === undefined) delete process.env.DSH_CHANNELS_STATE_DIR
    else process.env.DSH_CHANNELS_STATE_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
