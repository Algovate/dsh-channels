import assert from 'node:assert/strict'
import test from 'node:test'

import { plainText, splitIntoBubbles } from '../packages/core/src/outbound.js'

test('short text stays one bubble, and empty text is no bubble at all', () => {
  assert.deepEqual(splitIntoBubbles('你好', 600), ['你好'])
  assert.deepEqual(splitIntoBubbles('', 600), [])
  assert.deepEqual(splitIntoBubbles('x', 0), ['x'], 'a zero limit means no splitting')
})

test('a reply splits on paragraph boundaries and loses nothing', () => {
  const paragraph = 'a'.repeat(40)
  const text = `${paragraph}\n\n${paragraph}\n\n${paragraph}`
  const bubbles = splitIntoBubbles(text, 90)
  assert.ok(bubbles.length > 1)
  assert.equal(bubbles.join('').replace(/\s/g, ''), text.replace(/\s/g, ''), 'no character is dropped')
  assert.ok(bubbles.every((bubble) => bubble.length <= 90), 'every bubble respects the limit')
})

test('a single over-long line is hard-split rather than rejected', () => {
  const bubbles = splitIntoBubbles('x'.repeat(250), 100)
  assert.equal(bubbles.length, 3)
  assert.ok(bubbles.every((bubble) => bubble.length <= 100))
})

test('bubbles never end with whitespace and never start with it', () => {
  const text = '句子一。'.repeat(30)
  for (const bubble of splitIntoBubbles(text, 30)) {
    assert.equal(bubble, bubble.trim())
  }
})

test('markdown a plain-text channel cannot render is unwrapped', () => {
  assert.equal(plainText('**粗体** 与 *斜体*'), '粗体 与 斜体')
  assert.equal(plainText('`inline` code'), 'inline code')
  assert.equal(plainText('## 标题'), '标题')
  assert.equal(plainText('[链接](https://example.com)'), '链接 (https://example.com)')
})

test('a fenced code block keeps its content', () => {
  const out = plainText('看这个：\n```js\nconst a = 1\n```\n完')
  assert.match(out, /const a = 1/)
  assert.doesNotMatch(out, /```/)
})
