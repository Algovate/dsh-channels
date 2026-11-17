import assert from 'node:assert/strict'
import test from 'node:test'

import { inboundTextWithMedia } from '../packages/core/src/media.js'

const image = { kind: 'image' as const, path: '/state/media/a.png', mime: 'image/png', bytes: 2048, name: 'a.png' }
const voice = { kind: 'voice' as const, path: '/state/media/v.wav', mime: 'audio/wav', bytes: 9000 }
const file = { kind: 'file' as const, path: '/state/media/r.pdf', mime: 'application/pdf', bytes: 1024 * 1024, name: 'r.pdf' }

test('no media leaves the person\'s text exactly as it was', () => {
  assert.equal(inboundTextWithMedia({ text: '你好', media: [] }), '你好')
})

test('an image points the model at read_image, with the path and the size', () => {
  const text = inboundTextWithMedia({ text: '', media: [image] })
  assert.match(text, /\[用户发送的图片已保存到本地：\/state\/media\/a\.png（a\.png, 2\.0k）\]/)
  assert.match(text, /read_image/)
})

test('the person\'s words stay last, so nothing they said is buried', () => {
  const text = inboundTextWithMedia({ text: '看看这张', media: [image] })
  const blocks = text.split('\n\n')
  assert.match(blocks[0] ?? '', /图片/)
  assert.equal(blocks.at(-1), '看看这张')
})

test('a voice note without a transcript says it cannot be listened to', () => {
  const text = inboundTextWithMedia({ text: '', media: [voice] })
  assert.match(text, /语音/)
  assert.match(text, /audio\/wav/)
  assert.match(text, /无法读取音频就如实说明/)
})

test('a voice transcript is quoted as the person\'s words', () => {
  const text = inboundTextWithMedia({ text: '', media: [{ ...voice, transcript: '明天下午三点' }] })
  assert.match(text, /【语音转写】/)
  assert.match(text, /明天下午三点/)
})

test('an empty transcript is stated as empty instead of guessed', () => {
  const text = inboundTextWithMedia({ text: '', media: [{ ...voice, transcript: '   ' }] })
  assert.match(text, /没有识别出内容/)
})

test('a document is a file to read, and a video says it cannot be read', () => {
  assert.match(inboundTextWithMedia({ text: '', media: [file] }), /请用 read 工具读取/)
  assert.match(inboundTextWithMedia({ text: '', media: [{ kind: 'video', path: '/v.mp4', mime: 'video/mp4', bytes: 10 }] }), /视频文件，无法直接读取/)
})

test('an extracted document body travels inside the note, fenced and attributed', () => {
  const document = { kind: 'file' as const, path: '/state/media/c.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: 4096, name: 'c.docx', text: '第三条 甲方应于十日内付款。' }
  const text = inboundTextWithMedia({ text: '第三条写了什么？', media: [document] })
  assert.match(text, /<document path="\/state\/media\/c\.docx">/)
  assert.match(text, /第三条 甲方应于十日內付款。|第三条 甲方应于十日内付款。/)
  assert.match(text, /可能被截断/)
  assert.equal(text.split('\n\n').at(-1), '第三条写了什么？', 'the person\'s question stays last')
})
