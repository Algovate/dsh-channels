import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AsrBridge } from '../packages/adapter-weixin/src/asr.js'
import { fakeSpawn } from './asr-fixtures.js'

const silent = { info: () => {}, warn: () => {} }

function wavFile(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'channels-asr-')), 'v.wav')
  fs.writeFileSync(file, 'RIFF....WAVE')
  return file
}

function bridge(spawnImpl: typeof import('node:child_process').spawn, overrides: Record<string, unknown> = {}) {
  return new AsrBridge({
    scriptPath: fs.existsSync('/tmp') ? process.argv[1] ?? 'x' : 'x', // any existing path
    modelDir: '/tmp/models',
    logger: silent,
    spawnImpl,
    timeoutMs: 1000,
    ...overrides,
  })
}

test('a transcript comes back as text', async () => {
  const { spawnImpl } = fakeSpawn(() => `${JSON.stringify({ ok: true, text: '明天下午三点' })}\n`)
  const asr = bridge(spawnImpl)
  const result = await asr.transcribe(wavFile())
  assert.deepEqual(result, { ok: true, text: '明天下午三点' })
})

test('a failure answer is a reason, never an exception', async () => {
  const { spawnImpl } = fakeSpawn(() => `${JSON.stringify({ ok: false, error: 'model missing' })}\n`)
  const asr = bridge(spawnImpl)
  const result = await asr.transcribe(wavFile())
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /model missing/)
})

test('a bridge that never answers times out instead of hanging the message', async () => {
  const { spawnImpl } = fakeSpawn(() => undefined)
  const asr = bridge(spawnImpl, { timeoutMs: 20 })
  const result = await asr.transcribe(wavFile())
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /timed out/)
})

test('one request in flight: a second call waits for the first answer', async () => {
  let calls = 0
  const { spawnImpl } = fakeSpawn(() => {
    calls += 1
    return `${JSON.stringify({ ok: true, text: `第${calls}条` })}\n`
  })
  const asr = bridge(spawnImpl)
  const [first, second] = await Promise.all([asr.transcribe(wavFile()), asr.transcribe(wavFile())])
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.notEqual(first.ok === true ? first.text : '', second.ok === true ? second.text : '')
})

test('a missing script means "unavailable" rather than a spawn attempt', async () => {
  const asr = new AsrBridge({ scriptPath: '/nonexistent/asr-bridge.py', modelDir: '/tmp', logger: silent })
  assert.equal(asr.available(), false)
  assert.deepEqual(await asr.transcribe(wavFile()), { ok: false, reason: 'bridge unavailable' })
})

test('disposing the bridge stops deferred transcription from opening a process', async () => {
  const { spawnImpl, children } = fakeSpawn(() => '{"ok":true,"text":"unexpected"}\n')
  const asr = bridge(spawnImpl)
  const pending = asr.transcribe(wavFile())
  await asr.dispose()
  assert.deepEqual(await pending, { ok: false, reason: 'bridge closed' })
  assert.equal(children.length, 0)
})

test('engine diagnostics on stdout do not break the protocol answer', async () => {
  const { spawnImpl } = fakeSpawn(() => `Detected language: Chinese\n${JSON.stringify({ ok: true, text: '好的' })}\n`)
  const asr = bridge(spawnImpl)
  assert.deepEqual(await asr.transcribe(wavFile()), { ok: true, text: '好的' })
})
