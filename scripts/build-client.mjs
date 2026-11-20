#!/usr/bin/env node
/**
 * Bundle packages/core/client-src into the single client.js the host loads.
 *
 * React stays external: the loader calls the factory with a `require` that
 * resolves the host's React, and createClient only invokes it at that point.
 */
import { build } from 'esbuild'

await build({
  entryPoints: ['packages/core/client-src/index.js'],
  outfile: 'packages/core/client.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  external: ['react'],
  legalComments: 'none',
  banner: { js: '/* generated from packages/core/client-src — run: npm run build:client */' },
  logLevel: 'warning',
})
console.log('client.js bundled')
