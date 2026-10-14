// Materialize the shared orizu skill into each plugin package.
//
// Output is deterministic: same skill source + CLI version => identical
// bundles (no timestamps), so committed plugin skill content can be verified
// in CI via scripts/plugins/validate.mjs.
import { buildPlugins, runPluginScript } from './plugin-workflow.mjs'

await runPluginScript(buildPlugins)
