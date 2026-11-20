/**
 * The durable state medium: one SQLite database per state root.
 *
 * Before this module the state was a JSON document rewritten whole on every
 * change, protected by a hand-rolled lock file pair and a v1→v2 migration with
 * legacy mirrors. SQLite gives the same atomic section replace with a real
 * transaction, a journal, and no rewrite of unrelated sections; the bespoke
 * lock, archive and mirror code is gone.
 *
 * Sections stay validated JSON payloads (see schema.ts) rather than normalized
 * tables: every reader loads a whole section anyway, and the documented caps
 * (500 queued inputs, 100 schedules) are far below the scale where per-row
 * indexing would pay for itself.
 *
 * @module @derekluo/dsh-channels/store/database
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { stateSectionsValid } from './schema.js'
import { statePath } from './layout.js'
import type { StateSection } from './state.js'

/** The legacy per-section files, read once when a database is first created. */
const LEGACY_SECTION_FILES: Array<[StateSection, string]> = [
  ['inbox', 'inbox.json'],
  ['tasks', 'tasks.json'],
  ['outbox', 'outbox.json'],
  ['lines', 'lines.json'],
  ['schedules', 'schedules.json'],
  ['counters', 'counters.json'],
  ['pairings', 'pairings.json'],
]

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sections (
  name TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export interface DatabaseOptions {
  root: string
  warn: (line: string) => void
}

export class StateDatabase {
  readonly #root: string
  readonly #warn: (line: string) => void
  readonly #file: string
  #db: DatabaseSync | undefined
  #error: string | undefined
  #closed = false

  constructor(options: DatabaseOptions) {
    this.#root = options.root
    this.#warn = options.warn
    this.#file = statePath(options.root, 'state')
    try {
      fs.mkdirSync(this.#root, { recursive: true, mode: 0o700 })
    } catch (error) {
      this.#error = `could not create the state root: ${String(error)}`
      this.#warn(this.#error)
      return
    }
    const lockError = this.#acquire()
    if (lockError !== undefined) {
      this.#error = lockError
      this.#warn(lockError)
      return
    }
    try {
      this.#db = new DatabaseSync(this.#file)
      this.#db.exec('PRAGMA journal_mode = WAL')
      this.#db.exec('PRAGMA synchronous = NORMAL')
      this.#db.exec('PRAGMA busy_timeout = 5000')
      this.#db.exec(SCHEMA)
      this.#importLegacy()
    } catch (error) {
      this.#error = `state database unavailable; refusing new work: ${String((error as Error)?.message ?? error)}`
      this.#warn(this.#error)
      this.#db?.close()
      this.#db = undefined
    }
  }

  get error(): string | undefined { return this.#error }

  /**
   * One process owns a state root. The lock is a directory so acquiring it is
   * a single atomic mkdir; a directory left by a dead pid is taken over.
   */
  #acquire(): string | undefined {
    const directory = path.join(this.#root, 'state.lock.d')
    const owner = path.join(directory, 'owner.json')
    const tryAcquire = (): string | undefined => {
      try {
        fs.mkdirSync(directory, { recursive: false, mode: 0o700 })
        fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { mode: 0o600 })
        return undefined
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return `could not acquire the state lock: ${String(error)}`
        return 'busy'
      }
    }
    let result = tryAcquire()
    if (result !== 'busy') return result
    let holder: number | undefined
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(owner, 'utf8'))
      holder = raw !== null && typeof raw === 'object' ? (raw as { pid?: number }).pid : undefined
    } catch {
      holder = undefined
    }
    if (Number.isSafeInteger(holder) && (holder as number) !== process.pid && isAlive(holder as number)) {
      return `another process (pid ${String(holder)}) owns this state root: ${this.#root}`
    }
    // The previous owner is gone (or this process is reacquiring): replace the
    // directory, then take the same atomic create path again.
    try { fs.rmSync(directory, { recursive: true, force: true }) } catch { /* Best effort. */ }
    result = tryAcquire()
    return result === 'busy' ? 'another process took the state lock while it was being recovered; retry' : result
  }

  /** Import the legacy JSON state exactly once, then archive it. */
  #importLegacy(): void {
    const rows = this.#db!.prepare('SELECT COUNT(*) AS count FROM sections').get() as { count?: number } | undefined
    if ((rows?.count ?? 0) > 0) {
      // A previous open committed the import but died before archiving; finish
      // that here instead of leaving stale legacy files in the state root.
      this.#archiveLeftovers()
      return
    }
    const sections: Partial<Record<StateSection, unknown>> = {}
    const sources: string[] = []
    const document = path.join(this.#root, 'state.json')
    if (fs.existsSync(document)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(document, 'utf8'))
      const valid = parsed !== null && typeof parsed === 'object'
        && ((parsed as { version?: number }).version === 1 || (parsed as { version?: number }).version === 2)
        && stateSectionsValid((parsed as { sections?: unknown }).sections)
      if (!valid) throw new Error('state.json has an invalid version, envelope or section')
      Object.assign(sections, structuredClone((parsed as { sections?: Record<string, unknown> }).sections ?? {}))
      sources.push(document)
    }
    for (const [section, name] of LEGACY_SECTION_FILES) {
      const file = path.join(this.#root, name)
      let stat: fs.Stats
      try { stat = fs.lstatSync(file) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      if (!stat.isFile()) throw new Error(`legacy ${name} is not a regular file`)
      if (!Object.hasOwn(sections, section)) sections[section] = JSON.parse(fs.readFileSync(file, 'utf8'))
      sources.push(file)
    }
    if (sources.length === 0) return
    if (!stateSectionsValid(sections)) throw new Error('invalid legacy state section; repair the source before migrating')
    this.#transaction(() => {
      const insert = this.#db!.prepare('INSERT OR REPLACE INTO sections (name, json, updated_at) VALUES (?, ?, ?)')
      for (const [name, value] of Object.entries(sections)) insert.run(name, JSON.stringify(value), Date.now())
    })
    for (const source of sources) this.#archive(source)
    // Old lock files belong to the replaced writer; archive them in the same
    // pass so the state root is declared-clean immediately after migration.
    this.#archiveLeftovers()
  }

  /** Archive any legacy input still present after a successful import. */
  #archiveLeftovers(): void {
    for (const source of this.#legacySources()) {
      try { this.#archive(source) } catch (error) {
        throw new Error(`could not archive legacy state: ${String((error as Error)?.message ?? error)}`)
      }
    }
  }

  /** Every legacy state file that is still on disk. */
  #legacySources(): string[] {
    const sources: string[] = []
    // `state.lock`/`state.claim` belonged to the file-based writer that this
    // database replaced; archive them so no stale lock survives an upgrade.
    for (const name of ['state.json', 'state.lock', 'state.claim', ...LEGACY_SECTION_FILES.map(([, file]) => file)]) {
      const file = path.join(this.#root, name)
      try { if (fs.lstatSync(file).isFile()) sources.push(file) } catch { /* absent */ }
    }
    return sources
  }

  /** Copy one migrated file into legacy-state, then remove it from the state root. */
  #archive(source: string): void {
    const directory = statePath(this.#root, 'legacyState')
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('legacy-state is not a private directory')
    let destination = path.join(directory, `${path.basename(source)}.bak`)
    if (fs.existsSync(destination)) {
      destination = path.join(directory, `${path.basename(source)}.${randomUUID()}.bak`)
    }
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(destination, 0o600)
    fs.unlinkSync(source)
  }

  #transaction(work: () => void): void {
    const db = this.#db!
    db.exec('BEGIN IMMEDIATE')
    try {
      work()
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* The transaction may already be gone. */ }
      throw error
    }
  }

  /** Read one section; absent means empty. */
  read(section: StateSection): unknown | undefined {
    if (this.#error !== undefined) throw new Error(this.#error)
    if (this.#db === undefined) throw new Error('state database is closed')
    const row = this.#db.prepare('SELECT json FROM sections WHERE name = ?').get(section) as { json?: string } | undefined
    if (row?.json === undefined) return undefined
    return JSON.parse(row.json) as unknown
  }

  /** Replace related sections in one transaction. */
  writeMany(sections: Partial<Record<StateSection, unknown>>): boolean {
    if (this.#error !== undefined || this.#db === undefined || this.#closed) return false
    try {
      this.#transaction(() => {
        const statement = this.#db!.prepare('INSERT INTO sections (name, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
        for (const [name, value] of Object.entries(sections)) statement.run(name, JSON.stringify(value), Date.now())
      })
      return true
    } catch (error) {
      this.#warn(`state write failed: ${String((error as Error)?.message ?? error)}`)
      return false
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    try { this.#db?.close() } catch { /* Already closed. */ }
    this.#db = undefined
  }

  /** Test seam: drop the lock directory so another open can start clean. */
  releaseLock(): void {
    try { fs.rmSync(path.join(this.#root, 'state.lock.d'), { recursive: true, force: true }) } catch { /* Best effort. */ }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
