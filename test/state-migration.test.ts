import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

import { stateFile, resetStateFile } from '../packages/core/src/store/state.js'
import { inbound } from './harness.js'

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'channels-migration-'))
const input = () => ({ id: 'input', message: inbound(), sessionId: 'session' })

test('legacy sections are imported together and archived', () => {
  const root = temp()
  const originals = { inbox: [input()], tasks: [], outbox: { schemaVersion: 1, items: [] }, lines: { chat: 3 }, counters: { 'line:chat': 3 }, schedules: { version: 1, bindings: [], pending: [] } }
  try {
    for (const [name, data] of Object.entries(originals)) fs.writeFileSync(path.join(root, `${name}.json`), JSON.stringify(data))
    const store = stateFile(root)
    assert.equal(store.read<Array<{ id: string }>>('inbox')?.[0]?.id, 'input')
    assert.deepEqual(store.read('lines'), { chat: 3 })
    assert.ok(fs.existsSync(path.join(root, 'state.db')))
    for (const [name, data] of Object.entries(originals)) {
      assert.equal(fs.existsSync(path.join(root, `${name}.json`)), false)
      assert.equal(fs.readFileSync(path.join(root, 'legacy-state', `${name}.json.bak`), 'utf8'), JSON.stringify(data))
    }
    store.write('lines', { chat: 4 })
    resetStateFile(root)
    assert.deepEqual(stateFile(root).read('lines'), { chat: 4 })
    assert.equal(fs.existsSync(path.join(root, 'lines.json')), false, 'legacy files never reappear')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a malformed legacy section refuses the import and preserves every input', () => {
  const root = temp()
  try {
    fs.writeFileSync(path.join(root, 'inbox.json'), JSON.stringify([input()]))
    fs.writeFileSync(path.join(root, 'tasks.json'), '[{"id":"bad"}]')
    const store = stateFile(root)
    assert.throws(() => store.read('inbox'), /state database unavailable|refusing new work/i)
    assert.equal(store.write('lines', {}), false)
    assert.equal(fs.existsSync(path.join(root, 'inbox.json')), true)
    assert.equal(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8'), '[{"id":"bad"}]')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('version1 canonical sections win over mirrors and missing sections migrate', () => {
  const root = temp()
  try {
    const canonical = { version: 1, savedAt: 1, sections: { lines: { chat: 8 } } }
    fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(canonical))
    fs.writeFileSync(path.join(root, 'lines.json'), JSON.stringify({ chat: 0 }))
    fs.writeFileSync(path.join(root, 'tasks.json'), '[]')
    assert.deepEqual(stateFile(root).read('lines'), { chat: 8 })
    assert.deepEqual(stateFile(root).read('tasks'), [])
    assert.equal(fs.readFileSync(path.join(root, 'legacy-state/state.json.bak'), 'utf8'), JSON.stringify(canonical))
    assert.equal(fs.readFileSync(path.join(root, 'legacy-state/lines.json.bak'), 'utf8'), '{"chat":0}')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('an existing different migration backup is never overwritten', () => {
  const root = temp()
  try {
    fs.mkdirSync(path.join(root, 'legacy-state'))
    fs.writeFileSync(path.join(root, 'legacy-state/inbox.json.bak'), 'previous backup')
    fs.writeFileSync(path.join(root, 'inbox.json'), '[]')
    assert.deepEqual(stateFile(root).read('inbox'), [])
    const backups = fs.readdirSync(path.join(root, 'legacy-state')).map((name) => fs.readFileSync(path.join(root, 'legacy-state', name), 'utf8')).sort()
    assert.deepEqual(backups, ['[]', 'previous backup'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('an archive failure blocks activation and a restart finishes it after repair', () => {
  const root = temp()
  try {
    fs.writeFileSync(path.join(root, 'inbox.json'), '[]')
    fs.writeFileSync(path.join(root, 'legacy-state'), 'blocked')
    assert.throws(() => stateFile(root).read('inbox'))
    assert.equal(fs.existsSync(path.join(root, 'inbox.json')), true)
    fs.unlinkSync(path.join(root, 'legacy-state'))
    resetStateFile(root)
    assert.deepEqual(stateFile(root).read('inbox'), [])
    assert.equal(fs.existsSync(path.join(root, 'inbox.json')), false)
    assert.equal(fs.existsSync(path.join(root, 'legacy-state/inbox.json.bak')), true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('doctor inspects without mutation and --migrate imports the legacy state', () => {
  const root = temp()
  try {
    fs.writeFileSync(path.join(root, 'inbox.json'), '[]')
    const inspect = spawnSync(process.execPath, ['packages/core/bin/doctor.mjs', '--state'], { encoding: 'utf8', env: { ...process.env, DSH_CHANNELS_STATE_DIR: root } })
    assert.equal(inspect.status, 0, inspect.stderr)
    assert.equal(fs.existsSync(path.join(root, 'state.db')), false, 'inspection must not create the database')
    const migrate = spawnSync(process.execPath, ['packages/core/bin/doctor.mjs', '--migrate'], { encoding: 'utf8', env: { ...process.env, DSH_CHANNELS_STATE_DIR: root } })
    assert.equal(migrate.status, 0, migrate.stderr)
    assert.ok(fs.existsSync(path.join(root, 'state.db')), 'explicit migration creates the database')
    assert.equal(fs.readFileSync(path.join(root, 'legacy-state/inbox.json.bak'), 'utf8'), '[]')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('doctor reports malformed legacy state without changing its original bytes', () => {
  const root = temp()
  try {
    fs.writeFileSync(path.join(root, 'state.json'), '{')
    const inspect = spawnSync(process.execPath, ['packages/core/bin/doctor.mjs', '--state'], { encoding: 'utf8', env: { ...process.env, DSH_CHANNELS_STATE_DIR: root } })
    assert.equal(inspect.status, 1, 'an undeclared legacy file is reported')
    const migrate = spawnSync(process.execPath, ['packages/core/bin/doctor.mjs', '--migrate'], { encoding: 'utf8', env: { ...process.env, DSH_CHANNELS_STATE_DIR: root } })
    assert.equal(migrate.status, 1)
    assert.equal(fs.readFileSync(path.join(root, 'state.json'), 'utf8'), '{')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
