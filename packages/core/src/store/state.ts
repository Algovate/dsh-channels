/**
 * The edge's one durable state document.
 *
 * Before this module, inbox, tasks, outbox, routing, schedules and counters
 * were six independent JSON files rewritten one at a time. They now share one
 * atomically replaced document; the old files remain as read-compatible
 * mirrors so an upgrade, a manual edit, and the existing doctor keep working.
 *
 * The journal and config stay separate on purpose: the journal is append-only
 * diagnostics, and config is the operator's overlay.
 *
 * @module @derekluo/dsh-channels/store/state
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from './atomic.js'
import { statePath } from './layout.js'

export type StateSection = 'inbox' | 'tasks' | 'outbox' | 'lines' | 'schedules' | 'counters' | 'pairings'

interface StateDocument {
  version: 1
  savedAt: number
  sections: Partial<Record<StateSection, unknown>>
}

const LEGACY_KEY: Partial<Record<StateSection, string>> = {
  inbox: 'inbox',
  tasks: 'tasks',
  outbox: 'outbox',
  lines: 'lines',
  schedules: 'schedules',
  counters: 'counters',
}

const instances = new Map<string, StateFile>()

/** Test seam: forget the cached document so the next open re-reads the medium. */
export function resetStateFile(stateRoot: string): void {
  instances.delete(path.resolve(stateRoot))
}

/** One shared document per state root; every store in this process uses it. */
export function stateFile(stateRoot: string, warn: (line: string) => void = () => {}): StateFile {
  const key = path.resolve(stateRoot)
  const existing = instances.get(key)
  if (existing !== undefined) return existing
  const created = new StateFile(key, warn)
  instances.set(key, created)
  return created
}

export class StateFile {
  readonly #root: string
  readonly #file: string
  readonly #warn: (line: string) => void
  readonly #mirrorAt = new Map<StateSection, number>()
  readonly #failNext = new Set<StateSection>()
  #document: StateDocument = { version: 1, savedAt: 0, sections: {} }
  #loaded = false
  #error: string | undefined

  constructor(root: string, warn: (line: string) => void) {
    this.#root = root
    this.#file = statePath(root, 'state')
    this.#warn = warn
  }

  #load(): void {
    if (this.#loaded) return
    this.#loaded = true
    let text: string
    try {
      text = fs.readFileSync(this.#file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.#error = `could not read ${path.basename(this.#file)}: ${String(error)}`
      this.#warn(this.#error)
      return
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object')
      const document = parsed as Partial<StateDocument>
      if (document.version !== 1 || typeof document.savedAt !== 'number' || document.sections === null || typeof document.sections !== 'object' || Array.isArray(document.sections)) throw new Error('invalid state document')
      this.#document = document as StateDocument
    } catch (error) {
      this.#error = `state.json is invalid; refusing new work: ${String((error as Error)?.message ?? error)}`
      this.#warn(this.#error)
    }
  }

  #refuse(): never {
    throw new Error(this.#error ?? 'state is unavailable')
  }

  #legacyPath(section: StateSection): string | undefined {
    const key = LEGACY_KEY[section]
    return key === undefined ? undefined : statePath(this.#root, key)
  }

  #legacyMtime(section: StateSection): number | undefined {
    const legacy = this.#legacyPath(section)
    try { return legacy === undefined ? undefined : fs.statSync(legacy).mtimeMs } catch { return undefined }
  }

  /** Read one section; `undefined` means it has never been written. */
  read<T>(section: StateSection): T | undefined {
    this.#load()
    if (this.#error !== undefined) this.#refuse()
    const mirrorAt = this.#mirrorAt.get(section)
    const mtime = this.#legacyMtime(section)
    const legacy = this.#legacyPath(section)
    // On first read, a mirror newer than the last state save is an external
    // edit (or an old state file); afterwards only a newer mtime counts.
    if (mtime !== undefined && (mirrorAt === undefined ? !Object.hasOwn(this.#document.sections, section) || mtime > this.#document.savedAt : mtime > mirrorAt)) {
      try {
        if (legacy === undefined) throw new Error('no legacy mirror')
        const migrated = JSON.parse(fs.readFileSync(legacy, 'utf8'))
        this.#document.sections[section] = migrated
        this.#persist()
        this.#mirrorAt.set(section, mtime)
      } catch (error) {
        if (!Object.hasOwn(this.#document.sections, section)) {
          this.#error = `legacy ${LEGACY_KEY[section]} is unreadable and no canonical section exists: ${String((error as Error)?.message ?? error)}`
          this.#warn(this.#error)
          throw new Error(this.#error)
        }
        this.#warn(`legacy ${LEGACY_KEY[section]} could not be migrated; state.json remains authoritative: ${String((error as Error)?.message ?? error)}`)
      }
    } else if (mtime !== undefined && mirrorAt === undefined) {
      this.#mirrorAt.set(section, mtime)
    }
    if (!Object.hasOwn(this.#document.sections, section)) return undefined
    const value = this.#document.sections[section]
    return value === undefined ? undefined : structuredClone(value) as T
  }

  /** Test seam: make the next write of one section fail without touching the others. */
  failNextWrite(section: StateSection): void {
    this.#failNext.add(section)
  }

  /** Replace one section and mirror it to the legacy file for compatibility. */
  write(section: StateSection, value: unknown): boolean {
    this.#load()
    if (this.#error !== undefined) return false
    if (this.#failNext.delete(section)) return false
    this.#document.sections[section] = structuredClone(value)
    if (!this.#persist()) return false
    const mirror = this.#legacyPath(section)
    if (mirror !== undefined) {
      if (!atomicWriteJson(mirror, value, { warn: this.#warn })) {
        this.#warn(`legacy ${LEGACY_KEY[section]} mirror could not be updated; state.json remains authoritative`)
      }
      const mtime = this.#legacyMtime(section)
      if (mtime !== undefined) this.#mirrorAt.set(section, mtime)
    }
    return true
  }

  #persist(): boolean {
    this.#document.savedAt = Date.now()
    return atomicWriteJson(this.#file, this.#document, { warn: this.#warn })
  }
}
