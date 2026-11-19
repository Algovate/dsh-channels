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

test('recovery sends indexed log and nested dotfiles without discovering unindexed outputs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-index-only-'))
  const output = fs.mkdtempSync(path.join(root, '.channel-output-'))
  fs.mkdirSync(path.join(output, '.reports'))
  fs.writeFileSync(path.join(output, 'result.log'), 'declared log')
  fs.writeFileSync(path.join(output, '.reports', 'report.txt'), 'declared report')
  fs.writeFileSync(path.join(output, 'unindexed.txt'), 'unrelated')
  try {
    const plan = await prepareTaskArtifacts({
      record: { outputDirectory: output, artifacts: ['result.log', '.reports/report.txt'] },
      reply: { text: 'ready' }, workingDirectory: root, maxFiles: 3, maxBytes: 1024,
    })
    assert.deepEqual(plan.attachments.map((file) => file.relative), ['result.log', '.reports/report.txt'])
    assert.notEqual(plan.index.artifactsIncomplete, true)
    assert.deepEqual(plan.notices, [])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('declared artifact capture reports excess files beyond the durable limit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-declared-many-'))
  const files = Array.from({ length: 101 }, (_, i) => path.join(root, `${String(i).padStart(3, '0')}.txt`))
  for (const file of files) fs.writeFileSync(file, 'declared')
  try {
    const plan = await prepareTaskArtifacts({ record: {}, reply: { text: 'ready', deliverables: files.map((file) => ({ path: file })) }, workingDirectory: root, maxFiles: 100, maxBytes: 1024 })
    assert.equal(plan.index.artifacts?.length, 100)
    assert.equal(plan.attachments.length, 100)
    assert.equal(plan.index.artifactsIncomplete, true)
    assert.ok(plan.notices.some((notice) => /1 个附件未发送/.test(notice)))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a recovered artifact index cannot redirect delivery outside the authorized workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-authorized-root-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'task-outside-root-'))
  const output = fs.mkdtempSync(path.join(outside, '.channel-output-'))
  fs.writeFileSync(path.join(output, 'private.txt'), 'private')
  try {
    const plan = await prepareTaskArtifacts({ record: { outputDirectory: output, artifacts: ['private.txt'] }, reply: { text: 'ready' }, workingDirectory: root, maxFiles: 3, maxBytes: 1024 })
    assert.deepEqual(plan.attachments, [])
    assert.equal(plan.index.artifactsIncomplete, true)
    assert.ok(plan.notices.some((notice) => notice.includes('未发送')))
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }) }
})

test('recovered indexes preserve their order and report files beyond the current count or byte limit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-recovered-limit-'))
  const output = fs.mkdtempSync(path.join(root, '.channel-output-'))
  fs.writeFileSync(path.join(output, 'z.txt'), 'ok')
  fs.writeFileSync(path.join(output, 'a.txt'), 'too large')
  fs.writeFileSync(path.join(output, 'b.txt'), 'ok')
  try {
    const plan = await prepareTaskArtifacts({ record: { outputDirectory: output, artifacts: ['z.txt', 'a.txt', 'b.txt'] }, reply: { text: 'ready' }, workingDirectory: root, maxFiles: 2, maxBytes: 2 })
    assert.deepEqual(plan.index.artifacts, ['z.txt', 'a.txt', 'b.txt'])
    assert.deepEqual(plan.attachments.map((file) => file.relative), ['z.txt'])
    assert.equal(plan.index.artifactsIncomplete, true)
    assert.ok(plan.notices.some((notice) => notice.includes('未发送')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
