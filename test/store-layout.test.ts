import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { STORE, STATE_LAYOUT, declaredTopLevel, isInsideStateRoot, keyedStatePath, statePath, statePaths } from '../packages/core/src/store/layout.js'

const CORE_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'core', 'src')

function sourceFiles(dir = CORE_SRC, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

test('every entry resolves inside the state root with a unique relative path', () => {
  const root = '/tmp/channels-layout-test'
  const resolved = statePaths(root)
  const seen = new Set<string>()
  for (const [key, entry] of Object.entries(resolved)) {
    assert.ok(isInsideStateRoot(root, entry.absolute), `${key} escaped the root`)
    assert.ok(seen.has(entry.relative) === false, `duplicate relative path: ${entry.relative}`)
    seen.add(entry.relative)
  }
  assert.equal(statePath(root, 'config'), path.join(root, 'config.json'))
  assert.throws(() => statePath(root, 'nope'), /unknown state entry/)
})

test('no entry carries a placeholder path', () => {
  for (const [key, entry] of Object.entries(STATE_LAYOUT)) {
    assert.equal(entry.relative.includes('<'), false, `${key} has a placeholder and needs a keyed helper`)
  }
})

test('every entry says where it lives, and a file entry says why', () => {
  const tiers = new Set(Object.values(STORE))
  for (const [key, entry] of Object.entries(STATE_LAYOUT)) {
    assert.ok(tiers.has(entry.store), `${key} has no store tier`)
    assert.equal(typeof entry.label, 'string')
    if (entry.store === STORE.FILE) {
      assert.equal(typeof entry.reason, 'string', `${key} stays a file without a reason`)
      assert.ok((entry.reason ?? '').length >= 8, `${key} has a placeholder reason`)
    }
  }
})

test('a key cannot escape its directory', () => {
  const root = '/tmp/channels-layout-test'
  const full = keyedStatePath(root, 'mediaInbound', '../../etc/passwd')
  assert.ok(full.startsWith(path.join(root, 'media', 'inbound') + path.sep))
})

test('no module writes a top-level state path the table does not declare', () => {
  const tops = declaredTopLevel()
  const patterns = [/join\(\s*stateRoot\s*,\s*'([^']*)'/g, /join\(\s*root\s*,\s*'([^']*)'/g]
  const offenders: string[] = []
  const files = sourceFiles()
  assert.ok(files.length > 20, 'the guard must inspect real source files')
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
      for (const pattern of patterns) {
        for (const match of line.matchAll(pattern)) {
          const first = (match[1] ?? '').split('/')[0] as string
          if (first === '' || first.includes('${')) continue
          const covered = [...tops].some((top) => top === first || top.startsWith(`${first}/`))
          if (!covered) offenders.push(`${path.relative(CORE_SRC, file)}:${index + 1} → ${first}`)
        }
      }
    })
  }
  assert.deepEqual(offenders, [], `undeclared state paths: ${offenders.join(', ')}`)
})

test('real core writers keep every generated path in the declared inventory', async () => {
  const os = await import('node:os')
  const { FileCounterStore } = await import('../packages/core/src/store/counters.js')
  const { Inbox } = await import('../packages/core/src/store/inbox.js')
  const { inbound } = await import('./harness.js')
  const { SessionLines } = await import('../packages/core/src/store/lines.js')
  const { Journal } = await import('../packages/core/src/store/journal.js')
  const { Outbox } = await import('../packages/core/src/store/outbox.js')
  const { createLogger } = await import('../packages/core/src/log.js')
  const { saveConfigOverlay } = await import('../packages/core/src/store/root.js')
  const { stateInventory } = await import('../packages/core/src/store/inventory.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-layout-writes-'))
  try {
    new Inbox(root, () => {}).add(inbound(), 'session')
    new FileCounterStore({ stateRoot: root }).set('line:conversation', 1)
    assert.equal(new SessionLines(root, () => {}).saveRouting('conversation', { project: 'default', sessions: { default: { current: 2, max: 2 } } }), true)
    new Journal({ stateRoot: root }).append({ direction: 'in', phase: 'received', id: 'test', channel: 'fake', accountId: 'a', conversationId: 'c', kind: 'message', text: 'hi' })
    new Outbox({ stateRoot: root }).add({ channel: 'fake', accountId: 'a', conversationId: 'c' }, { kind: 'reply', text: 'hi' }, {})
    createLogger({ stateRoot: root }).info('test')
    assert.equal(saveConfigOverlay(root, { allowedSenders: ['sender'] }), true)
    assert.deepEqual(fs.readdirSync(root).sort(), ['config.json', 'counters.json', 'inbox.json', 'journal', 'lines.json', 'logs', 'outbox.json', 'state.json'])
    assert.deepEqual(stateInventory(root).unlisted, [])
  } finally { fs.rmSync(root, { recursive: true }) }
})
