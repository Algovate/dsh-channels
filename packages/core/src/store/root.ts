/**
 * Where this plugin keeps its state.
 *
 * One root, named after the plugin, never shared with another plugin: two
 * channel plugins writing one directory would fight over the account
 * credentials and the long-poll cursor of the same WeChat account.
 *
 * @module @derekluo/dsh-channels/store/root
 */
import { statePath } from './layout.js'
import os from 'node:os'
import path from 'node:path'

import { atomicWriteJson, readJsonObject } from './atomic.js'

export const STATE_ENV = 'DSH_CHANNELS_STATE_DIR'

/** Absolute path of the state root. */
export function stateRoot(): string {
  const override = process.env[STATE_ENV]?.trim()
  if (override !== undefined && override !== '') return path.resolve(override)
  return path.join(os.homedir(), '.dsh', 'channels')
}

/** Validate explicit access restrictions before either using or updating an overlay. */
export function readConfigState(root: string): Record<string, unknown> {
  const value = readJsonObject(statePath(root, 'config'))
  const strings = (input: unknown): boolean => Array.isArray(input) && input.every((item) => typeof item === 'string')
  for (const key of ['allowedSenders', 'allowedChats']) {
    if (Object.hasOwn(value, key) && !strings(value[key])) throw new Error(`invalid configuration field: ${key}`)
  }
  if (Object.hasOwn(value, 'enabled') && typeof value.enabled !== 'boolean') throw new Error('invalid configuration field: enabled')
  if (Object.hasOwn(value, 'allowlistPerAccount')) {
    const scoped = value.allowlistPerAccount
    if (scoped === null || typeof scoped !== 'object' || Array.isArray(scoped) || !Object.values(scoped).every(strings)) throw new Error('invalid configuration field: allowlistPerAccount')
  }
  return value
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
  const file = statePath(root, 'config')
  try {
    const current = readConfigState(root)
    return atomicWriteJson(file, { ...current, ...patch }, { mode: 0o600, ...options })
  } catch (error) {
    options.warn?.(`configuration could not be read; refusing overwrite: ${String(error)}`)
    return false
  }
}
