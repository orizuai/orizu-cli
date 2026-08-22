import { existsSync, realpathSync, readFileSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export class InstructionSetLoaderError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'InstructionSetLoaderError' }
}

interface Material { files: Record<string, string>; pinnedComponents?: Record<string, unknown> }
interface Manifest { manifestVersion: number; name: string; shape: string[]; default: Material; profiles: Array<{ modelConfigIdentity: string; production: Material | null }>; filteredTo?: string[] }

function inside(root: string, candidate: string) { return candidate === root || candidate.startsWith(`${root}${sep}`) }

export function loadInstructionSet(directory: string, name: string, modelConfigIdentity: string): Record<string, string> {
  const unresolvedRoot = resolve(directory, name)
  if (!existsSync(unresolvedRoot) || !statSync(unresolvedRoot).isDirectory()) throw new InstructionSetLoaderError('instruction_set_not_synced')
  const setRoot = realpathSync(unresolvedRoot)
  const manifestPath = resolve(setRoot, 'manifest.json')
  if (!existsSync(manifestPath)) throw new InstructionSetLoaderError('instruction_set_manifest_missing')
  let manifest: Manifest
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest } catch { throw new InstructionSetLoaderError('instruction_set_manifest_missing') }
  if (manifest.manifestVersion !== 1) throw new InstructionSetLoaderError('instruction_set_manifest_version_unsupported')
  if (manifest.filteredTo && !manifest.filteredTo.includes(modelConfigIdentity)) throw new InstructionSetLoaderError('instruction_set_profile_not_synced')
  const selected = manifest.profiles.find(profile => profile.modelConfigIdentity === modelConfigIdentity)?.production || manifest.default
  const result: Record<string, string> = {}
  for (const key of manifest.shape) {
    if (selected.pinnedComponents?.[key]) throw new InstructionSetLoaderError('instruction_set_component_unavailable')
    const relativePath = selected.files?.[key]
    if (!relativePath) throw new InstructionSetLoaderError('instruction_set_profile_key_missing')
    const unresolvedPath = resolve(setRoot, relativePath)
    if (!inside(setRoot, unresolvedPath)) throw new InstructionSetLoaderError('instruction_set_path_unsafe')
    let path: string
    try { path = realpathSync(unresolvedPath) } catch { throw new InstructionSetLoaderError('instruction_set_component_unreadable') }
    if (!inside(setRoot, path)) throw new InstructionSetLoaderError('instruction_set_path_unsafe')
    try { result[key] = readFileSync(path, 'utf8') } catch { throw new InstructionSetLoaderError('instruction_set_component_unreadable') }
  }
  return result
}
