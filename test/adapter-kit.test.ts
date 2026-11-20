import assert from 'node:assert/strict'
import test from 'node:test'

import { defaultExtensionFor, extensionOfName, safeFileSegment } from '../packages/core/src/adapter-kit.js'

test('a path segment keeps safe characters and rejects traversal', () => {
  assert.equal(safeFileSegment('report-2026_11.pdf'), 'report-2026_11.pdf')
  assert.equal(safeFileSegment('a/b\\c:d'), 'a_b_c_d')
  assert.equal(safeFileSegment(''), 'attachment')
  assert.equal(safeFileSegment('..'), 'attachment')
  assert.equal(safeFileSegment('..', 'file'), 'file')
  assert.equal(safeFileSegment('x'.repeat(200)).length, 80)
})

test('an extension comes from the name only when it is plausible', () => {
  assert.equal(extensionOfName('clip.MP4'), '.mp4')
  assert.equal(extensionOfName('no-extension'), '')
  assert.equal(extensionOfName(''), '')
  assert.equal(extensionOfName(undefined), '')
  // A dot deep in a name is not an extension, and absurd lengths are refused.
  assert.equal(extensionOfName('a.b/c'), '')
  assert.equal(extensionOfName(`x.${'y'.repeat(20)}`), '')
})

test('kind defaults cover every kind and let a channel override voice', () => {
  assert.equal(defaultExtensionFor('image'), '.jpg')
  assert.equal(defaultExtensionFor('video'), '.mp4')
  assert.equal(defaultExtensionFor('file'), '.bin')
  assert.equal(defaultExtensionFor('voice'), '.ogg')
  assert.equal(defaultExtensionFor('voice', '.silk'), '.silk')
})
