import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { STORE, STATE_LAYOUT, declaredTopLevel, isInsideStateRoot, keyedStatePath, statePath, statePaths } from '../packages/core/src/store/layout.js'

const CORE_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'core', 'src')

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
  assert.equal(statePath(root, 'budget'), path.join(root, 'budget.json'))
  assert.throws(() => statePath(root, 'nope'), /unknown state entry/)
})

test('a pattern entry is a naming rule, not a path', () => {
  assert.equal(STATE_LAYOUT['lifeState']?.pattern, true)
  assert.throws(() => statePath('/tmp/x', 'lifeState'), /pattern, not a path/)
  for (const [key, entry] of Object.entries(STATE_LAYOUT)) {
    if (entry.pattern === true) continue
    assert.equal(entry.relative.includes('<'), false, `${key} has a placeholder but is not a pattern`)
  }
})

test('every entry says what the storage migration intends, and a file entry says why', () => {
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
  const full = keyedStatePath(root, 'memoryDir', '../../etc/passwd')
  assert.ok(full.startsWith(path.join(root, 'memory') + path.sep))
})

test('no module writes a top-level state path the table does not declare', () => {
  const tops = declaredTopLevel()
  const patterns = [/join\(\s*stateRoot\s*,\s*'([^']*)'/g, /join\(\s*root\s*,\s*'([^']*)'/g]
  const offenders: string[] = []
  for (const file of sourceFiles()) {
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
