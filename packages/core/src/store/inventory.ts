/**
 * What the state root actually holds: one row per declared entry plus whatever
 * is on disk that the table does not know about.
 *
 * Read-only and never throws: a missing root, an unreadable file or a
 * permission error becomes a row, because `doctor` has to print the rest.
 *
 * @module @rodin/dsh-channels/store/inventory
 */
import fs from 'node:fs'
import path from 'node:path'

import { STATE_LAYOUT, STORE, type StoreTier } from './layout.js'

export function formatBytes(bytes: number): string {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1024) return `${value}B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}k`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}M`
  return `${(value / 1024 / 1024 / 1024).toFixed(1)}G`
}

export interface Usage {
  exists: boolean
  bytes: number
  files: number
  mtimeMs: number
}

function usageOf(absolute: string): Usage {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(absolute)
  } catch {
    return { exists: false, bytes: 0, files: 0, mtimeMs: 0 }
  }
  if (!stat.isDirectory()) return { exists: true, bytes: stat.size, files: 1, mtimeMs: stat.mtimeMs }
  let bytes = 0
  let files = 0
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        try {
          const fileStat = fs.lstatSync(full)
          bytes += fileStat.size
          files += 1
        } catch {
          // Vanished mid-walk; not counted.
        }
      }
    }
  }
  walk(absolute)
  return { exists: true, bytes, files, mtimeMs: stat.mtimeMs }
}

export interface InventoryRow extends Usage {
  key: string
  relative: string
  kind: 'file' | 'dir'
  store: StoreTier
  label: string
  reason?: string
  contents?: string
}

export interface Inventory {
  root: string
  entries: InventoryRow[]
  unlisted: Array<{ relative: string; kind: 'file' | 'dir' } & Usage>
  totals: { entries: number; present: number; bytes: number; files: number; domain: number; file: number; unlisted: number; unlistedBytes: number }
}

export function stateInventory(root: string): Inventory {
  const base = path.resolve(root)
  const entries: InventoryRow[] = []
  for (const [key, entry] of Object.entries(STATE_LAYOUT)) {
    const usage = usageOf(path.join(base, entry.relative))
    entries.push({
      key,
      relative: entry.relative,
      kind: entry.kind,
      store: entry.store,
      label: entry.label,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      ...(entry.contents === undefined ? {} : { contents: entry.contents }),
      ...usage,
    })
  }

  const declaredTop = new Set(Object.values(STATE_LAYOUT).map((entry) => entry.relative.split('/')[0]))
  const unlisted: Inventory['unlisted'] = []
  let dirents: fs.Dirent[] = []
  try {
    dirents = fs.readdirSync(base, { withFileTypes: true })
  } catch {
    // An unreadable root is the caller's own check.
  }
  for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (declaredTop.has(dirent.name)) continue
    unlisted.push({ relative: dirent.name, kind: dirent.isDirectory() ? 'dir' : 'file', ...usageOf(path.join(base, dirent.name)) })
  }

  const rootUsage = usageOf(base)
  const totals = {
    entries: entries.length,
    present: entries.filter((entry) => entry.exists === true).length,
    bytes: rootUsage.bytes,
    files: rootUsage.files,
    domain: entries.filter((entry) => entry.store === STORE.DOMAIN).length,
    file: entries.filter((entry) => entry.store === STORE.FILE).length,
    unlisted: unlisted.length,
    unlistedBytes: unlisted.reduce((sum, entry) => sum + entry.bytes, 0),
  }
  return { root: base, entries, unlisted, totals }
}

export function summarizeInventory(inventory: Inventory): string {
  const { totals } = inventory
  const parts = [`${totals.present}/${totals.entries} 项在表内`, `域 ${totals.domain} · 文件 ${totals.file}`, `状态目录共 ${formatBytes(totals.bytes)}（${totals.files} 个文件）`]
  if (totals.unlisted > 0) parts.push(`表外 ${totals.unlisted} 项 ${formatBytes(totals.unlistedBytes)}`)
  return parts.join('；')
}
