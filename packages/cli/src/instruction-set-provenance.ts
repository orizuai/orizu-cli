import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseLock, parseSpecifier } from './instruction-set-lock/index.js'
import { profileSlug } from './instruction-set-sync/index.js'

export const PROVENANCE_ATTRIBUTE_NAMES = {
  instructionSetId: 'orizu.instruction_set.id',
  profileVersionId: 'orizu.profile_version.id',
  digest: 'orizu.instruction_set.digest',
} as const

export interface InstructionSetProvenanceTriple {
  instructionSetId: string
  profileVersionId: string
  digest: string
}

export function resolveInstructionSetProvenance({
  specifier,
  root = '.',
  project,
}: {
  specifier: string
  root?: string
  project: string
}): InstructionSetProvenanceTriple {
  const lockPath = join(root, 'orizu', 'orizu.lock.json')
  if (!existsSync(lockPath)) throw new Error(`instruction_set_lock_missing:${lockPath}`)
  const lock = parseLock(readFileSync(lockPath, 'utf8'))
  if (lock.project !== project) {
    throw new Error(`instruction_set_lock_project_mismatch:${lock.project}!=${project}`)
  }

  const parsed = parseSpecifier(specifier)
  const instructionSet = lock.instructionSets[parsed.set]
  if (!instructionSet) throw new Error('instruction_set_specifier_unknown')
  const selectedProfile = parsed.profile === undefined
    ? instructionSet.default
    : profileSlug(parsed.profile)
  const profile = instructionSet.profiles[selectedProfile]
  if (!profile) throw new Error('instruction_set_specifier_unknown')
  const selectedVersion = parsed.versionNumber === undefined
    ? profile.production
    : `v${parsed.versionNumber}`
  if (selectedVersion === null) {
    throw new Error('instruction_set_pointer_unresolved:production')
  }
  const version = profile.versions[selectedVersion]
  if (!version) throw new Error('instruction_set_specifier_unknown')

  return {
    instructionSetId: instructionSet.instructionSetId,
    profileVersionId: version.profileVersionId,
    digest: version.digest,
  }
}

export function provenanceRequestFields(triple: InstructionSetProvenanceTriple | null) {
  return triple ? {
    [PROVENANCE_ATTRIBUTE_NAMES.instructionSetId]: triple.instructionSetId,
    [PROVENANCE_ATTRIBUTE_NAMES.profileVersionId]: triple.profileVersionId,
    [PROVENANCE_ATTRIBUTE_NAMES.digest]: triple.digest,
  } : {}
}
