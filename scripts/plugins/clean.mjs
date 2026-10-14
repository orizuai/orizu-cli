// Remove generated plugin artifacts: staged dist output. The vendored skill
// trees inside plugins/*/skills are committed source (regenerate with
// plugins:build); pass --skills to remove them too.
import { cleanPlugins, runPluginScript } from './plugin-workflow.mjs'

await runPluginScript(cleanPlugins(process.argv.includes('--skills')))
