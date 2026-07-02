#!/usr/bin/env node
// Builds the plugin: bundles src/code.ts → dist/code.js (esbuild) and copies
// the self-contained src/ui.html → dist/ui.html. manifest.json points at both
// dist files. esbuild does not process HTML, so the UI is a plain static file
// that is copied verbatim.
//
//   node scripts/build.mjs           one-off build
//   node scripts/build.mjs --watch   rebuild code.js on change (re-run to refresh ui.html)

import * as esbuild from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const watch = process.argv.includes('--watch')

const dist = resolve(root, 'dist')
await mkdir(dist, { recursive: true })

const copyUi = () =>
  copyFile(resolve(root, 'src/ui.html'), resolve(dist, 'ui.html'))

const options = {
  entryPoints: [resolve(root, 'src/code.ts')],
  bundle: true,
  target: 'es2017',
  platform: 'browser',
  format: 'iife',
  outfile: resolve(dist, 'code.js'),
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
  await copyUi()
  console.log(
    'Watching src/code.ts → dist/code.js. ui.html copied once; re-run build after editing ui.html.',
  )
} else {
  await esbuild.build(options)
  await copyUi()
  console.log('Built dist/code.js and dist/ui.html.')
}
