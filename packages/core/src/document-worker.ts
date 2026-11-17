/** One disposable parser per binary attachment; the parent owns its deadline and cancellation. */
import { parentPort, workerData } from 'node:worker_threads'
import { parseBinaryDocument } from './documents.js'

const { bytes, extension, maxChars } = workerData as { bytes: Uint8Array; extension: string; maxChars: number }
try {
  parentPort?.postMessage(await parseBinaryDocument(bytes, extension, maxChars))
} catch (error) {
  parentPort?.postMessage({ ok: false, kind: extension === '.pdf' ? 'pdf' : 'docx', reason: String((error as Error)?.message ?? error) })
}
