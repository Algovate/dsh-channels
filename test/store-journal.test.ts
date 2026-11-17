import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { Journal } from '../packages/core/src/store/journal.js'

function journal() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-journal-'))
  return { root, instance: new Journal({ stateRoot: root, now: () => new Date(2026, 10, 17, 10, 0).getTime() }) }
}

const base = { channel: 'fake', accountId: 'acct', conversationId: 'conv', direction: 'out' as const }

test('a send writes two lines, and a reader joins them into one accepted message', () => {
  const { root, instance } = journal()
  instance.append({ ...base, phase: 'sending', id: 'out-1', text: '你好' })
  instance.append({ ...base, phase: 'settled', id: 'out-1', text: '你好', delivery: 'accepted', messageId: 'srv-1' })
  const lines = fs.readFileSync(instance.file(), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(instance.outbound()[0]?.state, 'accepted')
  assert.equal(instance.outbound()[0]?.text, '你好')
  assert.ok(root.length > 0)
})

test('a send with no settlement is reported as pending, not as success', () => {
  const { instance } = journal()
  instance.append({ ...base, phase: 'sending', id: 'out-2', text: '发了一半' })
  assert.equal(instance.outbound()[0]?.state, 'pending')
})

test('a failed send keeps its code', () => {
  const { instance } = journal()
  instance.append({ ...base, phase: 'sending', id: 'out-3', text: 'x' })
  instance.append({ ...base, phase: 'settled', id: 'out-3', text: 'x', delivery: 'failed', code: 'server-500' })
  assert.deepEqual(instance.outbound()[0], { id: 'out-3', text: 'x', state: 'failed', code: 'server-500' })
})

test('an unconfirmed delivery is named as such', () => {
  const { instance } = journal()
  instance.append({ ...base, phase: 'sending', id: 'out-4', text: 'x' })
  instance.append({ ...base, phase: 'settled', id: 'out-4', text: 'x', delivery: 'unconfirmed' })
  assert.equal(instance.outbound()[0]?.state, 'unconfirmed')
})

test('a malformed line from a killed process does not lose the rest of the day', () => {
  const { instance } = journal()
  instance.append({ ...base, phase: 'sending', id: 'out-5', text: 'x' })
  fs.appendFileSync(instance.file(), '{"broken"\n')
  instance.append({ ...base, phase: 'settled', id: 'out-5', text: 'x', delivery: 'accepted' })
  assert.equal(instance.read().length, 2)
  assert.equal(instance.outbound()[0]?.state, 'accepted')
})

test('a missing day is an empty journal, not an error', () => {
  const { instance } = journal()
  assert.deepEqual(instance.read(), [])
  assert.deepEqual(instance.outbound(), [])
})
