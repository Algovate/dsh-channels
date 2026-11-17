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
 * @module @derekluo/dsh-channels/documents
 */
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { promisify } from 'node:util'
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
async function readZipEntry(buffer: Buffer, wanted: string): Promise<Buffer | undefined> {
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
        if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) return undefined
        const localNameLength = buffer.readUInt16LE(localOffset + 26)
        const localExtraLength = buffer.readUInt16LE(localOffset + 28)
        const start = localOffset + 30 + localNameLength + localExtraLength
        if (start + compressedSize > buffer.length) return undefined
        const data = buffer.subarray(start, start + compressedSize)
        if (method === 0 && data.length <= MAX_DOCUMENT_XML_BYTES) return data
        if (method === 8) return promisify(zlib.inflateRaw)(data, { maxOutputLength: MAX_DOCUMENT_XML_BYTES })
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

/** Minimal PDF contract, kept internal to the binary-document worker. */
export interface PdfLoader {
  getDocument(options: { data: Uint8Array; isEvalSupported: boolean }): {
    promise: Promise<{
      numPages: number
      getPage(page: number): Promise<{ getTextContent(): Promise<{ items: Array<{ str?: string }> }>; cleanup(): void }>
    }>
    destroy(): Promise<void>
  }
}

/** Bound page work and text accumulation, and release PDF resources even after parsing fails. */
export async function pdfText(pdfjs: PdfLoader, data: Uint8Array, maxChars: number): Promise<{ text: string; truncated: boolean }> {
  const task = pdfjs.getDocument({ data, isEvalSupported: false })
  try {
    const document = await task.promise
    let text = ''
    let visited = 0
    for (let page = 1; page <= Math.min(document.numPages, 20); page++) {
      const current = await document.getPage(page)
      try {
        const content = await current.getTextContent()
        if (text !== '') text += '\n\n'
        for (const item of content.items) {
          if (typeof item.str !== 'string') continue
          text += item.str.slice(0, Math.max(0, maxChars + 1 - text.length)) + ' '
          if (text.length > maxChars) break
        }
        visited = page
      } finally { current.cleanup() }
      if (text.length > maxChars) break
    }
    return { ...truncate(text.trim(), maxChars), truncated: text.length > maxChars || visited < document.numPages }
  } finally { await task.destroy() }
}

/** Runs in a worker: parser CPU and memory do not block the host's turn deadline. */
export async function parseBinaryDocument(bytes: Uint8Array, extension: string, maxChars: number): Promise<DocumentResult> {
  if (extension === '.docx') {
    const xml = await readZipEntry(Buffer.from(bytes), 'word/document.xml')
    if (xml === undefined) return { ok: false, kind: 'docx', reason: 'no word/document.xml in the archive' }
    return { ok: true, kind: 'docx', ...truncate(docxXmlToText(xml.toString('utf8')), maxChars) }
  }
  const moduleName = 'pdfjs-dist/legacy/build/pdf.mjs'
  let pdfjs: PdfLoader
  try { pdfjs = await import(moduleName) as PdfLoader } catch { throw new Error(PDF_HINT) }
  return { ok: true, kind: 'pdf', ...await pdfText(pdfjs, bytes, maxChars) }
}

const MAX_BINARY_BYTES = 8 * 1024 * 1024

/** Read at most a fixed budget, even if a file grows while it is being read. */
async function readBounded(filePath: string, budget: number, signal?: AbortSignal): Promise<{ bytes: Buffer; more: boolean }> {
  signal?.throwIfAborted()
  const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('document is not a regular file')
    const buffer = Buffer.alloc(Math.min(stat.size, budget) + 1)
    let size = 0
    while (size < buffer.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
      if (bytesRead === 0) break
      size += bytesRead
    }
    return { bytes: buffer.subarray(0, Math.min(size, budget)), more: size > budget }
  } finally { await file.close() }
}

async function parseInWorker(bytes: Buffer, extension: string, maxChars: number, signal?: AbortSignal): Promise<DocumentResult> {
  signal?.throwIfAborted()
  const worker = new Worker(new URL('./document-worker.js', import.meta.url), {
    workerData: { bytes, extension, maxChars },
    resourceLimits: { maxOldGenerationSizeMb: 128 },
  })
  let abort!: () => void
  let timer!: ReturnType<typeof setTimeout>
  try {
    return await new Promise<DocumentResult>((resolve, reject) => {
      abort = () => reject(signal?.reason ?? new Error('document parsing aborted'))
      worker.once('message', (result: DocumentResult) => resolve(result))
      worker.once('error', reject)
      worker.once('exit', (code) => reject(new Error(`document parser exited before answering (${code})`)))
      timer = setTimeout(() => reject(new Error('document parsing timed out')), 5000)
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    await worker.terminate()
  }
}

/** Extract a bounded prefix; failures preserve the original attachment for the agent. */
export async function extractDocumentText(
  filePath: string,
  { maxChars = DEFAULT_DOCUMENT_CHARS, signal }: { maxChars?: number; signal?: AbortSignal } = {},
): Promise<DocumentResult> {
  const extension = path.extname(filePath).toLowerCase()
  const budget = Number.isFinite(maxChars) ? Math.max(1, Math.min(100_000, Math.floor(maxChars))) : DEFAULT_DOCUMENT_CHARS
  try {
    signal?.throwIfAborted()
    if (TEXT_EXTENSIONS.has(extension)) {
      const { bytes, more } = await readBounded(filePath, budget * 4 + 4, signal)
      const decoder = new TextDecoder()
      const raw = decoder.decode(bytes, { stream: more })
      return { ok: true, kind: 'text', ...truncate(raw, budget), truncated: more || raw.length > budget }
    }
    if (extension === '.docx' || extension === '.pdf') {
      const { bytes, more } = await readBounded(filePath, MAX_BINARY_BYTES, signal)
      if (more) throw new Error(`document exceeds ${MAX_BINARY_BYTES} bytes`)
      return await parseInWorker(bytes, extension, budget, signal)
    }
    return { ok: false, kind: 'unsupported', reason: `unsupported document type ${extension || '(none)'}` }
  } catch (error) {
    return { ok: false, kind: extension === '.pdf' ? 'pdf' : extension === '.docx' ? 'docx' : 'text', reason: String((error as Error)?.message ?? error) }
  }
}
