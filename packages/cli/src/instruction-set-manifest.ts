import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'

export interface InstructionSetComponent { key: string; modelConfig?: string; text: string }
export interface InstructionSetManifest { name: string; description?: string | null; shape: string[]; components: InstructionSetComponent[] }

// Keep file-backed component reads within the same text budget used by prompt
// tooling; request assembly never asks Node to allocate an unbounded body.
export const MAX_INSTRUCTION_SET_COMPONENT_BYTES = 512 * 1024

const fail = (code: string): never => { throw new Error(code) }
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

function hasPinnedComponents(material: unknown): boolean {
  if (!material || typeof material !== 'object') return false
  const pinned = (material as Record<string, unknown>).pinnedComponents
  return Boolean(pinned && typeof pinned === 'object' && Object.keys(pinned).length > 0)
}

export function loadInstructionSetManifest(path: string): InstructionSetManifest {
  let value: unknown
  let source: string
  try { source = readFileSync(path, 'utf8') } catch { return fail('instruction_set_path_not_found') }
  try { value = JSON.parse(source) } catch { return fail('instruction_set_manifest_invalid_json') }
  if (!value || typeof value !== 'object') return fail('instruction_set_manifest_invalid')
  const input = value as Record<string, unknown>
  if (typeof input.name !== 'string' || input.name.trim() === '') return fail('instruction_set_manifest_invalid_name')
  const hasDescription = Object.hasOwn(input, 'description')
  if (hasDescription && input.description !== null && typeof input.description !== 'string') return fail('instruction_set_manifest_invalid_description')
  const description = hasDescription
    ? input.description === '' ? null : input.description as string | null
    : undefined
  if (hasPinnedComponents(input.default)) return fail('instruction_set_component_unavailable')
  if (!Array.isArray(input.shape) || input.shape.length === 0 || input.shape.some(key => typeof key !== 'string' || key === '') || new Set(input.shape).size !== input.shape.length) return fail('instruction_set_manifest_invalid_shape')
  if (!Array.isArray(input.components)) return fail('instruction_set_manifest_invalid_components')
  let root: string
  try { root = realpathSync(dirname(path)) } catch { return fail('instruction_set_path_not_found') }
  const seen = new Set<string>()
  const loadedComponents: Array<InstructionSetComponent & { changedSinceSync: boolean; hasSyncBaseline: boolean }> = []
  for (const raw of input.components) {
    if (!raw || typeof raw !== 'object') return fail('instruction_set_manifest_invalid_component')
    const component = raw as Record<string, unknown>
    if (typeof component.key !== 'string' || component.key === '' || !input.shape.includes(component.key)) return fail(component.key && !input.shape.includes(component.key) ? 'instruction_set_key_outside_shape' : 'instruction_set_manifest_invalid_component')
    const modelConfig = component.modelConfig === undefined ? undefined : component.modelConfig
    if (modelConfig !== undefined && (typeof modelConfig !== 'string' || modelConfig === '')) return fail('instruction_set_manifest_invalid_component')
    const identity = `${component.key}\u0000${modelConfig ?? ''}`; if (seen.has(identity)) return fail('instruction_set_duplicate_component'); seen.add(identity)
    let text: string
    if (typeof component.text === 'string' && component.path === undefined) text = component.text
    else if (typeof component.path === 'string' && component.text === undefined) {
      if (isAbsolute(component.path)) return fail('instruction_set_path_escape')
      const candidate = resolve(root, component.path)
      if (relative(root, candidate).startsWith('..')) return fail('instruction_set_path_escape')
      if (!existsSync(candidate)) return fail('instruction_set_path_not_found')
      let target: string; try { target = realpathSync(candidate) } catch { return fail('instruction_set_path_not_found') }
      if (relative(root, target).startsWith('..')) return fail('instruction_set_path_escape')
      try { text = readFileSync(target, 'utf8') } catch { return fail('instruction_set_path_not_found') }
      if (Buffer.byteLength(text, 'utf8') > MAX_INSTRUCTION_SET_COMPONENT_BYTES) return fail('instruction_set_component_too_large')
    } else return fail('instruction_set_manifest_invalid_component')
    if (Buffer.byteLength(text, 'utf8') > MAX_INSTRUCTION_SET_COMPONENT_BYTES) return fail('instruction_set_component_too_large')
    const hasSyncBaseline = typeof component.syncedContentSha256 === 'string'
    if (component.syncedContentSha256 !== undefined && (!hasSyncBaseline || !/^[a-f0-9]{64}$/u.test(component.syncedContentSha256 as string))) return fail('instruction_set_manifest_invalid_component')
    loadedComponents.push({
      key: component.key,
      ...(modelConfig === undefined ? {} : { modelConfig }),
      text,
      hasSyncBaseline,
      changedSinceSync: hasSyncBaseline && sha256(text) !== component.syncedContentSha256,
    })
  }
  for (const key of input.shape) if (!loadedComponents.some(component => component.key === key)) return fail('instruction_set_missing_shape_key')
  const defaultIdentity = input.default && typeof input.default === 'object'
    && typeof (input.default as Record<string, unknown>).modelConfigIdentity === 'string'
    ? (input.default as Record<string, unknown>).modelConfigIdentity as string
    : null
  let components = loadedComponents
  if (defaultIdentity) {
    if (input.manifestVersion === 1 && (input.shape as string[]).some(key => {
      const bare = loadedComponents.find(component => component.key === key && component.modelConfig === undefined)
      const tagged = loadedComponents.find(component => component.key === key && component.modelConfig === defaultIdentity)
      return bare && tagged && (!bare.hasSyncBaseline || !tagged.hasSyncBaseline)
    })) return fail('instruction_set_sync_baseline_missing')
    const changedDefaultKeys = new Set(loadedComponents.flatMap(component => (
      component.modelConfig === undefined && component.hasSyncBaseline && component.changedSinceSync
        ? [component.key]
        : []
    )))
    const changedSameIdentityKeys = new Set(loadedComponents.flatMap(component => (
      component.modelConfig === defaultIdentity && component.hasSyncBaseline && component.changedSinceSync
        ? [component.key]
        : []
    )))
    if ([...changedDefaultKeys].some(key => changedSameIdentityKeys.has(key))) return fail('instruction_set_conflicting_synced_edits')
    if (changedDefaultKeys.size > 0) {
      components = loadedComponents.filter(component => (
        component.modelConfig !== defaultIdentity || !changedDefaultKeys.has(component.key)
      ))
    }
  }
  const namedProfiles = new Set([
    ...(components.some(component => component.modelConfig === undefined) && defaultIdentity
      ? [defaultIdentity]
      : []),
    ...components.flatMap(component => component.modelConfig ? [component.modelConfig] : []),
  ])
  const namedProfileHasPins = Array.isArray(input.profiles) && input.profiles.some(profile => {
    if (!profile || typeof profile !== 'object') return false
    const value = profile as Record<string, unknown>
    return typeof value.modelConfigIdentity === 'string'
      && namedProfiles.has(value.modelConfigIdentity)
      && hasPinnedComponents(value.production)
  })
  if (namedProfileHasPins) return fail('instruction_set_component_unavailable')
  return {
    name: input.name,
    ...(hasDescription ? { description } : {}),
    shape: input.shape as string[],
    components: components.map(({ key, modelConfig, text }) => ({ key, ...(modelConfig === undefined ? {} : { modelConfig }), text })),
  }
}
