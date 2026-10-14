// Plugin package checks shared by plugins:validate and plugins:pack. Plain
// Node with no dependencies, so `node scripts/plugins/validate.mjs` runs in
// any checkout, the public mirror included.
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'

import {
  assertSkillSourceExists,
  computeSkillContentHash,
  getCliVersion,
  PLUGIN_PACKAGES,
  readJson,
  REPO_ROOT,
  SKILL_META_FILENAME,
  SKILL_NAME,
  SKILL_SOURCE_DIR,
  STAGING_PREFIX,
} from './lib.mjs'

/** Every problem with the plugin packages; empty when they are valid. */
export function findPluginProblems() {
  const problems = []
  const problem = message => problems.push(message)
  assertSkillSourceExists()
  const sourceHash = computeSkillContentHash(SKILL_SOURCE_DIR)
  const cliVersion = getCliVersion()

  for (const plugin of PLUGIN_PACKAGES) {
    const label = plugin.id

    // A build killed outright leaves its staging folder; it must never ship or be committed.
    const skillsDir = join(plugin.root, 'skills')
    if (existsSync(skillsDir)) {
      for (const name of readdirSync(skillsDir)) {
        if (name.startsWith(STAGING_PREFIX)) problem(`${label}: leftover staging folder skills/${name} (run plugins:build)`)
      }
    }

    if (!existsSync(plugin.manifest)) {
      problem(`${label}: missing manifest ${plugin.manifest}`)
      continue
    }

    let manifest
    try {
      manifest = readJson(plugin.manifest)
    } catch (error) {
      problem(`${label}: manifest is not valid JSON (${error?.message || error})`)
      continue
    }

    for (const field of ['name', 'version', 'description']) {
      if (typeof manifest[field] !== 'string' || manifest[field].length === 0) {
        problem(`${label}: manifest is missing required field '${field}'`)
      }
    }

    const manifestInterface = manifest.interface || {}
    const assetPaths = [
      ['interface.composerIcon', manifestInterface.composerIcon],
      ['interface.logo', manifestInterface.logo],
      ...(Array.isArray(manifestInterface.screenshots)
        ? manifestInterface.screenshots.map((shot, index) => [`interface.screenshots[${index}]`, shot])
        : []),
    ]
    for (const [assetField, assetPath] of assetPaths) {
      if (typeof assetPath === 'string' && !existsSync(join(plugin.root, assetPath))) {
        problem(`${label}: manifest ${assetField} '${assetPath}' does not exist`)
      }
    }

    const bundledSkill = join(plugin.root, 'skills', SKILL_NAME)
    if (!existsSync(join(bundledSkill, 'SKILL.md'))) {
      problem(`${label}: bundled skill missing at skills/${SKILL_NAME} (run plugins:build)`)
      continue
    }

    const bundledHash = computeSkillContentHash(bundledSkill)
    if (bundledHash !== sourceHash) {
      problem(`${label}: bundled skill content drifted from skills/${SKILL_NAME} (run plugins:build and commit the result)`)
    }

    const metaPath = join(bundledSkill, SKILL_META_FILENAME)
    if (!existsSync(metaPath)) {
      problem(`${label}: bundled skill is missing ${SKILL_META_FILENAME} (run plugins:build)`)
    } else {
      let meta
      try {
        meta = readJson(metaPath)
      } catch (error) {
        problem(`${label}: ${SKILL_META_FILENAME} is not valid JSON (${error?.message || error}) (run plugins:build)`)
        continue
      }
      if (meta.skillHash !== sourceHash) {
        problem(`${label}: ${SKILL_META_FILENAME} skillHash is stale (run plugins:build)`)
      }
      if (meta.cliVersion !== cliVersion) {
        problem(`${label}: ${SKILL_META_FILENAME} cliVersion '${meta.cliVersion}' does not match packages/cli '${cliVersion}' (run plugins:build)`)
      }
      if (meta.pluginVersion !== (manifest.version ?? null)) {
        problem(`${label}: ${SKILL_META_FILENAME} pluginVersion is stale (run plugins:build)`)
      }
    }
  }

  const claudeMarketplace = join(REPO_ROOT, '.claude-plugin', 'marketplace.json')
  if (existsSync(claudeMarketplace)) {
    try {
      const marketplace = readJson(claudeMarketplace)
      const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : []
      if (typeof marketplace.name !== 'string' || marketplace.name.length === 0) {
        problem(`marketplace: ${claudeMarketplace} is missing 'name'`)
      }
      if (plugins.length === 0) {
        problem(`marketplace: ${claudeMarketplace} lists no plugins`)
      }
      for (const entry of plugins) {
        if (typeof entry.source === 'string' && !existsSync(join(REPO_ROOT, entry.source))) {
          problem(`marketplace: plugin source '${entry.source}' does not exist`)
        }
      }
    } catch (error) {
      problem(`marketplace: ${claudeMarketplace} is not valid JSON (${error?.message || error})`)
    }
  }

  return { problems, sourceHash, cliVersion }
}
