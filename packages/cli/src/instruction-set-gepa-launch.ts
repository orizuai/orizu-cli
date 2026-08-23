import { authedFetch } from './http.js'
import { parseJsonResponse } from './json-response.js'

interface InstructionSetResolution {
  instructionSet?: {
    default?: { profileVersionId?: string } | null
    profiles?: Array<{
      modelConfigIdentity?: string | null
      production?: { profileVersionId?: string } | null
    }>
  }
}

/** Resolve the same production-or-default tuple served for a model identity. */
export async function resolveGepaInstructionSetProfileVersion(
  instructionSetName: string,
  modelConfigIdentity: string,
  project: string,
): Promise<string> {
  const response = await authedFetch(`/api/cli/instruction-sets/${encodeURIComponent(instructionSetName)}?project=${encodeURIComponent(project)}`)
  if (!response.ok) throw new Error(`Instruction set resolution failed: ${await response.text()}`)
  const payload = await parseJsonResponse<InstructionSetResolution>(response, 'Instruction set resolution')
  const instructionSet = payload.instructionSet
  const profile = instructionSet?.profiles?.find(candidate => candidate.modelConfigIdentity === modelConfigIdentity)
  const profileVersionId = profile?.production?.profileVersionId || instructionSet?.default?.profileVersionId
  if (!profileVersionId) throw new Error('instruction_set_profile_version_unresolvable')
  return profileVersionId
}
