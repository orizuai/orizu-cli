// Stage validated plugin packages into dist/plugins/ as release artifacts.
// Run plugins:build first; pack refuses packages that plugins:validate rejects.
import { packPlugins, runPluginScript } from './plugin-workflow.mjs'

await runPluginScript(packPlugins)
