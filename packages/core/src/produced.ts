/**
 * Files the agent produced during one turn.
 *
 * A chat reply is text, but half of what an agent does ends in a file: a chart,
 * a PDF, a script. The reference implementation solved this by scanning the
 * agent's working directory for files newer than the turn started, and that is
 * the only trigger that works without asking the model to declare its outputs —
 * which it does inconsistently.
 *
 * The scan is bounded (depth, count, size) and never follows symlinks: the
 * working directory belongs to the user, and a stray link could otherwise point
 * a photo of something private at a chat.
 *
 * @module @derekluo/dsh-channels/produced
 */
import fs from 'node:fs/promises'
import path from 'node:path'

export interface ProducedFile {
  path: string
  name: string
  bytes: number
  mtimeMs: number
}

export interface ScanOptions {
  dir: string
  /** Only files at or after this time count as produced by the turn. */
  sinceMs: number
  /** Hard caps: a run that writes a thousand files must not become a thousand sends. */
  maxFiles?: number
  maxBytes?: number
  maxDepth?: number
  /** Scan budget is independent of the number of attachments selected. */
  maxEntries?: number
  /** Directory names to skip anywhere in the tree. */
  ignoreDirs?: string[]
  /** Extensions never worth sending (intermediate junk). */
  ignoreExtensions?: string[]
}

const DEFAULT_IGNORE_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'dist-test', '.npm-cache'])
const DEFAULT_IGNORE_EXT = new Set(['.tmp', '.lock', '.log', '.part'])

export interface ProducedScan {
  files: ProducedFile[]
  skipped: number
  incomplete: boolean
}

/** Inspect a bounded tree before choosing the newest eligible files. */
export async function scanProducedFiles({
  dir, sinceMs, maxFiles = 5, maxBytes = 20 * 1024 * 1024,
  maxDepth = 4, maxEntries = 10000, ignoreDirs = [], ignoreExtensions = [],
}: ScanOptions): Promise<ProducedScan> {
  const root = path.resolve(dir)
  const result: ProducedScan = { files: [], skipped: 0, incomplete: false }
  const ignoredDirs = new Set([...DEFAULT_IGNORE_DIRS, ...ignoreDirs])
  const ignoredExt = new Set([...DEFAULT_IGNORE_EXT, ...ignoreExtensions])
  const found: ProducedFile[] = []
  let visited = 0
  const count = Number.isFinite(maxFiles) ? Math.max(0, Math.floor(maxFiles)) : 5
  const budget = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : 10000
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > maxDepth) { result.incomplete = true; return }
    try {
      const directory = await fs.opendir(current)
      for await (const entry of directory) {
        if (visited++ >= budget) { result.incomplete = true; break }
        if (entry.name.startsWith('.')) continue
        const full = path.join(current, entry.name)
        if (entry.isSymbolicLink()) { result.skipped++; continue }
        if (entry.isDirectory()) {
          if (!ignoredDirs.has(entry.name)) await walk(full, depth + 1)
          if (visited >= budget && result.incomplete) break
          continue
        }
        if (!entry.isFile() || ignoredExt.has(path.extname(entry.name).toLowerCase())) continue
        const stat = await fs.lstat(full)
        if (!stat.isFile() || stat.mtimeMs < sinceMs - 1000) continue
        if (stat.size === 0 || stat.size > maxBytes) { result.skipped++; continue }
        found.push({ path: full, name: entry.name, bytes: stat.size, mtimeMs: stat.mtimeMs })
      }
    } catch { result.incomplete = true }
  }
  try {
    if (!(await fs.lstat(root)).isDirectory()) return { ...result, incomplete: true }
  } catch { return { ...result, incomplete: true } }
  await walk(root, 0)
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
  result.files = found.slice(0, count)
  result.skipped += found.length - result.files.length
  return result
}

/** Compatibility list for callers that only need the selected paths. */
export async function listProducedFiles(options: ScanOptions): Promise<ProducedFile[]> {
  return (await scanProducedFiles(options)).files
}
