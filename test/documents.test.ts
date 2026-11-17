import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'

import { docxXmlToText, extractDocumentText } from '../packages/core/src/documents.js'

function dir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'channels-docs-'))
}

/** Build the smallest valid .docx: a zip with one stored + one deflated entry. */
function writeDocx(file: string, xml: string): void {
  const name = Buffer.from('word/document.xml')
  const data = Buffer.from(xml, 'utf8')
  const deflated = zlib.deflateRawSync(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(deflated.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(deflated.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE(0, 42)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length + name.length, 12)
  eocd.writeUInt32LE(local.length + name.length + deflated.length, 16)
  fs.writeFileSync(file, Buffer.concat([local, name, deflated, central, name, eocd]))
}

test('docx xml becomes paragraph text with entities decoded', () => {
  const text = docxXmlToText('<w:p><w:r><w:t>条款 3</w:t></w:r></w:p><w:p><w:t>A&amp;B</w:t></w:p>')
  assert.match(text, /条款 3/)
  assert.match(text, /A&B/)
})

test('a real docx archive yields its text', async () => {
  const file = path.join(dir(), 'contract.docx')
  writeDocx(file, '<w:p><w:r><w:t>第三条 甲方应于十日内付款。</w:t></w:r></w:p>')
  const result = await extractDocumentText(file)
  assert.equal(result.ok, true)
  assert.match(result.ok ? result.text : '', /第三条/)
})

test('a plain text file is read directly', async () => {
  const file = path.join(dir(), 'notes.md')
  fs.writeFileSync(file, '# 标题\n正文内容')
  const result = await extractDocumentText(file)
  assert.equal(result.ok, true)
  assert.match(result.ok ? result.text : '', /正文内容/)
})

test('the text is truncated at the character budget and says so', async () => {
  const file = path.join(dir(), 'long.txt')
  fs.writeFileSync(file, 'a'.repeat(500))
  const result = await extractDocumentText(file, { maxChars: 100 })
  assert.equal(result.ok, true)
  assert.equal(result.ok ? result.text.length : 0, 100)
  assert.equal(result.ok ? result.truncated : false, true)
})

test('a pdf without the optional parser is a reason, not a crash', async () => {
  const file = path.join(dir(), 'x.pdf')
  fs.writeFileSync(file, '%PDF-1.4\n')
  const result = await extractDocumentText(file)
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /pdfjs-dist/)
})

test('an unknown extension says it is unsupported', async () => {
  const file = path.join(dir(), 'x.bin')
  fs.writeFileSync(file, 'x')
  const result = await extractDocumentText(file)
  assert.deepEqual(result.ok, false)
  assert.equal(result.ok === false ? result.kind : '', 'unsupported')
})

test('a small DOCX archive cannot expand its document XML without a bound', async () => {
  const file = path.join(dir(), 'oversized.docx')
  writeDocx(file, 'x'.repeat(9 * 1024 * 1024))
  assert.ok(fs.statSync(file).size < 16 * 1024)
  const result = await extractDocumentText(file)
  assert.equal(result.ok, false)
})
