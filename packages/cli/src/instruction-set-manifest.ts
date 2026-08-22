import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

export interface InstructionSetComponent { key: string; modelConfig?: string; text: string }
export interface InstructionSetManifest { name: string; shape: string[]; components: InstructionSetComponent[] }

// Keep file-backed component reads within the same text budget used by prompt
// tooling; request assembly never asks Node to allocate an unbounded body.
export const MAX_INSTRUCTION_SET_COMPONENT_BYTES = 512 * 1024

const fail = (code: string): never => { throw new Error(code) }

export function loadInstructionSetManifest(path: string): InstructionSetManifest {
  let value: unknown
  let source: string
  try { source = readFileSync(path, 'utf8') } catch { return fail('instruction_set_path_not_found') }
  try { value = JSON.parse(source) } catch { return fail('instruction_set_manifest_invalid_json') }
  if (!value || typeof value !== 'object') return fail('instruction_set_manifest_invalid')
  const input = value as Record<string, unknown>
  if (typeof input.name !== 'string' || input.name.trim() === '') return fail('instruction_set_manifest_invalid_name')
  if (!Array.isArray(input.shape) || input.shape.length === 0 || input.shape.some(key => typeof key !== 'string' || key === '') || new Set(input.shape).size !== input.shape.length) return fail('instruction_set_manifest_invalid_shape')
  if (!Array.isArray(input.components)) return fail('instruction_set_manifest_invalid_components')
  let root: string
  try { root = realpathSync(dirname(path)) } catch { return fail('instruction_set_path_not_found') }
  const seen = new Set<string>(); const components: InstructionSetComponent[] = []
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
    components.push({ key: component.key, ...(modelConfig === undefined ? {} : { modelConfig }), text })
  }
  for (const key of input.shape) if (!components.some(component => component.key === key)) return fail('instruction_set_missing_shape_key')
  return { name: input.name, shape: input.shape as string[], components }
}
