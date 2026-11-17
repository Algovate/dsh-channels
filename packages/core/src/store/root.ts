/**
 * Where this plugin keeps its state.
 *
 * One root, named after the plugin, never shared with another plugin: two
 * channel plugins writing one directory would fight over the account
 * credentials and the long-poll cursor of the same WeChat account.
 *
 * @module @rodin/dsh-channels/store/root
 */
import os from 'node:os'
import path from 'node:path'

export const STATE_ENV = 'DSH_CHANNELS_STATE_DIR'

/** Absolute path of the state root. */
export function stateRoot(): string {
  const override = process.env[STATE_ENV]?.trim()
  if (override !== undefined && override !== '') return path.resolve(override)
  return path.join(os.homedir(), '.dsh', 'channels')
}
