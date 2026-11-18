import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/** Every `.ts` file under the core source, without following dependencies. */
function sourceFiles(directory: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

test('host access is confined to host.ts', () => {
  const root = path.resolve('packages/core/src')
  const offenders: string[] = []
  for (const file of sourceFiles(root)) {
    const relative = path.relative(root, file).replaceAll(path.sep, '/')
    if (relative === 'host.ts') continue
    const code = fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      .join('\n')
    if (/\b(?:options\.)?ctx\.(?:get|on)\b/.test(code)) offenders.push(relative)
  }
  assert.deepEqual(offenders, [], 'services and events must be reached through createHostPort()')
})
