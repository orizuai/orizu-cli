// Validate plugin packages: manifests parse, required fields and paths exist,
// and committed plugin skill bundles match the shared skill source so stale
// bundles fail before release. Run after editing skills/orizu or plugins/.
import { PLUGIN_PACKAGES } from './lib.mjs'
import { findPluginProblems } from './problems.mjs'

const { problems, sourceHash, cliVersion } = findPluginProblems()

if (problems.length > 0) {
  for (const message of problems) {
    console.error(`error: ${message}`)
  }
  process.exit(1)
}

console.log(`plugins valid: ${PLUGIN_PACKAGES.map(plugin => plugin.id).join(', ')} (skill ${sourceHash.slice(0, 19)}…, cli ${cliVersion})`)
