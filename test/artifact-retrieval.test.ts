import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { parseCommand, TASK_CONTROLS } from '../packages/core/src/commands.js'
import { createChannelsRuntime, createFakeAdapter, createFakeUserMessage } from './runtime-helper.js'
import { createHarness, inbound } from './harness.js'
import { stateFile } from '../packages/core/src/store/state.js'

async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await delay(5) }
  assert.ok(check(), 'expected command result')
}

function fixture(extra: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-artifacts-'))
  const dir = fs.mkdtempSync(path.join(root, '.channel-output-'))
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'chart.png'), 'png')
  fs.writeFileSync(path.join(dir, 'sub/report.md'), 'report')
  const task = { id: 'aaaaaaaa-1111-2222-3333-444444444444', target: { channel: 'fake', accountId: 'acct', conversationId: 'conv' }, senderId: 'sender', summary: 'make report', startedAt: Date.now() - 1000, endedAt: Date.now(), execution: 'completed', delivery: 'sent', outputDirectory: dir, artifacts: ['chart.png', 'sub/report.md'], ...extra }
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify([task]))
  const h = createHarness()
  const runtime = createChannelsRuntime({ stateRoot: root, workingDirectory: root, ctx: h.ctx, config: { allowedSenders: ['sender', 'other'], maxProducedBytes: 16 } })
  const adapter = createFakeAdapter(); runtime.register(adapter)
  const text = () => adapter.sent.map((entry) => entry.outgoing.text ?? '').join('\n')
  const media = () => adapter.sent.flatMap((entry) => entry.outgoing.media ?? [])
  const close = async () => { await runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }) }
  return { root, dir, task, h, runtime, adapter, text, media, close }
}

test('artifact commands preserve arguments, support Telegram suffixes and are direct controls', () => {
  assert.deepEqual(parseCommand('/files@bot #aaaaaaaa'), { name: 'files', args: '#aaaaaaaa' })
  assert.deepEqual(parseCommand('/resend aaaaaaaa 2'), { name: 'resend', args: 'aaaaaaaa 2' })
  for (const name of ['files', 'resend']) assert.ok(TASK_CONTROLS.has(name as Parameters<typeof TASK_CONTROLS.has>[0]))
})

test('listing and selecting an indexed artifact sends the original file without starting a turn', async () => {
  const f = fixture()
  try {
    fs.writeFileSync(path.join(f.dir, 'late-secret.txt'), 'not in index')
    f.runtime.dispatch(inbound({ text: '/files #aaaaaaaa' }))
    await until(() => f.text().includes('chart.png'))
    assert.match(f.text(), /1[.、].*chart\.png/)
    assert.match(f.text(), /2[.、].*sub\/report\.md/)
    assert.doesNotMatch(f.text(), /late-secret|\.channel-output-/)
    f.runtime.dispatch(inbound({ text: '/resend aaaaaaaa 2' }))
    await until(() => f.media().length === 1)
    assert.equal(path.basename(f.media()[0]!.path), 'report.md')
    assert.equal(f.h.followedUp.length, 0)
    assert.equal(f.runtime.pendingInputs(), 0)
    const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'tasks.json'), 'utf8'))
    assert.equal(saved[0].delivery, 'sent', 'a partial manual resend must not rewrite original task status')
  } finally { await f.close() }
})

test('files defaults to the latest owned completed task and image resend uses image media', async () => {
  const f = fixture()
  try {
    f.runtime.dispatch(inbound({ text: '/files' }))
    await until(() => f.text().includes('aaaaaaaa'))
    f.runtime.dispatch(inbound({ text: '/resend aaaaaaaa' }))
    await until(() => f.media().length === 1)
    assert.equal(f.media()[0]?.kind, 'image')
  } finally { await f.close() }
})

test('other chats, accounts and group senders cannot list or resend these artifacts', async () => {
  const f = fixture()
  try {
    for (const overrides of [{ conversationId: 'foreign' }, { accountId: 'foreign' }, { group: true, senderId: 'other' }]) {
      f.runtime.dispatch(inbound({ ...overrides, text: '/files aaaaaaaa' }))
      f.runtime.dispatch(inbound({ ...overrides, text: '/resend aaaaaaaa 1' }))
    }
    await delay(60)
    assert.equal(f.media().length, 0)
    assert.doesNotMatch(f.text(), /chart\.png|report\.md/)
    assert.equal(f.h.followedUp.length, 0)
  } finally { await f.close() }
})

test('missing files, symlinked files/directories and path escapes are refused before upload', async () => {
  for (const tamper of ['missing', 'file-link', 'directory-link', 'root-link', 'escape']) {
    const f = fixture(tamper === 'escape' ? { artifacts: ['../private.txt'] } : {})
    try {
      const privateFile = path.join(f.root, 'private.txt'); fs.writeFileSync(privateFile, 'private')
      const file = path.join(f.dir, 'chart.png')
      if (tamper === 'missing' || tamper === 'file-link') {
        fs.unlinkSync(file)
        if (tamper === 'file-link') fs.symlinkSync(privateFile, file)
      }
      if (tamper === 'directory-link') {
        fs.rmSync(path.join(f.dir, 'sub'), { recursive: true })
        fs.symlinkSync(f.root, path.join(f.dir, 'sub'))
      }
      if (tamper === 'root-link') {
        fs.renameSync(f.dir, `${f.dir}.old`); fs.symlinkSync(`${f.dir}.old`, f.dir)
      }
      f.runtime.dispatch(inbound({ text: `/resend aaaaaaaa ${tamper === 'directory-link' ? 2 : 1}` }))
      await until(() => /文件不可用/.test(f.text()))
      assert.equal(f.media().length, 0, tamper)
      assert.equal(f.h.followedUp.length, 0)
    } finally { await f.close() }
  }
})

test('resend rejects oversized output and reports failed or unconfirmed platform acceptance', async () => {
  const large = fixture()
  try {
    fs.writeFileSync(path.join(large.dir, 'chart.png'), 'x'.repeat(100))
    large.runtime.dispatch(inbound({ text: '/resend aaaaaaaa 1' }))
    await until(() => large.adapter.sent.length > 0)
    assert.equal(large.media().length, 0)
    assert.match(large.text(), /大小|上限/)
  } finally { await large.close() }
  for (const outcome of ['failed', 'unconfirmed']) {
    const f = fixture()
    const send = f.adapter.send
    f.adapter.send = async (target, outgoing) => outgoing.media?.length
      ? outcome === 'failed' ? { ok: false, code: 'offline' } : { ok: true, unconfirmed: true }
      : send(target, outgoing)
    try {
      f.runtime.dispatch(inbound({ text: '/resend aaaaaaaa 1' }))
      await until(() => /重发失败|未确认/.test(f.text()))
      assert.equal(f.runtime.outbox.list().length, 0)
    } finally { await f.close() }
  }
})

test('a legacy task without an artifact index never scans arbitrary workspace files', async () => {
  const f = fixture({ outputDirectory: undefined, artifacts: undefined })
  try {
    f.runtime.dispatch(inbound({ text: '/files aaaaaaaa' }))
    await until(() => f.adapter.sent.length > 0)
    assert.match(f.text(), /没有.*产物|未记录.*产物/)
    assert.equal(f.media().length, 0)
    assert.equal(f.h.followedUp.length, 0)
  } finally { await f.close() }
})

test('new task artifacts are persisted before delivery and can be recovered after restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-artifact-capture-'))
  const source = path.join(root, 'new.png')
  fs.writeFileSync(source, 'png')
  const h = createHarness({ deliverables: () => [{ path: source }] })
  const open = () => createChannelsRuntime({ stateRoot: root, workingDirectory: root, ctx: h.ctx, config: { senderPerMinute: 1 } })
  const first = open(); first.register(createFakeAdapter())
  try {
    first.dispatch(inbound({ text: 'create image' }))
    await until(() => fs.existsSync(path.join(root, 'tasks.json')) && JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8'))[0]?.delivery === 'sent')
    const task = JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8'))[0]
    assert.deepEqual(task.artifacts, ['new.png'])
    assert.ok(task.outputDirectory)
    await first.dispose()
    const next = open(); const adapter = createFakeAdapter(); next.register(adapter)
    try {
      next.dispatch(inbound({ text: `/resend ${task.id.slice(0, 8)}` }))
      await until(() => adapter.sent.some((entry) => entry.outgoing.media?.length === 1))
      assert.equal(h.followedUp.length, 1)
    } finally { await next.dispose() }
  } finally { await first.dispose(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('resend snapshots verified bytes before the adapter waits, then removes its temporary copy', async () => {
  const f = fixture()
  const send = f.adapter.send
  let uploaded = ''; let sentPath = ''
  f.adapter.send = async (target, outgoing) => {
    if (!outgoing.media?.length) return send(target, outgoing)
    const original = path.join(f.dir, 'chart.png')
    const privateFile = path.join(f.root, 'private.txt'); fs.writeFileSync(privateFile, 'PRIVATE')
    fs.unlinkSync(original); fs.symlinkSync(privateFile, original)
    sentPath = outgoing.media[0]!.path
    uploaded = fs.readFileSync(sentPath, 'utf8')
    return { ok: true, messageId: 'sent' }
  }
  try {
    f.runtime.dispatch(inbound({ text: '/resend aaaaaaaa 1' }))
    await until(() => f.text().includes('文件已发送'))
    assert.equal(uploaded, 'png')
    assert.equal(fs.existsSync(sentPath), false)
  } finally { await f.close() }
})

test('ambiguous task prefixes and invalid file numbers do not upload or invoke a model', async () => {
  const f = fixture()
  try {
    await f.runtime.dispose()
    fs.writeFileSync(path.join(f.root, 'tasks.json'), JSON.stringify([f.task, { ...f.task, id: 'aaaaaaaa-9999-2222-3333-444444444444' }]))
    const runtime = createChannelsRuntime({ stateRoot: f.root, workingDirectory: f.root, ctx: f.h.ctx })
    const adapter = createFakeAdapter(); runtime.register(adapter)
    try {
      runtime.dispatch(inbound({ text: '/resend aaaaaaaa 1' }))
      await until(() => adapter.sent.some((entry) => entry.outgoing.text?.includes('不唯一')))
      runtime.dispatch(inbound({ text: '/resend aaaaaaaa-1111 0' }))
      runtime.dispatch(inbound({ text: '/resend aaaaaaaa-1111 ../../private' }))
      runtime.dispatch(inbound({ text: '/files ../../private' }))
      await delay(25)
      assert.equal(adapter.sent.flatMap((entry) => entry.outgoing.media ?? []).length, 0)
      assert.equal(f.h.followedUp.length, 0)
    } finally { await runtime.dispose() }
  } finally { await f.close() }
})

test('artifact controls remain available when the ordinary turn quota is exhausted', async () => {
  const f = fixture()
  try {
    for (let i = 0; i < f.runtime.config.senderPerMinute; i++) assert.ok(f.runtime.gateContext().minute.take(JSON.stringify(['fake', 'acct', 'sender'])))
    assert.equal(f.runtime.canReceive(inbound({ text: '/files aaaaaaaa' })), true)
    f.runtime.dispatch(inbound({ text: '/files aaaaaaaa' }))
    await until(() => f.text().includes('chart.png'))
    assert.equal(f.runtime.canReceive(inbound({ text: '/resend aaaaaaaa 1' })), true)
    f.runtime.dispatch(inbound({ text: '/resend aaaaaaaa 1' }))
    await until(() => f.media().length === 1)
    assert.equal(f.h.followedUp.length, 0)
  } finally { await f.close() }
})

test('bounded multi-chunk copies retain file bytes and clean up after a failed upload', async () => {
  const f = fixture()
  const data = Buffer.alloc(160000, 0x61); data[90000] = 0x42
  f.runtime.config.maxProducedBytes = 200000
  fs.writeFileSync(path.join(f.dir, 'chart.png'), data)
  let staged = ''; let copied: Buffer | undefined
  const send = f.adapter.send
  f.adapter.send = async (target, outgoing) => {
    if (!outgoing.media?.length) return send(target, outgoing)
    staged = outgoing.media[0]!.path; copied = fs.readFileSync(staged)
    return { ok: false, code: 'offline' }
  }
  try {
    f.runtime.dispatch(inbound({ text: '/resend aaaaaaaa 1' }))
    await until(() => f.text().includes('重发失败'))
    assert.deepEqual(copied, data)
    assert.equal(fs.existsSync(staged), false)
  } finally { await f.close() }
})

test('an artifact-index write failure is disclosed while the completed result is still delivered', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-artifact-failure-'))
  const h = createHarness({ onFollowup() {
    stateFile(root).failNextWrite('tasks')
  } })
  const runtime = createChannelsRuntime({ stateRoot: root, workingDirectory: root, ctx: h.ctx, config: { legacyOutputScan: true }, createUserMessage(fields) {
    const blocks = fields['content'] as Array<{ text: string }>
    const directory = /directory: (.+)\.$/m.exec(blocks[0]?.text ?? '')?.[1]
    if (directory) fs.writeFileSync(path.join(directory, 'image.png'), 'png')
    return createFakeUserMessage(fields)
  } })
  const adapter = createFakeAdapter(); runtime.register(adapter)
  try {
    runtime.dispatch(inbound({ text: 'make image' }))
    await until(() => adapter.sent.some((entry) => entry.outgoing.media?.length === 1))
    assert.ok(adapter.sent.some((entry) => /产物索引.*未能保存/.test(entry.outgoing.text ?? '')))
  } finally { await runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }) }
})
