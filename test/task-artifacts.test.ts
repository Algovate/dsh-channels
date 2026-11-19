import assert from 'node:assert/strict'
import fs from 'node:fs'
import asyncFs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { prepareTaskArtifacts } from '../packages/core/src/task-artifacts.js'
import { copyDeliverable } from '../packages/core/src/artifacts.js'

test('a missing indexed file keeps a mixed recovered attachment plan incomplete', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-artifacts-missing-'))
  try {
    const output = fs.mkdtempSync(path.join(root, '.channel-output-'))
    fs.writeFileSync(path.join(output, 'kept.png'), 'kept bytes')
    const plan = await prepareTaskArtifacts({
      record: { outputDirectory: output, artifacts: ['missing.png', 'kept.png'] },
      reply: { text: 'ready' }, workingDirectory: root, maxFiles: 3, maxBytes: 1024,
    })
    assert.deepEqual(plan.attachments.map((file) => file.relative), ['kept.png'])
    assert.equal(plan.index.artifactsIncomplete, true)
    assert.ok(plan.notices.some((notice) => /附件未发送/.test(notice)))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('capturing an output rejects a parent swapped to an outside symlink before opening', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-artifacts-swap-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'task-artifacts-private-'))
  const parent = path.join(root, 'source')
  const output = fs.mkdtempSync(path.join(root, '.channel-output-'))
  fs.mkdirSync(parent)
  const source = path.join(parent, 'report.txt')
  fs.writeFileSync(source, 'declared public output')
  fs.writeFileSync(path.join(outside, 'report.txt'), 'PRIVATE')
  const canonical = fs.realpathSync(source)
  const open = asyncFs.open
  let swapped = false
  asyncFs.open = async (...args) => {
    if (String(args[0]) === canonical && !swapped) {
      swapped = true
      fs.renameSync(parent, path.join(root, 'source-original'))
      fs.symlinkSync(outside, parent, 'dir')
    }
    return open(...args)
  }
  try {
    assert.equal(await copyDeliverable(source, output, 1024, root), undefined)
    assert.equal(swapped, true)
    assert.deepEqual(fs.readdirSync(output), [])
  } finally {
    asyncFs.open = open
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('capture pins the source identity before asynchronous containment resolution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-artifacts-resolve-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'task-artifacts-outside-'))
  const parent = path.join(root, 'source')
  const output = fs.mkdtempSync(path.join(root, '.channel-output-'))
  fs.mkdirSync(parent)
  const source = path.join(parent, 'report.txt')
  fs.writeFileSync(source, 'public')
  fs.writeFileSync(path.join(outside, 'report.txt'), 'PRIVATE')
  const realpath = asyncFs.realpath
  let swapped = false
  asyncFs.realpath = (async (file: Parameters<typeof realpath>[0]) => {
    const resolved = await realpath(file)
    if (String(file) === source && !swapped) {
      swapped = true
      fs.renameSync(parent, path.join(root, 'source-original'))
      fs.symlinkSync(outside, parent, 'dir')
    }
    return resolved
  }) as typeof realpath
  try {
    assert.equal(await copyDeliverable(source, output, 1024, root), undefined)
    assert.equal(swapped, true)
    assert.deepEqual(fs.readdirSync(output), [])
  } finally {
    asyncFs.realpath = realpath
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})
