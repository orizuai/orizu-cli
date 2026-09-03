import { authedFetch } from './http.js'
import { parseJsonResponse } from './json-response.js'

interface InstructionSetResolution {
  instructionSet?: {
    profiles?: Array<{
      modelConfigIdentity?: string | null
      production?: { profileVersionId?: string } | null
    }>
  }
}

/** Resolve the requested Profile's Production tuple for optimization. */
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
  if (!profile) throw new Error(`instruction_set_profile_not_found: ${modelConfigIdentity}`)
  const profileVersionId = profile.production?.profileVersionId
  if (!profileVersionId) throw new Error(`instruction_set_profile_not_promoted: ${modelConfigIdentity}`)
  return profileVersionId
}
