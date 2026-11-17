/**
 * Where this plugin keeps its state.
 *
 * One root, named after the plugin, never shared with another plugin: two
 * channel plugins writing one directory would fight over the account
 * credentials and the long-poll cursor of the same WeChat account.
 *
 * @module @derekluo/dsh-channels/store/root
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { atomicWriteJson } from './atomic.js'

export const STATE_ENV = 'DSH_CHANNELS_STATE_DIR'

/** Absolute path of the state root. */
export function stateRoot(): string {
  const override = process.env[STATE_ENV]?.trim()
  if (override !== undefined && override !== '') return path.resolve(override)
  return path.join(os.homedir(), '.dsh', 'channels')
}

/**
 * Persist settings next to the credentials.
 *
 * The overlay is the plugin's OWN file (`<state>/config.json`), never the
 * profile's `cordis.patch.yml`: that one belongs to the user and holds other
 * plugins' rows. Writing our file with an atomic replace means a crash leaves
 * the previous settings intact instead of a half-written JSON.
 */
export function saveConfigOverlay(root: string, patch: Record<string, unknown>, options: { warn?: (line: string) => void } = {}): boolean {
  const file = path.join(root, 'config.json')
  const current = (() => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  })()
  return atomicWriteJson(file, { ...current, ...patch }, { mode: 0o600, ...options })
}
