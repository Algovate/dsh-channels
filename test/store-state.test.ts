import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { Inbox } from '../packages/core/src/store/inbox.js'
import { SessionLines } from '../packages/core/src/store/lines.js'
import { Outbox } from '../packages/core/src/store/outbox.js'
import { resetStateFile, stateFile } from '../packages/core/src/store/state.js'
import { Tasks } from '../packages/core/src/store/tasks.js'
import { inbound } from './harness.js'

function temp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'channels-state-'))
}

test('SQLite is the canonical medium and every store shares it', () => {
  const root = temp()
  try {
    const inbox = new Inbox(root, () => {})
    const entry = inbox.add(inbound({ text: 'kept' }), 'session')
    const tasks = new Tasks(root, () => {})
    assert.equal(tasks.save({ id: entry.id, target: inbound(), senderId: 'sender', summary: 'kept', startedAt: 1, execution: 'running', delivery: 'none' }), true)
    assert.equal(new SessionLines(root, () => {}).saveRouting('chat', { project: 'default', sessions: { default: { current: 2, max: 2 } } }), true)
    assert.equal(new Outbox({ stateRoot: root }).enqueue(inbound(), ['later'])?.outgoing.text, 'later')
    assert.ok(fs.existsSync(path.join(root, 'state.db')))
    assert.equal(fs.existsSync(path.join(root, 'state.json')), false)
    assert.equal(fs.existsSync(path.join(root, 'inbox.json')), false)

    // A reopen sees the same rows without any JSON mirror.
    resetStateFile(root)
    assert.equal(new Inbox(root, () => {}).list()[0]?.message.text, 'kept')
    assert.equal(new Tasks(root, () => {}).latest(inbound())?.summary, 'kept')
    assert.equal(fs.existsSync(path.join(root, 'inbox.json')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a stale legacy file cannot overwrite a live database', () => {
  const root = temp()
  try {
    const first = new Inbox(root, () => {})
    first.add(inbound({ text: 'first' }), 'session')
    // Writing the old mirror afterwards must not resurrect it on reopen.
    fs.writeFileSync(path.join(root, 'inbox.json'), JSON.stringify([{ id: 'x', message: inbound({ text: 'edited' }), sessionId: 's' }]))
    resetStateFile(root)
    assert.equal(new Inbox(root, () => {}).list()[0]?.message.text, 'first')
    // The stale file is archived as a leftover, never imported over live rows.
    assert.equal(fs.existsSync(path.join(root, 'inbox.json')), false)
    assert.equal(fs.readFileSync(path.join(root, 'legacy-state/inbox.json.bak'), 'utf8').includes('edited'), true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a corrupt database fails closed instead of recreating state', () => {
  const root = temp()
  try {
    new Inbox(root, () => {}).add(inbound(), 'session')
    resetStateFile(root)
    fs.writeFileSync(path.join(root, 'state.db'), 'not a database')
    const warnings: string[] = []
    const inbox = new Inbox(root, (line) => warnings.push(line))
    assert.ok(warnings.some((line) => /state database unavailable/.test(line)))
    assert.throws(() => inbox.add(inbound(), 'session'), /persisted|DSH_INBOUND_RETRY/)
    assert.equal(fs.existsSync(path.join(root, 'inbox.json')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a failed multi-section commit rolls back both sections', () => {
  const root = temp()
  try {
    const store = stateFile(root)
    store.write('counters', { old: 1 })
    store.write('lines', { old: 1 })
    store.failNextWrite('lines')
    assert.equal(store.writeMany({ counters: { new: 2 }, lines: { new: 2 } }), false)
    assert.deepEqual(store.read('counters'), { old: 1 })
    assert.deepEqual(store.read('lines'), { old: 1 })
    resetStateFile(root)
    assert.deepEqual(stateFile(root).read('counters'), { old: 1 })
    assert.equal(stateFile(root).writeMany({ counters: { new: 2 }, lines: { new: 2 } }), true)
    resetStateFile(root)
    assert.deepEqual(stateFile(root).read('counters'), { new: 2 })
    assert.deepEqual(stateFile(root).read('lines'), { new: 2 })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a live lock owner blocks the root and a dead one is taken over', () => {
  const busy = temp()
  const stale = temp()
  try {
    fs.mkdirSync(path.join(busy, 'state.lock.d'))
    fs.writeFileSync(path.join(busy, 'state.lock.d/owner.json'), JSON.stringify({ pid: 1, startedAt: 1 }))
    assert.throws(() => stateFile(busy).read('lines'), /another process \(pid 1\) owns this state root/)
    resetStateFile(busy)

    fs.mkdirSync(path.join(stale, 'state.lock.d'))
    fs.writeFileSync(path.join(stale, 'state.lock.d/owner.json'), JSON.stringify({ pid: 999_999, startedAt: 1 }))
    assert.deepEqual(stateFile(stale).read('lines'), undefined)
    assert.equal(stateFile(stale).write('lines', { chat: 1 }), true)
  } finally {
    fs.rmSync(busy, { recursive: true, force: true })
    fs.rmSync(stale, { recursive: true, force: true })
  }
})

test('the database and its WAL sidecars stay private', () => {
  const root = temp()
  try {
    stateFile(root).write('lines', { chat: 1 })
    for (const name of ['state.db', 'state.db-wal', 'state.db-shm']) {
      const file = path.join(root, name)
      if (!fs.existsSync(file)) continue
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, `${name} must be 0600`)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
