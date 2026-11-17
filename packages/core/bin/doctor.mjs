#!/usr/bin/env node
/**
 * `npm run doctor` — the state inventory, from the same table the plugin uses.
 *
 * Read-only and dependency-free: it reads the built core (`dist/`), prints one
 * summary line, and with `--state` the whole table grouped by migration intent.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(here, '..', 'dist', 'src', 'store')
if (!fs.existsSync(path.join(dist, 'inventory.js'))) {
  console.error('the core is not built: run `npm run build` first, then `npm run doctor`')
  process.exit(2)
}
const { stateInventory, summarizeInventory, formatBytes } = await import(path.join(dist, 'inventory.js'))
const { stateRoot } = await import(path.join(dist, 'root.js'))

const root = stateRoot()
const inventory = stateInventory(root)
const wantsTable = process.argv.includes('--state')
const icon = { domain: '域', planned: '计划', file: '文件' }

process.stdout.write(`state: ${root}\n`)
process.stdout.write(`${summarizeInventory(inventory)}\n`)
if (inventory.unlisted.length > 0) {
  process.stdout.write(`\n表外（不在 state-layout 里）：\n`)
  for (const row of inventory.unlisted) {
    process.stdout.write(`  ${row.relative.padEnd(40)} ${formatBytes(row.bytes)}\n`)
  }
}
if (wantsTable) {
  for (const store of ['domain', 'planned', 'file']) {
    const rows = inventory.entries.filter((entry) => entry.store === store)
    if (rows.length === 0) continue
    process.stdout.write(`\n  ${icon[store]} · ${rows.length}\n`)
    for (const row of rows) {
      const size = row.exists === true ? formatBytes(row.bytes) : '—'
      const count = row.kind === 'dir' && row.files > 0 ? ` / ${row.files} 文件` : ''
      process.stdout.write(`    ${row.relative.padEnd(46)} ${(size + count).padEnd(16)} ${row.reason ?? ''}\n`)
    }
  }
}
const problems = inventory.unlisted.length
process.exitCode = problems > 0 ? 1 : 0
