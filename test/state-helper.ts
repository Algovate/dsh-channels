import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stateFile, type StateSection } from '../packages/core/src/store/state.js'

/** Inspect the committed bytes, not a store's in-memory cache. */
export function readSectionJson(root: string, section: StateSection): string {
  return JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).sections[section] ?? null)
}

/** Replace a logical section in fixtures; invalid JSON simulates an invalid section. */
export function writeSectionJson(root: string, section: StateSection, json: string): void {
  let value: unknown
  try { value = JSON.parse(json) } catch { value = json }
  assert.equal(stateFile(root).write(section, value), true)
}
