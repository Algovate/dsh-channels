import { readSectionJson, writeSectionJson } from './state-helper.js'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHarness, inbound } from './harness.js'
import { createChannelsRuntime, createFakeAdapter } from './runtime-helper.js'
import { sessionIdFor } from '../packages/core/src/ids.js'
const tick = () => new Promise((resolve) => setTimeout(resolve, 100))

test('project commands preserve old session selections and high-water allocation after restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-'))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-ws-'))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-project-'))
  const h = createHarness({ reply: 'ok' })
  const config = { projects: { app: project }, senderPerMinute: 0, senderPerDay: 0 }
  let runtime = createChannelsRuntime({ ctx: h.ctx, stateRoot: root, workingDirectory: workspace, config })
  const adapter = createFakeAdapter()
  runtime.register(adapter)
  const send = async (text: string) => { runtime.dispatch(inbound({ text })); await tick() }
  try {
    await send('/projects')
    assert.match(adapter.sent.at(-1)?.outgoing.text ?? '', /app/)
    assert.equal(h.created.length, 0)
    await send('/project app')
    await send('in app')
    assert.equal((h.created.at(-1)?.meta as { cwd: string }).cwd, fs.realpathSync(project))
    const appSession = h.created.at(-1)?.sessionId
    await send('/new')
    await send('app line1')
    assert.notEqual(h.created.at(-1)?.sessionId, appSession)
    await runtime.dispose()
    // An older release had selected line 0 after allocating line 1.
    const saved = JSON.parse(readSectionJson(root, 'lines'))
    saved['fake|acct|conv'].sessions[JSON.stringify(['app', fs.realpathSync(project)])].current = 0
    writeSectionJson(root, 'lines', JSON.stringify(saved))
    runtime = createChannelsRuntime({ ctx: h.ctx, stateRoot: root, workingDirectory: workspace, config })
    runtime.register(adapter)
    await send('/whoami')
    assert.ok(adapter.sent.at(-1)?.outgoing.text?.includes(String(appSession)))
    await send('/new')
    assert.match(adapter.sent.at(-1)?.outgoing.text ?? '', /第 2 条/)
    await send('/project default')
    await send('default workspace')
    assert.equal(h.created.at(-1)?.sessionId, sessionIdFor(inbound()))
    assert.equal((h.created.at(-1)?.meta as { cwd: string }).cwd, workspace)
    await send('/project /tmp')
    assert.match(adapter.sent.at(-1)?.outgoing.text ?? '', /未配置|无效/)
  } finally { await runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) }
})

test('queued routes survive switching and restart; removing their project blocks execution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-queue-'))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-project-'))
  const h = createHarness({ silent: true })
  const config = { projects: { app: project, backup: project }, senderPerMinute: 0, senderPerDay: 0, autoSendFiles: false }
  let runtime = createChannelsRuntime({ ctx: h.ctx, stateRoot: root, workingDirectory: root, config })
  const adapter = createFakeAdapter(); runtime.register(adapter)
  try {
    runtime.dispatch(inbound({ text: '/project app' })); await tick()
    runtime.dispatch(inbound({ text: 'running' })); await tick()
    runtime.dispatch(inbound({ text: 'queued' }))
    runtime.dispatch(inbound({ text: '/new' })); await tick()
    runtime.dispatch(inbound({ text: '/project default' })); await tick()
    const saved = JSON.parse(readSectionJson(root, 'inbox'))
    assert.equal(saved[0].workingDirectory, fs.realpathSync(project))
    const originalId = saved[0].sessionId
    assert.equal(originalId, h.created[0]?.sessionId)
    await runtime.dispose()
    const second = createHarness()
    runtime = createChannelsRuntime({ ctx: second.ctx, stateRoot: root, workingDirectory: root, config: { ...config, projects: { backup: project } } })
    runtime.register(adapter)
    await runtime.resumePending(); await tick()
    assert.equal(second.followedUp.length, 0)
    assert.equal(runtime.pendingInputs(), 1)
    await runtime.dispose()
    runtime = createChannelsRuntime({ ctx: second.ctx, stateRoot: root, workingDirectory: root, config })
    runtime.register(adapter)
    await runtime.resumePending(); await tick()
    assert.equal(second.created[0]?.sessionId, originalId)
    assert.equal((second.created[0]?.meta as { cwd: string }).cwd, fs.realpathSync(project))
    assert.equal(runtime.pendingInputs(), 0)
  } finally { await runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) }
})

test('corrupt routing fails closed and project selection is scoped to this chat', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-corrupt-'))
  const h = createHarness()
  writeSectionJson(root, 'lines', '{')
  const runtime = createChannelsRuntime({ ctx: h.ctx, stateRoot: root, workingDirectory: root })
  const adapter = createFakeAdapter(); runtime.register(adapter)
  try {
    assert.throws(() => runtime.dispatch(inbound()), /routing.*unreadable/)
    runtime.dispatch(inbound({ text: '/new' })); await tick()
    assert.match(adapter.sent.at(-1)?.outgoing.text ?? '', /失败/)
    assert.equal(h.followedUp.length, 0)
    assert.equal(JSON.parse(readSectionJson(root, 'lines')), '{')
  } finally { await runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('switching projects does not leak to other chats or redirect historical artifact lookup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-artifact-'))
  const project = fs.mkdtempSync(path.join(root, 'app-'))
  const output = fs.mkdtempSync(path.join(project, '.channel-output-'))
  fs.writeFileSync(path.join(output, 'report.txt'), 'report')
  writeSectionJson(root, 'tasks', JSON.stringify([{ id: 'aaaaaaaa-1111-2222-3333-444444444444', target: { channel: 'fake', accountId: 'acct', conversationId: 'conv' }, senderId: 'sender', summary: 'report', startedAt: 1, execution: 'completed', delivery: 'sent', workingDirectory: fs.realpathSync(project), outputDirectory: fs.realpathSync(output), artifacts: ['report.txt'] }]))
  const h = createHarness()
  const runtime = createChannelsRuntime({ ctx: h.ctx, stateRoot: root, workingDirectory: root, config: { projects: { app: project }, senderPerMinute: 0 } })
  const adapter = createFakeAdapter(); runtime.register(adapter)
  try {
    runtime.dispatch(inbound({ text: '/project app' })); await tick()
    runtime.dispatch(inbound({ conversationId: 'other', text: '/projects' })); await tick()
    assert.match(adapter.sent.at(-1)?.outgoing.text ?? '', /default（当前）/)
    runtime.dispatch(inbound({ text: '/project default' })); await tick()
    runtime.dispatch(inbound({ text: '/files aaaaaaaa' })); await tick()
    assert.match(adapter.sent.at(-1)?.outgoing.text ?? '', /report.txt/)
  } finally { await runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('an existing host session with a different working directory is refused before followup', async () => {
  const { TurnDriver } = await import('../packages/core/src/turns.js')
  const id = sessionIdFor(inbound())
  const h = createHarness({ existing: [id] })
  Object.assign(h.agents.get(id)!.session, { header: { cwd: '/different-project' } })
  const driver = new TurnDriver({ ctx: h.ctx, workingDirectory: '/expected-project', logger: { info() {}, warn() {} } })
  try { await assert.rejects(driver.attach(inbound()), /working directory/); assert.equal(h.followedUp.length, 0) }
  finally { await driver.dispose() }
})
