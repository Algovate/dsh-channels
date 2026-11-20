import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { packageRoot } from '../packages/adapter-weixin/src/index.js'
import { sharedAsrScript as weixinScript } from '../packages/adapter-weixin/src/asr.js'
import { sharedAsrScript as feishuScript } from '../packages/adapter-feishu/src/asr.js'

// Tests run from the repository root; the compiled copy under dist-test has no
// manifest of its own, so these assertions are about the real package tree.
const PACKAGE_SRC = path.resolve(process.cwd(), 'packages', 'adapter-weixin', 'src')

test('the package root is found from the source layout', () => {
  const root = packageRoot(PACKAGE_SRC)
  assert.equal(fs.existsSync(path.join(root, 'package.json')), true)
  assert.equal(path.basename(root), 'adapter-weixin')
})

test('both adapters resolve the one ASR bridge shipped by the core package', () => {
  const root = packageRoot(PACKAGE_SRC)
  // The compiled entry lives at dist/src/index.js, two levels below the root:
  // this is the path the adapter actually resolves at runtime.
  assert.equal(packageRoot(path.join(root, 'dist', 'src')), root)

  const script = weixinScript()
  assert.ok(script !== undefined, 'the WeChat adapter must find the shared bridge')
  assert.equal(fs.existsSync(script), true)
  assert.equal(path.basename(script!), 'asr-transcribe.py')
  // A workspace checkout resolves through the symlink to packages/core; an
  // installed profile resolves to node_modules/@derekluo/dsh-channels.
  assert.equal(script!.includes('adapter-'), false, 'the bridge must not live in an adapter package')
  // One script, not a copy per adapter.
  assert.equal(feishuScript(), script)
})
