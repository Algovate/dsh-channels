/** Session identity is committed before acknowledging /new; quota writes may be best effort. */
import { atomicWriteJson, readJsonFile } from './atomic.js'
import { statePath } from './layout.js'

export class SessionLines {
  readonly #file: string
  readonly #warn: (line: string) => void
  readonly #values = new Map<string, number>()

  constructor(root: string, warn: (line: string) => void) {
    this.#file = statePath(root, 'lines')
    this.#warn = warn
    const saved = readJsonFile<unknown>(this.#file, () => ({}), warn)
    if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return
    for (const [key, value] of Object.entries(saved)) {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) this.#values.set(key, value)
    }
  }

  get(key: string): number | undefined { return this.#values.get(key) }

  set(key: string, line: number): boolean {
    const next = new Map(this.#values).set(key, line)
    if (!atomicWriteJson(this.#file, Object.fromEntries(next), { warn: this.#warn })) return false
    this.#values.set(key, line)
    return true
  }
}
