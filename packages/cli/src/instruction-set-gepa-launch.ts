import { authedFetch } from './http.js'
import { MAX_VERSION_NUMBER, parseSpecifier } from './instruction-set-lock/index.js'
import { parseJsonResponse } from './json-response.js'

interface ProfileVersionSummary {
  profileVersionId?: string
  versionNumber?: number
  componentKeys?: string[]
}

interface InstructionSetResolution {
  instructionSet?: {
    shape?: string[]
    profiles?: Array<{
      modelConfigIdentity?: string | null
      modelConfigArchivedAt?: string | null
      production?: { profileVersionId?: string } | null
      versions?: ProfileVersionSummary[]
    }>
  }
}

interface ShapeDifference {
  missing: string[]
  extra: string[]
}

/**
 * A version runs and promotes only when its component keys equal the set's
 * current shape exactly: promotion refuses any other key set
 * (instruction_set_candidate_shape_mismatch). Returns null when they match.
 */
function shapeDifference(shape: string[], version: ProfileVersionSummary): ShapeDifference | null {
  const keys = new Set(version.componentKeys ?? [])
  const shapeKeys = new Set(shape)
  const missing = shape.filter(key => !keys.has(key))
  const extra = [...keys].filter(key => !shapeKeys.has(key)).sort()
  return missing.length === 0 && extra.length === 0 ? null : { missing, extra }
}

function describeDifference({ missing, extra }: ShapeDifference): string {
  const quote = (keys: string[]) => keys.map(key => `"${key}"`).join(', ')
  return [
    ...(missing.length > 0 ? [`missing ${quote(missing)}`] : []),
    ...(extra.length > 0 ? [`extra ${quote(extra)}`] : []),
  ].join('; ')
}

function newestMatchingVersion(shape: string[], versions: ProfileVersionSummary[]): number | null {
  return versions
    .filter(candidate => Array.isArray(candidate.componentKeys) && shapeDifference(shape, candidate) === null)
    .reduce<number | null>((max, candidate) => {
      const number = candidate.versionNumber ?? 0
      return max === null || number > max ? number : max
    }, null)
}

/**
 * ORI-2128: a version made before a shape change can lack a component of the
 * set's current shape, or carry one the set has since removed. The runner or
 * promotion would refuse it later; refuse it here, before a run is spawned or
 * queued. A server that predates per-version component keys sends none; the
 * runner remains the backstop.
 */
function requireMatchingSeed(
  shape: string[] | undefined,
  versions: ProfileVersionSummary[],
  version: ProfileVersionSummary,
  modelConfigIdentity: string,
  role: 'named' | 'production',
): void {
  if (!Array.isArray(shape) || !Array.isArray(version.componentKeys)) return
  const difference = shapeDifference(shape, version)
  if (difference === null) return
  const newest = newestMatchingVersion(shape, versions)
  const detail = describeDifference(difference)
  if (role === 'production') {
    const newestNote = newest === null ? 'no version of this profile matches it yet' : `newest matching: v${newest}`
    throw new Error(`instruction_set_profile_production_incomplete: ${modelConfigIdentity} production v${version.versionNumber} does not match the current shape (${detail}); promote a version that matches it, or name one with @vN (${newestNote})`)
  }
  const advice = newest === null
    ? 'no version of this profile matches the current shape yet'
    : `pick v${newest}`
  throw new Error(`instruction_set_profile_version_incomplete: ${modelConfigIdentity} v${version.versionNumber} does not match the current shape (${detail}); ${advice}`)
}

/** The Seed a run-gepa launch names: set reference, profile, and optional version. */
export interface GepaSeedSelector {
  instructionSetName: string
  modelConfigIdentity?: string
  versionNumber?: number
}

function profileVersionNumber(value: string): number {
  const match = /^v?([1-9][0-9]*)$/u.exec(value)
  const versionNumber = match ? Number(match[1]) : Number.NaN
  if (!Number.isSafeInteger(versionNumber) || versionNumber > MAX_VERSION_NUMBER) {
    throw new Error(`--profile-version must be a version number such as 3 or v3; received ${value}`)
  }
  return versionNumber
}

/**
 * Combine `--instruction-set`, `--model-config` and `--profile-version` into
 * one Seed. A value with `/` or `@` is a specifier (`set/profile@vN`); any
 * other value is a set slug or exact name, passed through unchanged. Values
 * named twice must agree, the same rule `sync` applies to `--version`.
 */
export function gepaSeedSelector(
  instructionSetArg: string,
  modelConfigFlag: string | undefined,
  versionFlag: string | undefined,
): GepaSeedSelector {
  const flagVersion = versionFlag === undefined ? undefined : profileVersionNumber(versionFlag)
  if (!instructionSetArg.includes('/') && !instructionSetArg.includes('@')) {
    return { instructionSetName: instructionSetArg, modelConfigIdentity: modelConfigFlag, versionNumber: flagVersion }
  }
  const parsed = parseSpecifier(instructionSetArg)
  if (parsed.profile !== undefined && modelConfigFlag !== undefined && parsed.profile !== modelConfigFlag) {
    throw new Error(`instruction_set_seed_conflict: specifier names profile ${parsed.profile} but --model-config is ${modelConfigFlag}`)
  }
  if (parsed.versionNumber !== undefined && flagVersion !== undefined && parsed.versionNumber !== flagVersion) {
    throw new Error(`instruction_set_seed_conflict: specifier names v${parsed.versionNumber} but --profile-version is v${flagVersion}`)
  }
  return {
    instructionSetName: parsed.set,
    modelConfigIdentity: parsed.profile ?? modelConfigFlag,
    versionNumber: parsed.versionNumber ?? flagVersion,
  }
}

/**
 * Resolve the Seed's profile version id: the named version when one is
 * given, otherwise the requested Profile's Production.
 */
async function resolveGepaInstructionSetProfileVersion(
  instructionSetName: string,
  modelConfigIdentity: string,
  project: string,
  versionNumber?: number,
): Promise<string> {
  const response = await authedFetch(`/api/cli/instruction-sets/${encodeURIComponent(instructionSetName)}?project=${encodeURIComponent(project)}`)
  if (!response.ok) throw new Error(`Instruction set resolution failed: ${await response.text()}`)
  const payload = await parseJsonResponse<InstructionSetResolution>(response, 'Instruction set resolution')
  const instructionSet = payload.instructionSet
  const profile = instructionSet?.profiles?.find(candidate => candidate.modelConfigIdentity === modelConfigIdentity)
  // An archived model config's profile is not resolvable: the same refusal
  // the server's resolve_instruction_set gives hosted runs.
  if (!profile || profile.modelConfigArchivedAt) throw new Error(`instruction_set_profile_not_found: ${modelConfigIdentity}`)
  const versions = profile.versions ?? []
  if (versionNumber !== undefined) {
    const version = versions.find(candidate => candidate.versionNumber === versionNumber)
    if (version?.profileVersionId) {
      requireMatchingSeed(instructionSet?.shape, versions, version, modelConfigIdentity, 'named')
      return version.profileVersionId
    }
    const newest = versions.reduce((max, candidate) => Math.max(max, candidate.versionNumber ?? 0), 0)
    throw new Error(`instruction_set_profile_version_not_found: ${modelConfigIdentity} has no v${versionNumber}; ${newest > 0 ? `newest is v${newest}` : 'it has no versions'}`)
  }
  const profileVersionId = profile.production?.profileVersionId
  if (!profileVersionId) throw new Error(`instruction_set_profile_not_promoted: ${modelConfigIdentity}`)
  const production = versions.find(candidate => candidate.profileVersionId === profileVersionId)
  if (production) requireMatchingSeed(instructionSet?.shape, versions, production, modelConfigIdentity, 'production')
  return profileVersionId
}

/**
 * Resolve the Seed that dispatch normalised into the connector environment.
 * Returns undefined when no instruction set was selected. When no version is
 * named, `unversioned: 'production'` resolves the profile's Production here
 * (local runs); `unversioned: 'server'` leaves it to the hosted launch route,
 * which resolves Production itself in the same call that queues the run.
 */
export async function resolveGepaSeedFromEnvironment(
  environment: NodeJS.ProcessEnv,
  project: string,
  unversioned: 'production' | 'server',
): Promise<string | undefined> {
  const instructionSetName = environment.ORIZU_INSTRUCTION_SET_NAME
  const modelConfigIdentity = environment.ORIZU_MODEL_CONFIG_IDENTITY
  if (!instructionSetName || !modelConfigIdentity) return undefined
  const rawVersion = environment.ORIZU_INSTRUCTION_SET_PROFILE_VERSION_NUMBER
  const versionNumber = rawVersion === undefined ? undefined : profileVersionNumber(rawVersion)
  if (versionNumber === undefined && unversioned === 'server') return undefined
  return resolveGepaInstructionSetProfileVersion(instructionSetName, modelConfigIdentity, project, versionNumber)
}
