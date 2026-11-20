import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { resetStateFile, stateFile, type StateSection } from '../packages/core/src/store/state.js'
import path from 'node:path'

/** Inspect a section as the stores see it (the database is the authority). */
export function readSectionJson(root: string, section: StateSection): string {
  return JSON.stringify(stateFile(root).read(section) ?? null)
}

/** Replace a logical section in fixtures; invalid JSON simulates an invalid section. */
export function writeSectionJson(root: string, section: StateSection, json: string): void {
  let value: unknown
  try { value = JSON.parse(json) } catch { value = json }
  assert.equal(stateFile(root).write(section, value), true)
}

/** Replace a section with raw bytes (invalid JSON simulates a corrupt row). */
export function corruptSectionJson(root: string, section: StateSection, raw: string): void {
  resetStateFile(root)
  const db = new DatabaseSync(path.join(root, 'state.db'))
  db.prepare('INSERT INTO sections (name, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
    .run(section, raw, Date.now())
  db.close()
}

/** Read a section's raw stored JSON without validating it. */
export function readRawSectionJson(root: string, section: StateSection): string | undefined {
  resetStateFile(root)
  const db = new DatabaseSync(path.join(root, 'state.db'), { readOnly: true })
  try {
    const row = db.prepare('SELECT json FROM sections WHERE name = ?').get(section) as { json?: string } | undefined
    return row?.json
  } finally { db.close() }
}
