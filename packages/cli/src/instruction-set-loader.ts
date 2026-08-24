import { existsSync, realpathSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export class InstructionSetLoaderError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'InstructionSetLoaderError' }
}

interface Material { files: Record<string, string>; pinnedComponents?: Record<string, unknown> }
interface Manifest { manifestVersion: number; projectId?: string; instructionSetId?: string; name: string; slug?: string; shape: string[]; default: Material; profiles: Array<{ modelConfigIdentity: string; production: Material | null }>; filteredTo?: string[] }

function inside(root: string, candidate: string) { return candidate === root || candidate.startsWith(`${root}${sep}`) }

function manifestMatchesReference(candidate: string, reference: string): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(candidate, 'manifest.json'), 'utf8')
    ) as Pick<Manifest, 'name' | 'slug'>
    return manifest.name === reference || manifest.slug === reference
  } catch {
    return false
  }
}

function resolveSetRoot(directory: string, reference: string): string {
  let directoryRoot: string
  try { directoryRoot = realpathSync(directory) } catch { throw new InstructionSetLoaderError('instruction_set_not_synced') }
  const direct = resolve(directoryRoot, reference)
  try {
    if (inside(directoryRoot, direct) && existsSync(direct) && statSync(direct).isDirectory()) {
      const realDirect = realpathSync(direct)
      if (inside(directoryRoot, realDirect)) {
        try {
          const manifest = JSON.parse(
            readFileSync(resolve(realDirect, 'manifest.json'), 'utf8')
          ) as Pick<Manifest, 'name' | 'slug'>
          if (manifest.name === reference || manifest.slug === reference) {
            return realDirect
          }
        } catch {
          // Preserve the exact-path loader's specific missing/invalid manifest error.
          return realDirect
        }
      }
    }
  } catch {
    // A stale or unreadable direct-path candidate must not shadow a valid set.
  }
  const matches = readdirSync(directoryRoot, { withFileTypes: true }).flatMap(entry => {
    try {
      if (entry.name.startsWith('.') || !entry.isDirectory()) return []
      const candidate = realpathSync(resolve(directoryRoot, entry.name))
      return inside(directoryRoot, candidate) && manifestMatchesReference(candidate, reference)
        ? [candidate]
        : []
    } catch {
      return []
    }
  })
  if (matches.length !== 1) throw new InstructionSetLoaderError(
    matches.length > 1 ? 'instruction_set_reference_ambiguous' : 'instruction_set_not_synced'
  )
  return matches[0]!
}

export function loadInstructionSet(directory: string, name: string, modelConfigIdentity: string): Record<string, string> {
  const setRoot = resolveSetRoot(directory, name)
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
