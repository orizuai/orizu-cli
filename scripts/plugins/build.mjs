// Materialize the shared orizu-cli skill into each plugin package.
//
// Output is deterministic: same skill source + CLI version => identical
// bundles (no timestamps), so committed plugin skill content can be verified
// in CI via scripts/plugins/validate.mjs.
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  assertSkillSourceExists,
  computeSkillContentHash,
  copySkillTree,
  getCliVersion,
  PLUGIN_PACKAGES,
  readJson,
  SKILL_META_FILENAME,
  SKILL_NAME,
  SKILL_SOURCE_DIR,
} from './lib.mjs'

assertSkillSourceExists()

const skillHash = computeSkillContentHash(SKILL_SOURCE_DIR)
const cliVersion = getCliVersion()

for (const plugin of PLUGIN_PACKAGES) {
  const manifest = readJson(plugin.manifest)
  const targetSkillDir = join(plugin.root, 'skills', SKILL_NAME)

  rmSync(targetSkillDir, { recursive: true, force: true })
  mkdirSync(join(plugin.root, 'skills'), { recursive: true })
  copySkillTree(SKILL_SOURCE_DIR, targetSkillDir)

  const meta = {
    name: SKILL_NAME,
    skillHash,
    cliVersion,
    pluginVersion: manifest.version ?? null,
    source: 'plugin-bundle',
    sourceRoot: 'skills/orizu-cli',
  }
  writeFileSync(
    join(targetSkillDir, SKILL_META_FILENAME),
    `${JSON.stringify(meta, null, 2)}\n`,
    'utf8'
  )

  console.log(`built ${plugin.id}: skills/${SKILL_NAME} (${skillHash.slice(0, 19)}…, cli ${cliVersion})`)
}
