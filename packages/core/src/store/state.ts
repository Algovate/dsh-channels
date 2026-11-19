/**
 * The edge's one durable state document.
 *
 * Before this module, inbox, tasks, outbox, routing, schedules and counters
 * were six independent JSON files rewritten one at a time. They now share one
 * atomically replaced document; the old files remain as read-compatible
 * migration inputs. Version2 archives them once and never reads or writes them again.
 *
 * The journal and config stay separate on purpose: the journal is append-only
 * diagnostics, and config is the operator's overlay.
 *
 * @module @derekluo/dsh-channels/store/state
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { stateSectionsValid } from './schema.js'
import { atomicWriteJson } from './atomic.js'
import { statePath } from './layout.js'

export type StateSection = 'inbox' | 'tasks' | 'outbox' | 'lines' | 'schedules' | 'counters' | 'pairings'

interface StateDocument {
  version: 1 | 2
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
  readonly #failNext = new Set<StateSection>()
  #document: StateDocument = { version: 2, savedAt: 0, sections: {} }
  #loaded = false
  #error: string | undefined

  constructor(root: string, warn: (line: string) => void) {
    this.#root = root
    this.#file = statePath(root, 'state')
    this.#warn = warn
    const lockError = this.#acquireLock()
    if (lockError !== undefined) {
      this.#error = lockError
      this.#warn(lockError)
    }
  }

  /**
   * One process owns a state root. A lock held by a live pid refuses every
   * read/write; a lock left by a dead pid is taken over. The same pid may
   * reacquire after a runtime restart inside one process.
   */
  #acquireLock(): string | undefined {
    const lock = statePath(this.#root, 'stateLock')
    const claim = statePath(this.#root, 'stateClaim')
    try { fs.mkdirSync(this.#root, { recursive: true, mode: 0o700 }) } catch (error) { return `could not create the state root: ${String(error)}` }
    try {
      fs.writeFileSync(claim, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      return `state lock acquisition is busy or interrupted; inspect ${claim} before retrying: ${String(error)}`
    }
    try {
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(lock, 'utf8'))
        const pid = raw !== null && typeof raw === 'object' ? (raw as { pid?: unknown }).pid : undefined
        if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return 'invalid state.lock; inspect the owner before retrying'
        if (pid !== process.pid && processAlive(pid as number)) return `another process (pid ${pid}) owns this state root: ${this.#root}`
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return `could not read the state lock: ${String(error)}`
      }
      return atomicWriteJson(lock, { pid: process.pid, startedAt: Date.now() }, { warn: this.#warn })
        ? undefined : 'could not claim the state root'
    } finally {
      try { fs.unlinkSync(claim) }
      catch (error) { this.#warn(`could not release state lock acquisition: ${String(error)}`) }
    }
  }

  #load(): void {
    if (this.#loaded) return
    this.#loaded = true
    if (this.#error !== undefined) return
    try {
      let previous: StateDocument | undefined
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(this.#file, 'utf8'))
        if (!stateDocumentValid(parsed)) throw new Error('state.json has an invalid version, envelope or section')
        previous = parsed as StateDocument
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const sections = structuredClone(previous?.sections ?? {})
      const legacy: string[] = []
      for (const [section, key] of Object.entries(LEGACY_KEY) as Array<[StateSection, string]>) {
        const file = statePath(this.#root, key)
        let stat: fs.Stats
        try { stat = fs.lstatSync(file) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
        if (!stat.isFile()) throw new Error(`legacy ${key} is not a regular file`)
        legacy.push(file)
        if (previous?.version !== 2 && !Object.hasOwn(sections, section)) sections[section] = JSON.parse(fs.readFileSync(file, 'utf8'))
      }
      if (!stateSectionsValid(sections)) throw new Error('invalid legacy state section; repair the source before migrating')
      if (previous?.version !== 2) {
        if (previous) this.#archive(this.#file, 'state.v1.json', false)
        this.#document = { version: 2, savedAt: Date.now(), sections }
        if (!this.#persist()) throw new Error('migration could not commit state.json; legacy sources were retained')
      } else this.#document = previous
      for (const file of legacy) this.#archive(file, path.basename(file), true)
    } catch (error) {
      this.#error = `state migration failed; refusing new work: ${String((error as Error)?.message ?? error)}`
      this.#warn(this.#error)
    }
  }

  #archive(source: string, name: string, remove: boolean): void {
    const directory = statePath(this.#root, 'legacyState')
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('legacy-state is not a private directory')
    let destination = path.join(directory, `${name}.bak`)
    if (fs.existsSync(destination)) {
      if (!fs.lstatSync(destination).isFile()) throw new Error('migration backup is not a regular file')
      if (!fs.readFileSync(destination).equals(fs.readFileSync(source))) destination = path.join(directory, `${name}.${randomUUID()}.bak`)
    }
    if (!fs.existsSync(destination)) fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(destination, 0o600)
    if (remove) fs.unlinkSync(source)
  }

  #refuse(): never {
    throw new Error(this.#error ?? 'state is unavailable')
  }

  /** Read one canonical section; only an absent section means it is empty. */
  read<T>(section: StateSection): T | undefined {
    this.#load()
    if (this.#error !== undefined) this.#refuse()
    const value = this.#document.sections[section]
    return value === undefined ? undefined : structuredClone(value) as T
  }

  /** Test seam: make the next write of one section fail without touching the others. */
  failNextWrite(section: StateSection): void {
    this.#failNext.add(section)
  }

  /** Replace one canonical section. */
  write(section: StateSection, value: unknown): boolean {
    return this.writeMany({ [section]: value })
  }

  /** Commit related ledger changes with one atomic replacement. */
  writeMany(sections: Partial<Record<StateSection, unknown>>): boolean {
    this.#load()
    if (this.#error !== undefined) return false
    const entries = Object.entries(sections) as Array<[StateSection, unknown]>
    for (const [section] of entries) if (this.#failNext.delete(section)) return false
    const previous = this.#document
    this.#document = { version: 2, savedAt: previous.savedAt, sections: { ...previous.sections, ...structuredClone(sections) } }
    if (!this.#persist()) {
      this.#document = previous
      return false
    }

    return true
  }

  #persist(): boolean {
    this.#document.savedAt = Date.now()
    return atomicWriteJson(this.#file, this.#document, { warn: this.#warn })
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Read-only validation used by doctor as well as startup migration. */
export function stateDocumentValid(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const document = value as Partial<StateDocument>
  return (document.version === 1 || document.version === 2) && typeof document.savedAt === 'number'
    && Number.isFinite(document.savedAt) && stateSectionsValid(document.sections)
}
