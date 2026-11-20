/**
 * The edge's one durable state document, now backed by SQLite.
 *
 * Section stores keep calling `read`/`write`/`writeMany`; what changed is the
 * medium. A section is one row in `sections`, written in a transaction, so a
 * multi-section commit (task + outbox) is atomic without rewriting unrelated
 * data. The hand-rolled atomic file writer, v1→v2 migration and legacy mirrors
 * are gone: [database.ts](./database.ts) imports the old JSON once and archives
 * it under `legacy-state/`.
 *
 * @module @derekluo/dsh-channels/store/state
 */
import path from 'node:path'

import { stateSectionsValid } from './schema.js'
import { StateDatabase } from './database.js'

export type StateSection = 'inbox' | 'tasks' | 'outbox' | 'lines' | 'schedules' | 'counters' | 'pairings'

interface StateDocument {
  version?: number
  savedAt?: number
  sections?: unknown
}

const instances = new Map<string, StateFile>()

/** Test seam: close the cached document and release its lock. */
export function resetStateFile(stateRoot: string): void {
  const key = path.resolve(stateRoot)
  const existing = instances.get(key)
  if (existing === undefined) return
  instances.delete(key)
  existing.close()
}

/** One shared database per state root; every store in this process uses it. */
export function stateFile(stateRoot: string, warn: (line: string) => void = () => {}): StateFile {
  const key = path.resolve(stateRoot)
  const existing = instances.get(key)
  if (existing !== undefined) return existing
  const created = new StateFile(key, warn)
  instances.set(key, created)
  return created
}

export class StateFile {
  readonly #database: StateDatabase
  readonly #failNext = new Set<StateSection>()

  constructor(root: string, warn: (line: string) => void) {
    this.#database = new StateDatabase({ root, warn })
  }

  get error(): string | undefined { return this.#database.error }

  /** Read one canonical section; only an absent section means it is empty. */
  read<T>(section: StateSection): T | undefined {
    return this.#database.read(section) as T | undefined
  }

  /** Test seam: make the next write of one section fail without touching the others. */
  failNextWrite(section: StateSection): void {
    this.#failNext.add(section)
  }

  /** Replace one canonical section. */
  write(section: StateSection, value: unknown): boolean {
    return this.writeMany({ [section]: value })
  }

  /** Commit related ledger changes in one transaction. */
  writeMany(sections: Partial<Record<StateSection, unknown>>): boolean {
    for (const [section] of Object.entries(sections) as Array<[StateSection, unknown]>) {
      if (this.#failNext.delete(section)) return false
    }
    return this.#database.writeMany(sections)
  }

  close(): void {
    this.#database.close()
    this.#database.releaseLock()
  }
}

/** Read-only validation used by tests and the importer's diagnostics. */
export function stateDocumentValid(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const document = value as StateDocument
  return (document.version === 1 || document.version === 2) && typeof document.savedAt === 'number'
    && Number.isFinite(document.savedAt) && stateSectionsValid(document.sections)
}
