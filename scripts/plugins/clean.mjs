// Remove generated plugin artifacts: staged dist output. The vendored skill
// trees inside plugins/*/skills are committed source (regenerate with
// plugins:build); pass --skills to remove them too.
import { rmSync } from 'fs'
import { join } from 'path'

import { PLUGIN_PACKAGES, PLUGINS_DIST_DIR, SKILL_NAME } from './lib.mjs'

rmSync(PLUGINS_DIST_DIR, { recursive: true, force: true })
console.log('removed dist/plugins')

if (process.argv.includes('--skills')) {
  for (const plugin of PLUGIN_PACKAGES) {
    rmSync(join(plugin.root, 'skills', SKILL_NAME), { recursive: true, force: true })
    console.log(`removed ${plugin.id}/skills/${SKILL_NAME}`)
  }
}
