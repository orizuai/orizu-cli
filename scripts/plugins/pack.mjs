// Stage validated plugin packages into dist/plugins/ as release artifacts.
// Run plugins:build and plugins:validate first (pack re-validates via import).
import { execFileSync } from 'child_process'
import { cpSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'

import { PLUGIN_PACKAGES, PLUGINS_DIST_DIR, readJson } from './lib.mjs'

rmSync(PLUGINS_DIST_DIR, { recursive: true, force: true })
mkdirSync(PLUGINS_DIST_DIR, { recursive: true })

for (const plugin of PLUGIN_PACKAGES) {
  const manifest = readJson(plugin.manifest)
  const stageDir = join(PLUGINS_DIST_DIR, plugin.id)
  cpSync(plugin.root, stageDir, { recursive: true })

  const tarName = `orizu-${plugin.id}-plugin-${manifest.version}.tgz`
  execFileSync('tar', ['-czf', join(PLUGINS_DIST_DIR, tarName), '-C', PLUGINS_DIST_DIR, plugin.id])
  console.log(`packed ${plugin.id} -> dist/plugins/${tarName}`)
}
