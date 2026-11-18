import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { scanProducedFiles } from '../packages/core/src/produced.js'

/**
 * Build a workspace with one old file, one new file, a dot dir, a node_modules
 * and a stale temp file. `now` is the turn start.
 */
function workspace(now = Date.now()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-produced-'))
  const write = (relative: string, bytes: number, mtimeMs: number): string => {
    const full = path.join(root, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, Buffer.alloc(bytes, 0x61))
    fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs))
    return full
  }
  write('old.txt', 10, now - 60_000)
  const fresh = write('chart.png', 100, now + 2_000)
  write('.hidden/secret.txt', 10, now + 2_000)
  write('node_modules/pkg/index.js', 10, now + 2_000)
  write('notes.tmp', 10, now + 2_000)
  write('sub/report.pdf', 20, now + 3_000)
  return { root, now, fresh }
}

test('only files written since the turn started are produced files', async () => {
  const { root, now } = workspace()
  const { files } = await scanProducedFiles({ dir: root, sinceMs: now })
  assert.deepEqual(files.map((file) => file.name).sort(), ['chart.png', 'report.pdf'])
})

test('dot directories, dependency trees and temp files are skipped', async () => {
  const { root, now } = workspace()
  const { files } = await scanProducedFiles({ dir: root, sinceMs: now })
  assert.equal(files.some((file) => file.path.includes('.hidden')), false)
  assert.equal(files.some((file) => file.path.includes('node_modules')), false)
  assert.equal(files.some((file) => file.name.endsWith('.tmp')), false)
})

test('the newest files win, and the count is capped', async () => {
  const { root, now } = workspace()
  const { files } = await scanProducedFiles({ dir: root, sinceMs: now, maxFiles: 1 })
  assert.equal(files.length, 1)
  assert.equal(files[0]?.name, 'report.pdf', 'the newest of the two')
})

test('a file over the size cap is not sent', async () => {
  const { root, now } = workspace()
  const { files } = await scanProducedFiles({ dir: root, sinceMs: now, maxBytes: 50 })
  assert.deepEqual(files.map((file) => file.name), ['report.pdf'], '100 bytes is over the cap, 20 is not')
})

test('a missing directory is an empty list, not an error', async () => {
  const { files } = await scanProducedFiles({ dir: path.join(os.tmpdir(), 'channels-nope-' + Date.now()), sinceMs: 0 })
  assert.deepEqual(files, [])
})
