import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createHarness, inbound } from './harness.js'
import { createChannelsRuntime, createFakeAdapter } from './runtime-helper.js'
import { stateFile, resetStateFile } from '../packages/core/src/store/state.js'
import type { OutboxFile } from '../packages/core/src/store/outbox.js'

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await delay(5)
  assert.ok(check())
}

function fixture(reply: string, files: string[] = [], present = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-media-'))
  const h = createHarness({ reply, onFollowup() {
    for (const file of files) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), `bytes:${file}`) }
  }, ...(present ? { deliverables: () => files.map((file) => ({ path: path.join(root, file) })) } : {}) })
  const runtime = createChannelsRuntime({ stateRoot: root, workingDirectory: root, ctx: h.ctx })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  const task = () => stateFile(root).read<Array<{ execution: string; delivery: string; artifacts?: string[]; filesUnsent?: boolean }>>('tasks')?.[0]
  return { root, h, runtime, adapter, task, async run(extra: Record<string, unknown> = {}) { runtime.dispatch(inbound(extra)); await until(() => task()?.execution === 'completed' && task()?.delivery !== 'sending') }, async close() { await runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }) } }
}

test('a generated inline image is delivered even when the image skill omits present', async () => {
  const f = fixture('画好了\n\n![战机轰炸军舰](output/aircraft-bombing-warship.png)', ['output/aircraft-bombing-warship.png'])
  const uploaded: string[] = []
  const send = f.adapter.send
  f.adapter.send = async (target, outgoing) => {
    for (const media of outgoing.media ?? []) uploaded.push(fs.readFileSync(media.path, 'utf8'))
    return send(target, outgoing)
  }
  try {
    await f.run()
    await until(() => uploaded.length === 1 && f.task()?.delivery === 'sent')
    assert.deepEqual(uploaded, ['bytes:output/aircraft-bombing-warship.png'])
    assert.deepEqual(f.task()?.artifacts, ['aircraft-bombing-warship.png'])
    assert.equal(f.task()?.delivery, 'sent')
    const input = f.h.followedUp[0]!.message as { content: Array<{ text: string }>; source: { hasOutputInstruction?: boolean } }
    assert.match(input.content[0]!.text, /present/)
    assert.equal(input.content.at(-1)?.text, '你好')
    assert.equal(input.source.hasOutputInstruction, true)
  } finally { await f.close() }
})

test('the same file declared with present and an inline image is uploaded once', async () => {
  const f = fixture('![成品](<output/a (1).png>)', ['output/a (1).png'], true)
  try {
    await f.run()
    await until(() => f.adapter.sent.flatMap((item) => item.outgoing.media ?? []).length === 1 && f.task()?.delivery === 'sent')
    assert.equal(f.adapter.sent.flatMap((item) => item.outgoing.media ?? []).length, 1)
  } finally { await f.close() }
})

test('a missing linked image cannot be reported as fully delivered', async () => {
  const f = fixture('![成品](output/missing.png)')
  try {
    await f.run()
    assert.equal(f.task()?.delivery, 'failed')
    assert.equal(f.task()?.filesUnsent, true)
    assert.ok(f.adapter.sent.some((item) => /附件未发送/.test(item.outgoing.text ?? '')))
  } finally { await f.close() }
})

test('code examples and remote images are not automatic local attachment declarations', async () => {
  const f = fixture('```md\n![example](output/example.png)\n```\n`![inline](output/inline.png)`\n![remote](https://example.com/image.png)\n[source](output/source.ts)', ['output/example.png', 'output/inline.png', 'output/source.ts'])
  try {
    await f.run()
    assert.equal(f.adapter.sent.flatMap((item) => item.outgoing.media ?? []).length, 0)
  } finally { await f.close() }
})

test('a linked image outside the workspace is rejected without uploading it', async () => {
  const secretRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-secret-'))
  const secret = path.join(secretRoot, 'private.png')
  fs.writeFileSync(secret, 'private')
  const f = fixture(`![secret](<${secret}>)`)
  try {
    await f.run()
    assert.equal(f.adapter.sent.flatMap((item) => item.outgoing.media ?? []).length, 0)
    assert.equal(f.task()?.delivery, 'failed')
  } finally { await f.close(); fs.rmSync(secretRoot, { recursive: true }) }
})

function ready(root: string) {
  const store = stateFile(root)
  const box = store.read<OutboxFile>('outbox')!
  for (const entry of box.items) entry.nextAt = 0
  assert.equal(store.write('outbox', box), true)
}

test('the whole text and attachment plan is saved before the first platform call', async () => {
  const f = fixture('result ready', ['output/image.png'], true)
  let pendingFiles = 0
  const send = f.adapter.send
  f.adapter.send = async (target, outgoing) => {
    if (outgoing.text === 'result ready') {
      const box = stateFile(f.root).read<{ items: Array<{ attachments?: Array<{ sha256: string }> }> }>('outbox')!
      pendingFiles = box.items[0]?.attachments?.length ?? 0
      assert.match(box.items[0]?.attachments?.[0]?.sha256 ?? '', /^[a-f0-9]{64}$/)
    }
    return send(target, outgoing)
  }
  try {
    await f.run()
    await until(() => f.adapter.sent.some((item) => (item.outgoing.media?.length ?? 0) > 0) && f.task()?.delivery === 'sent')
    assert.equal(pendingFiles, 1)
  } finally { await f.close() }
})

test('a failed attachment is retried without repeating acknowledged text or executing tools', async () => {
  const f = fixture('result ready', ['output/image.png'], true)
  let fail = true
  let attempts = 0
  const uploaded: string[] = []
  const send = f.adapter.send
  f.adapter.send = async (target, outgoing) => {
    if (outgoing.media?.length) {
      attempts++
      uploaded.push(fs.readFileSync(outgoing.media[0]!.path, 'utf8'))
      if (fail) return { ok: false, code: 'offline' }
    }
    return send(target, outgoing)
  }
  try {
    await f.run()
    await until(() => attempts === 1 && f.runtime.outbox.list()[0]?.lastCode === 'offline')
    assert.equal(f.runtime.outbox.list().length, 1)
    fail = false; ready(f.root); f.runtime.startOutboxRetry(5)
    await until(() => f.runtime.outbox.list().length === 0 && attempts === 2)
    assert.deepEqual(uploaded, ['bytes:output/image.png', 'bytes:output/image.png'])
    assert.equal(f.adapter.sent.filter((item) => item.outgoing.text === 'result ready').length, 1)
    assert.equal(f.h.followedUp.length, 1)
    assert.equal(f.task()?.delivery, 'sent')
    assert.equal(f.task()?.filesUnsent, false)
  } finally { await f.close() }
})

test('a file-only result survives restart and is uploaded from a private snapshot', async () => {
  const f = fixture('', ['output/file.png'], true)
  let attempts = 0
  f.adapter.send = async (_target, outgoing) => {
    if (outgoing.media?.length) { attempts++; return { ok: false, code: 'offline' } }
    return { ok: true, messageId: 'notice' }
  }
  let restarted: ReturnType<typeof createChannelsRuntime> | undefined
  try {
    await f.run({ raw: { contextToken: 'original-context' } }); await until(() => attempts === 1 && f.runtime.outbox.list()[0]?.lastCode === 'offline')
    assert.equal(f.runtime.outbox.list().length, 1)
    await f.runtime.dispose(); resetStateFile(f.root)
    restarted = createChannelsRuntime({ stateRoot: f.root, workingDirectory: f.root, ctx: f.h.ctx })
    const adapter = createFakeAdapter()
    const paths: string[] = []
    let restored: unknown
    adapter.restoreInbound = (message) => { restored = message.raw }
    adapter.send = async (_target, outgoing) => {
      for (const media of outgoing.media ?? []) {
        assert.deepEqual(restored, { contextToken: 'original-context' })
        paths.push(media.path)
        assert.equal(fs.readFileSync(media.path, 'utf8'), 'bytes:output/file.png')
        assert.ok(!media.path.startsWith(f.root), 'the adapter reads only a private upload snapshot')
      }
      return { ok: true, messageId: 'file' }
    }
    restarted.register(adapter); ready(f.root); restarted.startOutboxRetry(5)
    await until(() => paths.length === 1 && restarted!.outbox.list().length === 0)
    assert.equal(fs.existsSync(paths[0]!), false)
    assert.equal(f.h.followedUp.length, 1)
  } finally { await restarted?.dispose(); await f.close() }
})

test('changed artifact bytes are never uploaded by a later retry', async () => {
  const f = fixture('ready', ['output/image.png'], true)
  let attempts = 0
  const send = f.adapter.send
  f.adapter.send = async (target, outgoing) => {
    if (outgoing.media?.length) { attempts++; return { ok: false, code: 'offline' } }
    return send(target, outgoing)
  }
  try {
    await f.run(); await until(() => attempts === 1 && f.runtime.outbox.list()[0]?.lastCode === 'offline')
    assert.equal(f.runtime.outbox.list().length, 1)
    const task = stateFile(f.root).read<Array<{ outputDirectory: string; artifacts: string[] }>>('tasks')![0]!
    fs.writeFileSync(path.join(task.outputDirectory, task.artifacts[0]!), 'changed private bytes')
    ready(f.root); f.runtime.startOutboxRetry(5)
    await until(() => f.runtime.outbox.list().length === 0)
    assert.equal(attempts, 1)
    assert.equal(f.task()?.delivery, 'failed')
    assert.equal(f.task()?.filesUnsent, true)
  } finally { await f.close() }
})

test('indented code blocks and escaped image syntax do not publish local files', async () => {
  const f = fixture('Markdown example:\n\n    ![example](output/private.png)\n\nWrite \\![example](output/private.png) literally.', ['output/private.png'])
  try {
    await f.run()
    assert.equal(f.adapter.sent.flatMap((item) => item.outgoing.media ?? []).length, 0)
    assert.equal(f.task()?.artifacts?.length ?? 0, 0)
  } finally { await f.close() }
})

test('an unconfirmed file receipt survives retries of later files', async () => {
  const f = fixture('ready', ['output/a.png', 'output/b.png'], true)
  const names: string[] = []
  let retry = false
  const send = f.adapter.send
  f.adapter.send = async (target, outgoing) => {
    if (outgoing.media?.length) {
      names.push(outgoing.media[0]!.name!)
      if (names.length === 1) return { ok: true, unconfirmed: true }
      if (!retry) return { ok: false, code: 'offline' }
    }
    return send(target, outgoing)
  }
  try {
    await f.run(); await until(() => f.runtime.outbox.list()[0]?.lastCode === 'offline')
    assert.equal(names.length, 2)
    retry = true; ready(f.root); f.runtime.startOutboxRetry(5)
    await until(() => f.runtime.outbox.list().length === 0)
    assert.deepEqual(names.slice(1), [names[1], names[1]])
    assert.equal(f.task()?.delivery, 'unknown')
    assert.equal(f.task()?.filesUnsent, false)
  } finally { await f.close() }
})

test('disabling automatic files pauses already queued uploads', async () => {
  const f = fixture('ready', ['output/a.png'], true)
  let attempts = 0
  const send = f.adapter.send
  f.adapter.send = async (target, outgoing) => {
    if (outgoing.media?.length) { attempts++; return { ok: false, code: 'offline' } }
    return send(target, outgoing)
  }
  try {
    await f.run(); await until(() => f.runtime.outbox.list()[0]?.lastCode === 'offline')
    f.runtime.updateSettings({ autoSendFiles: false })
    ready(f.root); f.runtime.startOutboxRetry(5)
    await until(() => f.runtime.outbox.list()[0]?.lastCode === 'files-disabled')
    assert.equal(attempts, 1)
    assert.equal(f.runtime.outbox.list().length, 1)
  } finally { await f.close() }
})

test('a whitespace image label cannot create an unreadable outbox or lose its file', async () => {
  const f = fixture('![ ](output/a.png)', ['output/a.png'])
  try {
    await f.run()
    await until(() => f.adapter.sent.flatMap((item) => item.outgoing.media ?? []).length === 1 && f.task()?.delivery === 'sent')
    assert.equal(f.task()?.delivery, 'sent')
    resetStateFile(f.root)
    assert.doesNotThrow(() => stateFile(f.root).read('tasks'))
  } finally { await f.close() }
})

test('revocation while a retry snapshots its file prevents upload and preserves the pending part', async () => {
  const f = fixture('ready', ['output/a.png'], true)
  const asyncFs = (await import('node:fs/promises')).default
  const open = asyncFs.open
  let attempts = 0
  const send = f.adapter.send
  f.adapter.send = async (target, outgoing) => {
    if (outgoing.media?.length) { attempts++; return { ok: false, code: 'offline' } }
    return send(target, outgoing)
  }
  try {
    await f.run(); await until(() => f.runtime.outbox.list()[0]?.lastCode === 'offline')
    const task = stateFile(f.root).read<Array<{ outputDirectory: string; artifacts: string[] }>>('tasks')![0]!
    const source = path.join(task.outputDirectory, task.artifacts[0]!)
    asyncFs.open = async (...args) => {
      const handle = await open(...args)
      if (String(args[0]) === source) f.runtime.updateAllowlist({ remove: 'sender' })
      return handle
    }
    ready(f.root); f.runtime.startOutboxRetry(5)
    await until(() => f.runtime.outbox.list()[0]?.lastCode === 'task-delivery-blocked')
    assert.equal(attempts, 1)
    assert.equal(f.runtime.outbox.list().length, 1)
    assert.equal(f.h.followedUp.length, 1)
  } finally { asyncFs.open = open; await f.close() }
})

test('quoted, nested and HTML examples do not declare attachment files', async () => {
  const f = fixture('Quoted example:\n\n>     ![example](output/private.png)\n\n> ```md\n> ![example](output/private.png)\n> ```\n\n-     ![example](output/private.png)\n\n<pre>\n![example](output/private.png)\n</pre>\n\n`multiline code\n![example](output/private.png)\nend`', ['output/private.png'])
  try {
    await f.run()
    assert.equal(f.adapter.sent.flatMap((item) => item.outgoing.media ?? []).length, 0)
    assert.equal(f.task()?.artifacts?.length ?? 0, 0)
  } finally { await f.close() }
})

test('recovery after a failed handoff reuses the captured artifact instead of recopying a changed source', async () => {
  const f = fixture('ready', ['output/a.png'], true)
  const send = f.adapter.send
  f.adapter.send = async (target, outgoing) => {
    if (outgoing.text?.includes('已接收')) stateFile(f.root).failNextWrite('outbox')
    return send(target, outgoing)
  }
  let next: ReturnType<typeof createChannelsRuntime> | undefined
  try {
    await f.run()
    assert.equal(f.runtime.outbox.list().length, 0)
    assert.equal(f.task()?.delivery, 'failed')
    await f.runtime.dispose()
    fs.writeFileSync(path.join(f.root, 'output/a.png'), 'later changed source')
    next = createChannelsRuntime({ stateRoot: f.root, workingDirectory: f.root, ctx: { get(name) {
      if (name !== 'sessionPersistence') return f.h.ctx.get(name)
      return { async open() { return { header: { cwd: f.root }, async read() { return { events: f.h.events } }, async close() {} } } }
    } } })
    const adapter = createFakeAdapter()
    const uploaded: string[] = []
    adapter.send = async (_target, outgoing) => {
      for (const media of outgoing.media ?? []) uploaded.push(fs.readFileSync(media.path, 'utf8'))
      return { ok: true, messageId: 'recovered' }
    }
    next.register(adapter); await next.resumePending()
    assert.deepEqual(uploaded, ['bytes:output/a.png'])
    assert.equal(f.h.followedUp.length, 1)
  } finally { await next?.dispose(); await f.close() }
})


test('old scan configuration cannot turn unrelated workspace files into attachments', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-old-scan-'))
  let precreated = false
  const h = createHarness({ onFollowup() {
    precreated = fs.readdirSync(root).some((name) => name.startsWith('.channel-output-'))
    fs.writeFileSync(path.join(root, 'unrelated.txt'), 'private workspace file')
  } })
  const config = JSON.parse('{"legacyOutputScan":true}')
  const runtime = createChannelsRuntime({ ctx: h.ctx, stateRoot: root, workingDirectory: root, config })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  try {
    runtime.dispatch(inbound())
    await until(() => stateFile(root).read<Array<{ delivery: string }>>('tasks')?.[0]?.delivery === 'sent')
    const input = h.followedUp[0]!.message as { content: Array<{ text: string }> }
    assert.match(input.content[0]!.text, /call present/)
    assert.equal(precreated, false)
    assert.equal(adapter.sent.flatMap((entry) => entry.outgoing.media ?? []).length, 0)
  } finally { await runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }) }
})
