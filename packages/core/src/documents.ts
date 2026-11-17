/**
 * Text out of an inbound document.
 *
 * A user sends a contract and asks "what does clause 3 say" — if the model only
 * receives a path, the answer is "I got a file". So the text is extracted at
 * turn time and travels with the attachment.
 *
 * Zero-dependency by default, because this package ships without a PDF parser:
 *   - `.txt`/`.md`/`.csv`/`.json`/`.log` are read directly;
 *   - `.docx` is a zip whose `word/document.xml` holds the text, and
 *     `node:zlib` can inflate it;
 *   - `.pdf` needs `pdfjs-dist` (optional). Without it the attachment keeps its
 *     path-only description and says PDF text was not extracted, instead of
 *     pretending.
 *
 * Extracted text is untrusted content: the caller fences it and truncates it.
 *
 * @module @rodin/dsh-channels/documents
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** How much of one document reaches the prompt. */
export const DEFAULT_DOCUMENT_CHARS = 4000

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log', '.xml', '.yaml', '.yml', '.ini', '.conf'])
const MAX_DOCUMENT_XML_BYTES = 8 * 1024 * 1024
const PDF_HINT = 'pdf text extraction needs the optional pdfjs-dist package'

export type DocumentResult =
  | { ok: true; kind: 'text' | 'docx' | 'pdf'; text: string; truncated: boolean }
  | { ok: false; kind: 'text' | 'docx' | 'pdf' | 'unsupported'; reason: string }

/** Read one file out of a zip's central directory; undefined when absent. */
function readZipEntry(buffer: Buffer, wanted: string): Buffer | undefined {
  const minEocd = 22
  for (let i = buffer.length - minEocd; i >= Math.max(0, buffer.length - 65_536 - minEocd); i -= 1) {
    if (buffer.readUInt32LE(i) !== 0x06054b50) continue
    const entries = buffer.readUInt16LE(i + 10)
    let offset = buffer.readUInt32LE(i + 16)
    for (let n = 0; n < entries; n += 1) {
      if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) return undefined
      const method = buffer.readUInt16LE(offset + 10)
      const compressedSize = buffer.readUInt32LE(offset + 20)
      const nameLength = buffer.readUInt16LE(offset + 28)
      const extraLength = buffer.readUInt16LE(offset + 30)
      const commentLength = buffer.readUInt16LE(offset + 32)
      const localOffset = buffer.readUInt32LE(offset + 42)
      const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
      if (name === wanted) {
        const localNameLength = buffer.readUInt16LE(localOffset + 26)
        const localExtraLength = buffer.readUInt16LE(localOffset + 28)
        const start = localOffset + 30 + localNameLength + localExtraLength
        const data = buffer.subarray(start, start + compressedSize)
        if (method === 0 && data.length <= MAX_DOCUMENT_XML_BYTES) return data
        if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_DOCUMENT_XML_BYTES })
        return undefined
      }
      offset += 46 + nameLength + extraLength + commentLength
    }
    return undefined
  }
  return undefined
}

/** `word/document.xml` → paragraph-per-line text. */
export function docxXmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^<>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, maxChars), truncated: true }
}

/** PDF text through the optional parser; a missing parser is a reason, not a crash. */
async function extractPdf(filePath: string): Promise<string> {
  let pdfjs: { getDocument?: (options: { data: Uint8Array; isEvalSupported: boolean }) => { promise: Promise<any> } }
  try {
    const moduleName = 'pdfjs-dist/legacy/build/pdf.mjs'
    pdfjs = (await import(moduleName)) as typeof pdfjs
  } catch {
    throw new Error(PDF_HINT)
  }
  if (typeof pdfjs.getDocument !== 'function') throw new Error(PDF_HINT)
  const data = new Uint8Array(fs.readFileSync(filePath))
  const document = await pdfjs.getDocument({ data, isEvalSupported: false }).promise
  const pages: string[] = []
  for (let page = 1; page <= document.numPages; page += 1) {
    const content = await (await document.getPage(page)).getTextContent()
    pages.push((content.items as Array<{ str?: string }>).map((item) => item.str ?? '').join(' '))
  }
  return pages.join('\n\n')
}

/**
 * Extract what can be extracted. Never throws: an unsupported or unreadable
 * document is a reason the caller logs, and the attachment still travels.
 */
export async function extractDocumentText(
  filePath: string,
  { maxChars = DEFAULT_DOCUMENT_CHARS }: { maxChars?: number } = {},
): Promise<DocumentResult> {
  const extension = path.extname(filePath).toLowerCase()
  try {
    if (TEXT_EXTENSIONS.has(extension)) {
      const raw = fs.readFileSync(filePath, 'utf8')
      return { ok: true, kind: 'text', ...truncate(raw, maxChars) }
    }
    if (extension === '.docx') {
      const xml = readZipEntry(fs.readFileSync(filePath), 'word/document.xml')
      if (xml === undefined) return { ok: false, kind: 'docx', reason: 'no word/document.xml in the archive' }
      return { ok: true, kind: 'docx', ...truncate(docxXmlToText(xml.toString('utf8')), maxChars) }
    }
    if (extension === '.pdf') {
      return { ok: true, kind: 'pdf', ...truncate(await extractPdf(filePath), maxChars) }
    }
    return { ok: false, kind: 'unsupported', reason: `unsupported document type ${extension || '(none)'}` }
  } catch (error) {
    const kind = extension === '.pdf' ? 'pdf' : extension === '.docx' ? 'docx' : 'text'
    return { ok: false, kind, reason: String((error as Error)?.message ?? error) }
  }
}
