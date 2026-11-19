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

test('the edge state document is canonical and no legacy mirrors are created', () => {
  const root = temp()
  try {
    const inbox = new Inbox(root, () => {})
    const entry = inbox.add(inbound({ text: 'kept' }), 'session')
    const tasks = new Tasks(root, () => {})
    assert.equal(tasks.save({ id: entry.id, target: inbound(), senderId: 'sender', summary: 'kept', startedAt: 1, execution: 'running', delivery: 'none' }), true)
    assert.equal(new SessionLines(root, () => {}).saveRouting('chat', { project: 'default', sessions: { default: { current: 2, max: 2 } } }), true)
    assert.equal(new Outbox({ stateRoot: root }).enqueue(inbound(), ['later'])?.outgoing.text, 'later')
    assert.ok(fs.existsSync(path.join(root, 'state.json')))
    assert.equal(fs.existsSync(path.join(root, 'inbox.json')), false)

    // A fresh process sees the canonical document even if a mirror is stale.
    resetStateFile(root)
    assert.equal(new Inbox(root, () => {}).list()[0]?.message.text, 'kept')
    assert.equal(new Tasks(root, () => {}).latest(inbound())?.summary, 'kept')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a newer legacy file cannot overwrite canonical state after migration', () => {
  const root = temp()
  try {
    const first = new Inbox(root, () => {})
    const entry = first.add(inbound({ text: 'first' }), 'session')
    const legacy = path.join(root, 'inbox.json')
    fs.writeFileSync(legacy, JSON.stringify([{ ...entry, message: { ...entry.message, text: 'edited' } }]))
    const future = Date.now() + 10_000
    fs.utimesSync(legacy, future, future)
    resetStateFile(root)
    assert.equal(new Inbox(root, () => {}).list()[0]?.message.text, 'first')
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).sections.inbox[0].message.text, 'first')
    assert.ok(fs.existsSync(path.join(root, 'legacy-state/inbox.json.bak')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a corrupt canonical document fails closed instead of falling back to mirrors', () => {
  const root = temp()
  try {
    new Inbox(root, () => {}).add(inbound(), 'session')
    fs.writeFileSync(path.join(root, 'state.json'), '{')
    fs.writeFileSync(path.join(root, 'inbox.json'), '[]')
    resetStateFile(root)
    const inbox = new Inbox(root, () => {})
    assert.throws(() => inbox.add(inbound(), 'session'), /persist/)
    assert.ok(fs.existsSync(path.join(root, 'inbox.json')), 'mirrors are left for repair')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the canonical document is a single atomically replaced object', () => {
  const root = temp()
  try {
    new Inbox(root, () => {}).add(inbound(), 'session')
    new Tasks(root, () => {}).save({ id: 'task', target: inbound(), senderId: 'sender', summary: 'x', startedAt: 1, execution: 'running', delivery: 'none' })
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')) as { version: number; sections: Record<string, unknown> }
    assert.equal(saved.version, 2)
    assert.deepEqual(Object.keys(saved.sections).sort(), ['inbox', 'tasks'])
    assert.ok(stateFile(root).read('inbox'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a failed multi-section commit changes neither section on disk or in memory', () => {
  const root = temp()
  try {
    const store = stateFile(root)
    store.write('counters', { old: 1 })
    store.write('lines', { old: 1 })
    const commit = store.writeMany.bind(store)
    store.failNextWrite('lines')
    assert.equal(commit({ counters: { new: 2 }, lines: { new: 2 } }), false)
    assert.deepEqual(store.read('counters'), { old: 1 })
    assert.deepEqual(store.read('lines'), { old: 1 })
    resetStateFile(root)
    assert.deepEqual(stateFile(root).read('counters'), { old: 1 })
    assert.equal(commit({ counters: { new: 2 }, lines: { new: 2 } }), true)
    resetStateFile(root)
    assert.deepEqual(stateFile(root).read('counters'), { new: 2 })
    assert.deepEqual(stateFile(root).read('lines'), { new: 2 })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
