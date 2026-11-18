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

test('the edge state document is canonical and the old files are readable mirrors', () => {
  const root = temp()
  try {
    const inbox = new Inbox(root, () => {})
    const entry = inbox.add(inbound({ text: 'kept' }), 'session')
    const tasks = new Tasks(root, () => {})
    assert.equal(tasks.save({ id: entry.id, target: inbound(), senderId: 'sender', summary: 'kept', startedAt: 1, execution: 'running', delivery: 'none' }), true)
    assert.equal(new SessionLines(root, () => {}).saveRouting('chat', { project: 'default', sessions: { default: { current: 2, max: 2 } } }), true)
    assert.equal(new Outbox({ stateRoot: root }).add(inbound(), { kind: 'reply', text: 'later' }, {})?.outgoing.text, 'later')
    assert.ok(fs.existsSync(path.join(root, 'state.json')))
    assert.ok(fs.existsSync(path.join(root, 'inbox.json')), 'legacy mirror is still written')

    // A fresh process sees the canonical document even if a mirror is stale.
    resetStateFile(root)
    assert.equal(new Inbox(root, () => {}).list()[0]?.message.text, 'kept')
    assert.equal(new Tasks(root, () => {}).latest(inbound())?.summary, 'kept')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a newer legacy mirror is imported once and then the canonical copy wins', () => {
  const root = temp()
  try {
    const first = new Inbox(root, () => {})
    const entry = first.add(inbound({ text: 'first' }), 'session')
    const legacy = path.join(root, 'inbox.json')
    fs.writeFileSync(legacy, JSON.stringify([{ ...entry, message: { ...entry.message, text: 'edited' } }]))
    const future = Date.now() + 10_000
    fs.utimesSync(legacy, future, future)
    assert.equal(new Inbox(root, () => {}).list()[0]?.message.text, 'edited')
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).sections.inbox[0].message.text, 'edited')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a corrupt canonical document fails closed instead of falling back to mirrors', () => {
  const root = temp()
  try {
    new Inbox(root, () => {}).add(inbound(), 'session')
    fs.writeFileSync(path.join(root, 'state.json'), '{')
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
    assert.equal(saved.version, 1)
    assert.deepEqual(Object.keys(saved.sections).sort(), ['inbox', 'tasks'])
    assert.ok(stateFile(root).read('inbox'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
