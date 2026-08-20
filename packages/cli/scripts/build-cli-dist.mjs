import { existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isOrizuSourceCheckout } from './orizu-source-checkout.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const cliRoot = resolve(scriptDir, '..')
const repoRoot = resolve(cliRoot, '..', '..')
const packedEntrypoint = resolve(cliRoot, 'dist', 'index.js')

// A source checkout has the compiler and must always rebuild before packing so
// ignored dist cannot carry an old CLI. A published tarball has no dev compiler;
// it may be repacked only when it already carries the built entrypoint.
if (!isOrizuSourceCheckout(resolve(repoRoot, 'package.json'))) {
  if (!existsSync(packedEntrypoint)) {
    throw new Error('Unable to pack CLI: published package is missing dist/index.js')
  }
  process.exit(0)
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
// Delete old compiler output first: npm pack must never retain a module whose
// TypeScript source was renamed or removed since the previous build.
rmSync(resolve(cliRoot, 'dist'), { recursive: true, force: true })
const result = spawnSync(npm, ['run', 'build'], { cwd: cliRoot, stdio: 'inherit' })
if (result.status !== 0) {
  throw new Error(`Unable to build CLI dist before packing: ${result.error?.message || 'npm run build failed'}`)
}
