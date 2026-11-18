/** Atomic routing identity; numeric entries from older releases remain readable. */
import fs from 'node:fs'
import { atomicWriteJson } from './atomic.js'
import { statePath } from './layout.js'

export interface SessionSelection { current: number; max: number }
export interface ChatRouting { project: string; sessions: Record<string, SessionSelection> }
const validLine = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
function validRouting(value: unknown): value is ChatRouting {
  if (value === null || typeof value !== 'object') return false
  const state = value as ChatRouting
  return typeof state.project === 'string' && state.sessions !== null && typeof state.sessions === 'object' && !Array.isArray(state.sessions)
    && Object.values(state.sessions).every((line) => line !== null && typeof line === 'object' && validLine(line.current) && validLine(line.max) && line.current <= line.max)
}

export class SessionLines {
  readonly #file: string
  readonly #warn: (line: string) => void
  #values: Record<string, number | ChatRouting> = {}
  #unreadable = false
  constructor(root: string, warn: (line: string) => void) {
    this.#file = statePath(root, 'lines')
    this.#warn = warn
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(this.#file, 'utf8'))
      if (saved === null || typeof saved !== 'object' || Array.isArray(saved) || !Object.values(saved).every((value) => validLine(value) || validRouting(value))) throw new Error('invalid routing state')
      this.#values = saved as Record<string, number | ChatRouting>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.#unreadable = true; warn(`session routing could not be loaded: ${String(error)}`) }
    }
  }
  routing(key: string, legacy: number): ChatRouting {
    if (this.#unreadable) throw new Error('session routing is unreadable; repair lines.json before continuing')
    const value = Object.hasOwn(this.#values, key) ? this.#values[key] : undefined
    if (value !== undefined && typeof value === 'object') return structuredClone(value)
    const line = typeof value === 'number' ? value : validLine(legacy) ? legacy : 0
    return { project: 'default', sessions: { default: { current: line, max: line } } }
  }
  saveRouting(key: string, state: ChatRouting): boolean { return validRouting(state) && this.#write(key, state) }
  #write(key: string, value: number | ChatRouting): boolean {
    const next = { ...this.#values, [key]: value }
    if (this.#unreadable || !atomicWriteJson(this.#file, next, { warn: this.#warn })) return false
    this.#values = next
    return true
  }
}
