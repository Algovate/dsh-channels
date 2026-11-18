import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createHarness, inbound } from './harness.js'
import { resetStateFile, stateFile } from '../packages/core/src/store/state.js'
import { createChannelsRuntime, createFakeAdapter } from './runtime-helper.js'

async function until(check: () => boolean) { for (let i = 0; i < 150 && !check(); i++) await delay(10); assert.ok(check()) }
function fixture(offThrows = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-schedules-')); const h = createHarness(); const adapter = createFakeAdapter()
  const records: Array<Record<string, any>> = []; const creates: Array<Record<string, any>> = []; const edits: Array<Record<string, any>> = []; const events = new Map<string, Array<Record<string, any>>>()
  const hooks = new Map<string, (...args: any[]) => any>(); let closes = 0
  const service = {
    async create(request: Record<string, any>) { creates.push(request); const entry = { id: `native-${creates.length}`, ...request, status: 'active', updatedAt: 'revision1', involvedSessionIds: [request.target.sessionId] }; records.push(entry); return entry },
    catalog() { return records },
    async edit(request: Record<string, any>) { edits.push(request); const index = records.findIndex((record) => record.id === request.id); if (index < 0) return { code: 'schedule_not_found' }; if (request.action === 'delete') { records.splice(index, 1); return { deleted: true } } Object.assign(records[index]!, request.patch.active === false ? { status: 'paused' } : { status: 'active' }); return records[index] },
    async history({ id }: { id: string }) { const item = records.find((record) => record.id === id); return { records: item?.receipts ?? [] } },
  }
  const persistence = { async open(id: string, access: string) { assert.equal(access, 'read'); return { header: { cwd: root }, async read(offset = 0, length = 1000) { return { events: (events.get(id) ?? []).slice(offset, offset + length) } }, async close() { closes++ } } } }
  const ctx = { get(name: string) { return name === 'schedule' ? service : name === 'sessionPersistence' ? persistence : h.ctx.get(name) }, on(name: string, listener: (...args: any[]) => any) { hooks.set(name, listener); return () => { hooks.delete(name); if (offThrows) throw new Error('off failed') } } }
  const open = () => createChannelsRuntime({ ctx, stateRoot: root, workingDirectory: root, config: { allowedSenders: ['sender', 'other'], senderPerMinute: 0, senderPerDay: 0 } })
  let runtime = open(); runtime.register(adapter)
  const send = (text: string, extra = {}) => runtime.dispatch(inbound({ text, ...extra }))
  const text = () => adapter.sent.map((item) => item.outgoing.text ?? '').join('\n')
  const binding = () => JSON.parse(fs.readFileSync(path.join(root, 'schedules.json'), 'utf8')).bindings[0]
  const sync = () => (runtime as unknown as { syncSchedules(): Promise<void> }).syncSchedules()
  return { root, h, adapter, get runtime() { return runtime }, async restart() { await runtime.dispose(); runtime = open(); runtime.register(adapter) }, service, persistence, records, creates, edits, events, hooks, send, text, binding, sync, closes: () => closes, async close() { await runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }) } }
}

test('schedule commands explain missing native capability without starting a model', async () => {
  const h = createHarness(); const runtime = h.makeRuntime(); const adapter = createFakeAdapter(); runtime.register(adapter)
  try { runtime.dispatch(inbound({ text: '/schedules' })); await delay(40); assert.match(adapter.sent.at(-1)?.outgoing.text ?? '', /宿主.*未|不可用/); assert.equal(h.followedUp.length, 0) }
  finally { await runtime.dispose() }
})

test('create binds a dedicated native session and management remains scoped to chat and group sender', async () => {
  const f = fixture()
  try {
    f.send('/schedule every 10 检查部署'); await until(() => f.creates.length === 1)
    assert.deepEqual(f.creates[0]!.timing, { kind: 'every', every_seconds: 600 })
    const saved = f.binding(); assert.match(saved.sessionId, /^chan-schedule-/); assert.equal(saved.message.conversationId, 'conv'); assert.equal(saved.workingDirectory, f.root)
    assert.equal(f.h.followedUp.length, 0)
    f.send('/schedules', { conversationId: 'foreign' }); await until(() => f.text().includes('暂无'))
    f.send(`/schedule pause ${saved.id.slice(0, 8)}`, { group: true, senderId: 'other' }); await delay(30); assert.equal(f.edits.length, 0)
    f.send(`/schedule pause ${saved.id.slice(0, 8)}`); await until(() => f.edits.length === 1); assert.equal(f.edits[0]!.patch.active, false)
  } finally { await f.close() }
})

test('creation intent must be durable before any native schedule is created', async () => {
  const f = fixture(); stateFile(f.root).failNextWrite('schedules')
  try { f.send('/schedule after 1 提醒我'); await until(() => f.text().includes('保存') || f.text().includes('失败')); assert.equal(f.creates.length, 0) }
  finally { await f.close() }
})

test('a receipt is not a result; only its matching completed turn is relayed and retained across restart', async () => {
  const f = fixture()
  try {
    f.send('/schedule after 1 检查部署'); await until(() => f.creates.length === 1); const saved = f.binding(); const record = f.records[0]!
    record.receipts = [{ messageId: 'scheduled-input', targetSessionId: saved.sessionId, scheduledAt: 'later', deliveredAt: 'now' }]
    f.events.set(saved.sessionId, [{ seq: 0, type: 'turn/start', data: { turn: 1 } }, { seq: 1, type: 'user/message', data: { id: 'desktop' } }, { seq: 2, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'private desktop result' }] } } }, { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }])
    await f.sync(); assert.doesNotMatch(f.text(), /private desktop result/)
    f.events.get(saved.sessionId)!.push({ seq: 4, type: 'turn/start', data: { turn: 2 } }, { seq: 5, type: 'user/message', data: { id: 'scheduled-input' } }, { seq: 6, type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: '部署正常' }] } } })
    await f.sync(); assert.doesNotMatch(f.text(), /部署正常/)
    await f.restart()
    f.events.get(saved.sessionId)!.push({ seq: 7, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await f.sync(); assert.match(f.text(), /部署正常/); const count = f.adapter.sent.length
    await f.sync(); assert.equal(f.adapter.sent.length, count); assert.ok(f.closes() >= 1); assert.equal(f.h.followedUp.length, 0)
  } finally { await f.close() }
})

test('a committed native create with a lost response is reconciled after restart without another create', async () => {
  const f = fixture(); const original = f.service.create.bind(f.service)
  f.service.create = async (request) => { await original(request); throw new Error('response lost') }
  try {
    f.send('/schedule after 1 检查部署'); await until(() => f.text().includes('response lost'))
    assert.equal(f.binding().scheduleId, undefined); await f.restart(); await f.sync()
    assert.equal(f.binding().scheduleId, 'native-1'); assert.equal(f.creates.length, 1)
  } finally { await f.close() }
})

test('corrupt attribution blocks native activation and preserves the state file', async () => {
  const f = fixture()
  try {
    f.send('/schedule after 1 检查部署'); await until(() => f.creates.length === 1); const id = f.binding().sessionId
    fs.writeFileSync(path.join(f.root, 'state.json'), '{'); resetStateFile(f.root); await f.restart()
    const hook = f.hooks.get('schedule/resolve-agent')!
    await assert.rejects(hook(id, async () => ({ secret: true })), /不可读/)
    f.send('/schedules'); await until(() => f.text().includes('不可读'))
    assert.equal(fs.readFileSync(path.join(f.root, 'state.json'), 'utf8'), '{')
  } finally { await f.close() }
})

test('revoked senders and native target changes cannot activate or relay an owned plan', async () => {
  const f = fixture()
  try {
    f.send('/schedule after 1 检查部署'); await until(() => f.creates.length === 1); const saved = f.binding(); const hook = f.hooks.get('schedule/resolve-agent')!
    let activated = 0; const next = async () => { activated++; return {} }
    await hook(saved.sessionId, next); assert.equal(activated, 1)
    f.runtime.updateAllowlist({ remove: 'sender' }); await assert.rejects(hook(saved.sessionId, next), /权限|归属/)
    f.runtime.updateAllowlist({ add: 'sender' }); f.records[0]!.target.sessionId = 'unrelated-desktop'
    await assert.rejects(hook(saved.sessionId, next), /目标/)
    f.send(`/schedule pause ${saved.id.slice(0, 8)}`); await delay(30); assert.equal(f.edits.length, 0)
    await f.sync(); assert.equal(f.closes(), 0)
  } finally { await f.close() }
})

test('native completion is handed to durable outbox once when the platform send fails', async () => {
  const f = fixture()
  try {
    f.send('/schedule after 1 检查部署'); await until(() => f.creates.length === 1); const saved = f.binding()
    f.records[0]!.receipts = [{ messageId: 'scheduled', targetSessionId: saved.sessionId }]
    f.events.set(saved.sessionId, [{ seq: 0, type: 'turn/start', data: { turn: 1 } }, { seq: 1, type: 'user/message', data: { id: 'scheduled' } }, { seq: 2, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '任务结果' }] } } }, { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }])
    f.adapter.send = async () => ({ ok: false, code: 'temporary' })
    await f.sync(); assert.equal(f.runtime.outbox.list().length, 1); assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'schedules.json'), 'utf8')).pending.length, 0)
    await f.restart(); await f.sync(); assert.equal(f.runtime.outbox.list().length, 1); assert.equal(f.h.followedUp.length, 0)
  } finally { await f.close() }
})

function completed(f: ReturnType<typeof fixture>) {
  const saved = f.binding(); f.records[0]!.receipts = [{ messageId: 'scheduled', targetSessionId: saved.sessionId }]
  f.events.set(saved.sessionId, [{ seq: 0, type: 'turn/start', data: { turn: 1 } }, { seq: 1, type: 'user/message', data: { id: 'scheduled' } }, { seq: 2, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'private scheduled output' }] } } }, { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }])
}

test('outbox retries cancel scheduled results after the sender is revoked', async () => {
  const f = fixture()
  try {
    f.send('/schedule after 1 检查部署'); await until(() => f.creates.length === 1); completed(f)
    const send = f.adapter.send; f.adapter.send = async () => ({ ok: false, code: 'temporary' }); await f.sync()
    const file = path.join(f.root, 'outbox.json'); const saved = JSON.parse(fs.readFileSync(file, 'utf8')); saved.items[0].nextAt = 0; fs.writeFileSync(file, JSON.stringify(saved))
    f.adapter.send = send; f.runtime.updateAllowlist({ remove: 'sender' }); f.runtime.startOutboxRetry(5)
    await until(() => f.runtime.outbox.list().length === 0)
    assert.doesNotMatch(f.text(), /private scheduled output/)
  } finally { await f.close() }
})

test('durable pending results do not send after native destination reassignment', async () => {
  const f = fixture()
  try {
    f.send('/schedule after 1 检查部署'); await until(() => f.creates.length === 1); completed(f)
    const send = f.adapter.send; fs.writeFileSync(path.join(f.root, 'outbox.json'), '{'); f.adapter.send = async () => ({ ok: false, code: 'temporary' }); await f.sync()
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'schedules.json'), 'utf8')).pending.length, 1)
    f.records[0]!.target.sessionId = 'foreign'; f.adapter.send = send
    fs.writeFileSync(path.join(f.root, 'outbox.json'), JSON.stringify({ schemaVersion: 1, items: [] }))
    await f.sync(); assert.doesNotMatch(f.text(), /private scheduled output/)
  } finally { await f.close() }
})

test('an unconfirmed failed creation can be cancelled and late native activation remains blocked', async () => {
  const f = fixture(); f.service.create = async () => { throw new Error('create uncertain') }
  try {
    f.send('/schedule after 1 检查部署'); await until(() => f.text().includes('create uncertain')); const saved = f.binding()
    f.send(`/schedule delete ${saved.id.slice(0, 8)}`); await until(() => f.text().includes('删除') || f.text().includes('取消'))
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'schedules.json'), 'utf8')).bindings.length, 0)
    await assert.rejects(f.hooks.get('schedule/resolve-agent')!(saved.sessionId, async () => ({})))
  } finally { await f.close() }
})

test('emoji prompts produce a valid native title', async () => {
  const f = fixture()
  try { f.send(`/schedule after 1 ${'😀'.repeat(61)}`); await until(() => f.creates.length > 0); assert.ok(f.creates[0]!.title.length <= 120) }
  finally { await f.close() }
})

test('schedule creation refuses attachments instead of silently discarding them', async () => {
  const f = fixture()
  try { f.send('/schedule after 1 分析此附件', { media: [{ kind: 'file', path: '/tmp/report.txt', mime: 'text/plain', bytes: 10 }] }); await until(() => f.text().includes('附件')); assert.equal(f.creates.length, 0) }
  finally { await f.close() }
})

test('a native header using the canonical spelling of the original directory can relay results', async () => {
  const f = fixture(); const open = f.persistence.open.bind(f.persistence)
  f.persistence.open = async (id, access) => { const handle = await open(id, access); handle.header.cwd = fs.realpathSync(f.root); return handle }
  try { f.send('/schedule after 1 检查部署'); await until(() => f.creates.length === 1); completed(f); await f.sync(); assert.match(f.text(), /private scheduled output/) }
  finally { await f.close() }
})

test('schedule hook cleanup cannot prevent runtime disposal', async () => {
  const f = fixture(true)
  try { await assert.doesNotReject(f.runtime.dispose()); assert.equal(f.hooks.size, 0) }
  finally { await f.close() }
})

test('shutdown during outbox authorization retains the result without sending or cancelling it', async () => {
  const f = fixture(); let release!: (value: typeof f.records) => void
  try {
    f.send('/schedule after 1 检查部署'); await until(() => f.creates.length === 1); completed(f)
    const send = f.adapter.send; f.adapter.send = async () => ({ ok: false, code: 'temporary' }); await f.sync()
    const file = path.join(f.root, 'outbox.json'); const saved = JSON.parse(fs.readFileSync(file, 'utf8')); saved.items[0].nextAt = 0; fs.writeFileSync(file, JSON.stringify(saved))
    let reads = 0; const pending = new Promise<typeof f.records>((resolve) => { release = resolve })
    Object.assign(f.service, { catalog() { reads++; return pending } }); f.adapter.send = send
    f.runtime.startOutboxRetry(5); await until(() => reads >= 2)
    await f.runtime.dispose(); release(f.records); await delay(30)
    assert.equal(f.runtime.outbox.list().length, 1); assert.doesNotMatch(f.text(), /private scheduled output/)
  } finally { release?.(f.records); await f.close() }
})

test('queued schedule mutations recheck sender permission after earlier operations finish', async () => {
  const f = fixture(); const create = f.service.create.bind(f.service); let release!: () => void
  const wait = new Promise<void>((resolve) => { release = resolve })
  f.service.create = async (request) => { const result = await create(request); await wait; return result }
  try {
    f.send('/schedule after 1 first'); await until(() => f.creates.length === 1)
    f.send('/schedule after 2 second'); f.runtime.updateAllowlist({ remove: 'sender' }); release()
    await until(() => f.text().includes('权限'))
    assert.equal(f.creates.length, 1)
  } finally { release(); await f.close() }
})

test('native activation cannot continue after disposal while catalog lookup is pending', async () => {
  const f = fixture(); let release!: (records: typeof f.records) => void
  try {
    f.send('/schedule after 1 检查部署'); await until(() => f.creates.length === 1); const saved = f.binding()
    let catalog = false; const wait = new Promise<typeof f.records>((resolve) => { release = resolve })
    Object.assign(f.service, { catalog() { catalog = true; return wait } })
    let activated = false; const activation = f.hooks.get('schedule/resolve-agent')!(saved.sessionId, async () => { activated = true; return {} })
    const refused = assert.rejects(activation)
    await until(() => catalog); await f.runtime.dispose(); release(f.records)
    await refused; assert.equal(activated, false)
  } finally { release?.(f.records); await f.close() }
})

test('permission revoked while a dedicated session is being attached prevents native creation', async () => {
  const f = fixture(); const create = f.h.agentsService.create.bind(f.h.agentsService); let release!: () => void
  const wait = new Promise<void>((resolve) => { release = resolve })
  f.h.agentsService.create = async (request) => { const result = await create(request); await wait; return result }
  try {
    f.send('/schedule after 1 检查部署'); await until(() => f.h.created.length === 1)
    f.runtime.updateAllowlist({ remove: 'sender' }); release()
    await until(() => f.text().includes('权限')); assert.equal(f.creates.length, 0)
  } finally { release(); await f.close() }
})

test('a native activation rejects permissions revoked while its catalog lookup was waiting', async () => {
  const f = fixture(); let release!: (records: typeof f.records) => void
  try {
    f.send('/schedule after 1 检查部署'); await until(() => f.creates.length === 1); const saved = f.binding()
    let entered = false; const wait = new Promise<typeof f.records>((resolve) => { release = resolve })
    Object.assign(f.service, { catalog() { entered = true; return wait } })
    let activated = false; const activation = f.hooks.get('schedule/resolve-agent')!(saved.sessionId, async () => { activated = true; return {} }); const refused = assert.rejects(activation, /权限/)
    await until(() => entered); f.runtime.updateAllowlist({ remove: 'sender' }); release(f.records)
    await refused; assert.equal(activated, false)
  } finally { release?.(f.records); await f.close() }
})

test('deleting a binding while activation awaits a stale native catalog prevents activation', async () => {
  const f = fixture(); let release!: (records: typeof f.records) => void
  try {
    f.send('/schedule after 1 检查部署'); await until(() => f.creates.length === 1); const saved = f.binding(); const stale = [...f.records]
    let lookups = 0; const wait = new Promise<typeof f.records>((resolve) => { release = resolve })
    Object.assign(f.service, { catalog() { return ++lookups === 1 ? wait : f.records } })
    let activated = false; const activation = f.hooks.get('schedule/resolve-agent')!(saved.sessionId, async () => { activated = true; return {} }); const refused = assert.rejects(activation)
    await until(() => lookups > 0); f.send(`/schedule delete ${saved.id.slice(0, 8)}`)
    await until(() => JSON.parse(fs.readFileSync(path.join(f.root, 'schedules.json'), 'utf8')).bindings.length === 0)
    release(stale); await refused; assert.equal(activated, false)
  } finally { release?.(f.records); await f.close() }
})

test('removing the original project during an account lookup prevents native activation', async () => {
  const f = fixture(); let release!: () => void
  try {
    f.runtime.config.projects.app = f.root; f.send('/project app'); await until(() => f.text().includes('已切换'))
    f.send('/schedule after 1 检查部署'); await until(() => f.creates.length === 1); const saved = f.binding()
    let entered = false; let checks = 0; const wait = new Promise<void>((resolve) => { release = resolve })
    f.adapter.accounts.list = async () => { if (++checks === 2) { entered = true; await wait } return [{ accountId: 'acct', expired: false }] }
    let activated = false; const activation = f.hooks.get('schedule/resolve-agent')!(saved.sessionId, async () => { activated = true; return {} }); const refused = assert.rejects(activation)
    await until(() => entered); delete f.runtime.config.projects.app; release()
    await refused; assert.equal(activated, false)
  } finally { release?.(); await f.close() }
})

test('an authorized owner can delete a schedule after its original project is removed', async () => {
  const f = fixture()
  try {
    f.runtime.config.projects.app = f.root; f.send('/project app'); await until(() => f.text().includes('已切换'))
    f.send('/schedule after 1 检查部署'); await until(() => f.creates.length === 1); const saved = f.binding()
    delete f.runtime.config.projects.app; f.send(`/schedule delete ${saved.id.slice(0, 8)}`)
    await until(() => f.records.length === 0)
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'schedules.json'), 'utf8')).bindings.length, 0)
  } finally { await f.close() }
})
