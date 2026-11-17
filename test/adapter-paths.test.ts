import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { packageRoot } from '../packages/adapter-weixin/src/index.js'

// Tests run from the repository root; the compiled copy under dist-test has no
// manifest of its own, so these assertions are about the real package tree.
const PACKAGE_SRC = path.resolve(process.cwd(), 'packages', 'adapter-weixin', 'src')

test('the package root is found from the source layout', () => {
  const root = packageRoot(PACKAGE_SRC)
  assert.equal(fs.existsSync(path.join(root, 'package.json')), true)
  assert.equal(path.basename(root), 'adapter-weixin')
})

test('the ASR script ships inside the package, not under dist', () => {
  const root = packageRoot(PACKAGE_SRC)
  assert.equal(fs.existsSync(path.join(root, 'bin', 'asr-bridge.py')), true)
  // The compiled entry lives at dist/src/index.js, two levels below the root:
  // this is the path the adapter actually resolves at runtime.
  assert.equal(packageRoot(path.join(root, 'dist', 'src')), root)
})
