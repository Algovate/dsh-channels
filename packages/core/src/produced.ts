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
 * @module @rodin/dsh-channels/produced
 */
import fs from 'node:fs'
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
  /** Directory names to skip anywhere in the tree. */
  ignoreDirs?: string[]
  /** Extensions never worth sending (intermediate junk). */
  ignoreExtensions?: string[]
}

const DEFAULT_IGNORE_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'dist-test', '.npm-cache'])
const DEFAULT_IGNORE_EXT = new Set(['.tmp', '.lock', '.log', '.part'])

/** Newest-first list of files written since `sinceMs`, within the caps. */
export async function listProducedFiles({
  dir,
  sinceMs,
  maxFiles = 5,
  maxBytes = 20 * 1024 * 1024,
  maxDepth = 4,
  ignoreDirs = [],
  ignoreExtensions = [],
}: ScanOptions): Promise<ProducedFile[]> {
  const root = path.resolve(dir)
  const ignoredDirs = new Set([...DEFAULT_IGNORE_DIRS, ...ignoreDirs])
  const ignoredExt = new Set([...DEFAULT_IGNORE_EXT, ...ignoreExtensions])
  const found: ProducedFile[] = []

  const walk = (current: string, depth: number): void => {
    if (depth > maxDepth || found.length >= maxFiles * 4) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (ignoredExt.has(path.extname(entry.name).toLowerCase())) continue
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(full)
      } catch {
        continue
      }
      // A one-second grace absorbs filesystem timestamp granularity.
      if (stat.mtimeMs < sinceMs - 1000) continue
      if (stat.size === 0 || stat.size > maxBytes) continue
      if (!isInside(root, full)) continue
      found.push({ path: full, name: entry.name, bytes: stat.size, mtimeMs: stat.mtimeMs })
      if (found.length >= maxFiles * 4) return
    }
  }
  walk(root, 0)
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found.slice(0, maxFiles)
}

function isInside(root: string, candidate: string): boolean {
  return path.resolve(candidate).startsWith(root + path.sep)
}
