#!/usr/bin/env node
/**
 * `npm run doctor` — the state inventory, from the same table the plugin uses.
 *
 * Read-only by default; --migrate runs the same one-time migration as startup.
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
const { stateFile, stateDocumentValid } = await import(path.join(dist, 'state.js'))

const root = stateRoot()
let stateProblem = false
if (process.argv.includes('--migrate')) {
  try {
    stateFile(root, (line) => console.error(line)).read('inbox')
    process.stdout.write('migration: canonical state v2 ready; legacy inputs archived\n')
  } catch (error) { console.error(`migration failed: ${error.message}`); stateProblem = true }
}
const canonical = path.join(root, 'state.json')
if (fs.existsSync(canonical)) {
  try {
    const saved = JSON.parse(fs.readFileSync(canonical, 'utf8'))
    if (!stateDocumentValid(saved)) throw new Error('invalid version, envelope or state section')
    process.stdout.write(`canonical state: v${saved.version}, ${Object.keys(saved.sections).length} sections\n`)
  } catch (error) { console.error(`canonical state invalid: ${error.message}`); stateProblem = true }
} else process.stdout.write('canonical state absent; use --migrate to import legacy state\n')
const inventory = stateInventory(root)
const wantsTable = process.argv.includes('--state')
const icon = { domain: '域', file: '文件' }

process.stdout.write(`state: ${root}\n`)
process.stdout.write(`${summarizeInventory(inventory)}\n`)
if (inventory.unlisted.length > 0) {
  process.stdout.write(`\n表外（不在 state-layout 里）：\n`)
  for (const row of inventory.unlisted) {
    process.stdout.write(`  ${row.relative.padEnd(40)} ${formatBytes(row.bytes)}\n`)
  }
}
if (wantsTable) {
  for (const store of ['domain', 'file']) {
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
process.exitCode = problems > 0 || stateProblem ? 1 : 0
