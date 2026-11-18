/**
 * Small file helpers. Every write is atomic (temp file + rename) and a read
 * failure is a value, not a crash: a channel plugin must not lose a turn to a
 * half-written JSON file.
 *
 * @module @derekluo/dsh-channels/store/atomic
 */
import fs from 'node:fs'
import path from 'node:path'

export function atomicWriteJson(file: string, value: unknown, options: { mode?: number; warn?: (line: string) => void } = {}): boolean {
  const mode = options.mode ?? 0o600
  const warn = options.warn ?? (() => {})
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode })
    fs.renameSync(temp, file)
    return true
  } catch (error) {
    warn(`could not write ${path.basename(file)}: ${String((error as Error)?.message ?? error)}`)
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // The temp file is already useless.
    }
    return false
  }
}

export function readJsonFile<T>(file: string, fallback: () => T, warn?: (line: string) => void): T {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') warn?.(`could not read ${path.basename(file)}: ${String(error)}`)
    return fallback()
  }
  try {
    return JSON.parse(text) as T
  } catch (error) {
    warn?.(`${path.basename(file)} is not JSON: ${String(error)}`)
    return fallback()
  }
}

/** Critical object state: only an absent file means an empty configuration. */
export function readJsonObject(file: string): Record<string, unknown> {
  let text: string
  try { text = fs.readFileSync(file, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid object state in ${path.basename(file)}`)
  return value as Record<string, unknown>
}
