import { type SyncComponent, type SyncSet } from './instruction-sets-cli.js'

export interface RunnerInstructionSet {
  name: string
  modelConfig: Record<string, unknown>
  shape: string[]
  profileVersionId: string
  modelConfigSettingsVersionId?: string
  versionNumber: number
  promptComponentKey?: string
  components: Record<string, string>
  pinnedComponents?: Record<string, { repoPath: string; contentSha: string; commitSha: string }>
}

export function runnerInstructionSetSyncSet(instructionSet: RunnerInstructionSet): SyncSet {
  const modelConfigIdentity = typeof instructionSet.modelConfig.identity === 'string'
    ? instructionSet.modelConfig.identity
    : ''
  if (!modelConfigIdentity) throw new Error('Runner exec context instruction set has no model config identity')
  const missingKey = instructionSet.shape.find(key => !(key in instructionSet.components) && !(key in (instructionSet.pinnedComponents || {})))
  if (missingKey) throw new Error('instruction_set_tuple_incomplete')
  const components: Record<string, SyncComponent> = Object.fromEntries(Object.entries(instructionSet.components).map(([key, body]) => [key, { body }]))
  for (const [key, pin] of Object.entries(instructionSet.pinnedComponents || {})) components[key] = pin
  const material = {
    profileVersionId: instructionSet.profileVersionId,
    versionNumber: instructionSet.versionNumber,
    modelConfigIdentity,
    // syncToDisk's long-lived manifest requires provenance; this execution
    // path has no resolver decision to expose, only an exact profile version.
    resolvedFrom: 'exact_profile_version',
    components,
  }
  return {
    name: instructionSet.name,
    shape: instructionSet.shape,
    default: material,
    profiles: [{ modelConfigIdentity, resolvedFrom: 'exact_profile_version', production: material }],
  }
}

export function runnerInputPrompt(
  promptContext: { body?: string | null; bodyKind: string; providerSettings: Record<string, unknown> }
): Record<string, unknown> {
  const prompt = {
    body_kind: promptContext.bodyKind,
    provider_settings: promptContext.providerSettings,
  } as Record<string, unknown>
  // The route owns this decision. Preserve its response shape exactly so an
  // implicit wrapped prompt remains compatible with existing runners.
  if ('body' in promptContext) prompt.body = promptContext.body
  return prompt
}

export function runnerInputInstructionSet(instructionSet: RunnerInstructionSet): Record<string, unknown> {
  return {
    name: instructionSet.name,
    model_config: instructionSet.modelConfig,
    shape: instructionSet.shape,
    ...(instructionSet.modelConfigSettingsVersionId ? { model_config_settings_version_id: instructionSet.modelConfigSettingsVersionId } : {}),
    ...(instructionSet.promptComponentKey ? { prompt_component_key: instructionSet.promptComponentKey } : {}),
    components: instructionSet.components,
    ...(Object.keys(instructionSet.pinnedComponents || {}).length > 0 ? { pinned_components: instructionSet.pinnedComponents } : {}),
  }
}
