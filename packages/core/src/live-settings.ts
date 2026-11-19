import type { ChannelsConfig } from './config.js'

const limits = ['senderPerMinute', 'senderPerDay'] as const
const flags = ['autoSendFiles', 'questionsEnabled', 'approvalsEnabled'] as const
export type LiveSettings = Pick<ChannelsConfig, typeof limits[number] | typeof flags[number]>
export type LiveSettingsPatch = Partial<LiveSettings>

export function parseLiveSettingsPatch(raw: Record<string, unknown>): LiveSettingsPatch {
  const patch: LiveSettingsPatch = {}
  for (const key of limits) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000) throw new Error(`${key} must be an integer between 0 and 100000`)
    patch[key] = value
  }
  for (const key of flags) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
    patch[key] = value
  }
  return patch
}

export function liveSettings(config: ChannelsConfig): LiveSettings {
  return Object.fromEntries([...limits, ...flags].map((key) => [key, config[key]])) as LiveSettings
}

export function applyLiveSettings(config: ChannelsConfig, patch: LiveSettingsPatch): void {
  for (const key of limits) if (patch[key] !== undefined) config[key] = patch[key]
  for (const key of flags) if (patch[key] !== undefined) config[key] = patch[key]
}
