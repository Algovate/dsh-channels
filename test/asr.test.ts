import assert from 'node:assert/strict'
import fs from 'node:fs'
import { PassThrough } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AsrBridge } from '../packages/adapter-weixin/src/asr.js'

const silent = { info: () => {}, warn: () => {} }

function wavFile(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'channels-asr-')), 'v.wav')
  fs.writeFileSync(file, 'RIFF....WAVE')
  return file
}

/** A fake bridge process: answers each request line with whatever `answer` says. */
function fakeSpawn(answer: (request: { wav: string }) => string | undefined) {
  const children: Array<{ stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => void }> = []
  const spawnImpl = (() => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = { stdin, stdout, stderr, exitCode: null as number | null, kill: () => { child.exitCode = 0 }, on: () => child, once: () => child, off: () => child }
    let buffer = ''
    stdin.on('data', (chunk: Buffer) => {
      buffer += String(chunk)
      for (const line of buffer.split('\n')) {
        if (line.trim() === '') continue
        const reply = answer(JSON.parse(line) as { wav: string })
        if (reply !== undefined) stdout.write(reply)
      }
      buffer = ''
    })
    children.push(child)
    return child
  }) as unknown as typeof import('node:child_process').spawn
  return { spawnImpl, children }
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
