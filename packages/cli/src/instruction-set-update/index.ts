import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  parseLock,
  parseSpecifier,
  serializeLock,
  type InstructionSetLockV1,
} from '../instruction-set-lock/index.js'
import { assertOutputConfined, reconcileGeneratedIndex } from '../instruction-set-sync/helpers.js'
import { profileSlug, recordResolvedPayloadInLock, syncPayloadToDisk, withSyncLock, type SyncPayload } from '../instruction-set-sync/index.js'
import { verifyInstructionSetTree } from '../instruction-set-verify/index.js'

export interface UpdateResolution {
  payload: SyncPayload
  profileIdentity: string
}

export interface UpdatePlan {
  lock: InstructionSetLockV1
  resolutions: UpdateResolution[]
  lines: string[]
}

function appRoot(out: string): string {
  return join(out, 'orizu')
}

export function readUpdateLock(out: string, project?: string): InstructionSetLockV1 {
  const lock = parseLock(readFileSync(join(appRoot(out), 'orizu.lock.json'), 'utf8'))
  if (project && lock.project !== project) throw new Error('instruction_set_update_project_mismatch')
  return lock
}

export function lockedProfileIdentity(out: string, setSlug: string, profileSlugValue: string): string {
  const profileRoot = join(appRoot(out), 'instruction-sets', setSlug, profileSlugValue)
  const lock = readUpdateLock(out)
  const profile = lock.instructionSets[setSlug]?.profiles[profileSlugValue]
  const versions = profile?.versions ?? {}
  if (profile?.modelConfigIdentity !== undefined) {
    for (const versionSlug of Object.keys(versions).sort()) {
      let manifest: { modelConfigIdentity?: unknown; profileSlug?: unknown }
      try {
        manifest = JSON.parse(readFileSync(join(profileRoot, versionSlug, 'manifest.json'), 'utf8')) as typeof manifest
      } catch {
        continue
      }
      if (manifest.profileSlug === profileSlugValue
        && typeof manifest.modelConfigIdentity === 'string'
        && manifest.modelConfigIdentity !== profile.modelConfigIdentity) {
        throw new Error(`instruction_set_update_model_config_identity_mismatch:${setSlug}/${profileSlugValue}`)
      }
    }
    return profile.modelConfigIdentity
  }
  for (const versionSlug of Object.keys(versions).sort()) {
    try {
      const manifest = JSON.parse(readFileSync(join(profileRoot, versionSlug, 'manifest.json'), 'utf8')) as {
        modelConfigIdentity?: unknown
        profileSlug?: unknown
      }
      if (manifest.profileSlug === profileSlugValue && typeof manifest.modelConfigIdentity === 'string') {
        return manifest.modelConfigIdentity
      }
    } catch {
      // A later Version may still carry the pre-binding Profile identity.
    }
  }
  throw new Error('instruction_set_update_profile_identity_missing')
}

export function makeUpdatePlan(
  project: string,
  lock: InstructionSetLockV1,
  payloads: SyncPayload[]
): UpdatePlan {
  if (lock.project !== project) throw new Error('instruction_set_update_project_mismatch')
  const byProfile = new Map<string, UpdateResolution>()
  const authoritativeDefaults = new Map<string, string>()
  const authoritativeProductions = new Map<string, string>()
  const plannedDefaults = new Set<string>()
  const plannedProductions = new Set<string>()
  const lines: string[] = []

  for (const payload of payloads) {
    const set = payload.instructionSet
    const material = set.version
    if (!material || set.profile.production === null) {
      throw new Error(`instruction_set_pointer_unresolved:production:${set.slug}/${set.profile.modelConfigIdentity}`)
    }
    if (set.profile.production !== `v${material.versionNumber}`) throw new Error('instruction_set_update_response_mismatch')
    const lockedSet = lock.instructionSets[set.slug]
    if (!lockedSet || lockedSet.instructionSetId !== set.instructionSetId) throw new Error('instruction_set_update_response_mismatch')
    const authoritativeDefault = authoritativeDefaults.get(set.slug)
    if (authoritativeDefault !== undefined && authoritativeDefault !== set.defaultProfile.profileSlug) {
      throw new Error(`instruction_set_update_snapshot_inconsistent:${set.slug}/default`)
    }
    if (authoritativeDefault === undefined) authoritativeDefaults.set(set.slug, set.defaultProfile.profileSlug)
    if (!plannedDefaults.has(set.slug)) {
      const unchanged = set.defaultProfile.profileSlug === lockedSet.default ? ' (unchanged)' : ''
      lines.push(`${set.slug} Default: ${lockedSet.default} -> ${set.defaultProfile.profileSlug}${unchanged}`)
      plannedDefaults.add(set.slug)
    }
    const selectedSlug = set.profile.profileSlug
    const lockedProfile = lockedSet.profiles[selectedSlug]
    if (lockedProfile?.modelConfigIdentity !== undefined
      && lockedProfile.modelConfigIdentity !== set.profile.modelConfigIdentity) {
      throw new Error(`instruction_set_update_model_config_identity_mismatch:${set.slug}/${selectedSlug}`)
    }
    const profileKey = `${set.slug}/${selectedSlug}`
    const authoritativeProduction = authoritativeProductions.get(profileKey)
    if (authoritativeProduction !== undefined && authoritativeProduction !== set.profile.production) {
      throw new Error(`instruction_set_update_snapshot_inconsistent:${profileKey}/production`)
    }
    if (authoritativeProduction === undefined) authoritativeProductions.set(profileKey, set.profile.production)
    if (!plannedProductions.has(profileKey)) {
      const before = lockedSet.profiles[selectedSlug]?.production ?? 'absent'
      lines.push(`${set.slug}/${set.profile.modelConfigIdentity} Production: ${before} -> ${set.profile.production}`)
      plannedProductions.add(profileKey)
      byProfile.set(profileKey, { payload, profileIdentity: set.profile.modelConfigIdentity })
    }
  }

  return { lock, resolutions: [...byProfile.values()], lines }
}

function holdBeforePruneVerifyForProcessTest(): void {
  const raw = process.env.ORIZU_TEST_PRUNE_HOLD_BEFORE_VERIFY_MS
  if (raw === undefined) return
  const milliseconds = Number(raw)
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 10_000) {
    throw new Error('instruction_set_prune_test_hold_invalid')
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function atomicWrite(path: string, bytes: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === bytes) return
  const temp = `${path}.${randomUUID()}.tmp`
  writeFileSync(temp, bytes)
  try { renameSync(temp, path) } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

export interface UpdateResult {
  absent: string[]
  warnings: string[]
}

function missingVersionModules(appRootPath: string, lock: InstructionSetLockV1): string[] {
  const missing: string[] = []
  for (const setSlug of Object.keys(lock.instructionSets).sort()) {
    const set = lock.instructionSets[setSlug]!
    for (const profileSlugValue of Object.keys(set.profiles).sort()) {
      const profile = set.profiles[profileSlugValue]!
      for (const versionSlug of Object.keys(profile.versions).sort()) {
        const relativePath = `instruction-sets/${setSlug}/${profileSlugValue}/${versionSlug}/components.generated.ts`
        if (!existsSync(join(appRootPath, relativePath))) missing.push(relativePath)
      }
    }
  }
  return missing
}

export function applyUpdate(
  out: string,
  project: string,
  plan: UpdatePlan,
  noSync: boolean,
  now: () => Date = () => new Date()
): UpdateResult {
  const absent: string[] = []
  const warnings: string[] = []
  if (noSync) {
    withSyncLock(appRoot(out), () => {
      let lock = readUpdateLock(out, project)
      for (const resolution of plan.resolutions) {
        const set = resolution.payload.instructionSet
        const material = set.version!
        const versionSlug = `v${material.versionNumber}`
        const destination = join(appRoot(out), 'instruction-sets', set.slug, set.profile.profileSlug, versionSlug)
        lock = recordResolvedPayloadInLock(lock, resolution.payload, now)
        if (!existsSync(join(destination, 'components.generated.ts'))) {
          absent.push(`${set.slug}/${resolution.profileIdentity}@${versionSlug}`)
        }
      }
      const appRootPath = appRoot(out)
      const missing = missingVersionModules(appRootPath, lock)
      const importMapPath = join(appRootPath, 'generated', 'index.ts')
      if (missing.length === 0 && existsSync(importMapPath)) {
        reconcileGeneratedIndex(appRootPath, lock)
      } else if (missing.length > 0) {
        warnings.push(`instruction_set_update_generated_index_stale:${missing[0]}; the generated index still resolves the previous Version — run orizu instructions sync <specifier> then orizu instructions verify`)
      }
      atomicWrite(join(appRootPath, 'orizu.lock.json'), serializeLock(lock))
    })
    return { absent, warnings }
  }

  let lock = plan.lock
  for (const resolution of plan.resolutions) {
    const set = resolution.payload.instructionSet
    const result = syncPayloadToDisk(out, project, {
      parsed: { set: set.slug, profile: resolution.profileIdentity },
      path: '',
      lock,
      usedRecordedPointer: false,
      expectedProfileIdentity: resolution.profileIdentity,
    }, resolution.payload, { now, pointerMode: 'replace' })
    warnings.push(...result.warnings)
    lock = readUpdateLock(out, project)
    if (!result.wasPresent && !existsSync(result.destination)) throw new Error('instruction_set_update_sync_failed')
  }
  return { absent, warnings }
}

function retentionKey(set: string, profileIdentity: string, versionNumber: number): string {
  return `${set}/${profileSlug(profileIdentity)}/v${versionNumber}`
}

export interface PrunePlan {
  lock: InstructionSetLockV1
  removals: Array<{ key: string; path: string; reason: string; unmanagedEntries?: string[] }>
}

export class PruneKeepUnresolvedError extends Error {
  readonly code: string
  readonly unresolved: string[]

  constructor(entries: Array<{ specifier: string; source: '--keep' | 'lock pin' }>) {
    const first = entries[0]!.specifier
    const code = `instruction_set_prune_keep_unresolved:${first}`
    super(`${code}; unresolved ${entries.map(entry => `${entry.source} ${entry.specifier}`).join(', ')}`)
    this.name = 'PruneKeepUnresolvedError'
    this.code = code
    this.unresolved = entries.map(entry => entry.specifier)
  }
}

export async function planPrune(out: string, keepSpecifiers: string[]): Promise<PrunePlan> {
  const lock = readUpdateLock(out)
  const retained = new Set<string>()
  for (const [setSlug, set] of Object.entries(lock.instructionSets)) {
    for (const [profileSlugValue, profile] of Object.entries(set.profiles)) {
      if (profile.production) retained.add(`${setSlug}/${profileSlugValue}/${profile.production}`)
    }
  }
  const retentionSpecifiers = [
    ...(lock.pins ?? []).map(specifier => ({ specifier, source: 'lock pin' as const })),
    ...keepSpecifiers.map(specifier => ({ specifier, source: '--keep' as const })),
  ]
  const unresolved: Array<{ specifier: string; source: '--keep' | 'lock pin' }> = []
  for (const entry of retentionSpecifiers) {
    const specifier = parseSpecifier(entry.specifier)
    if (specifier.profile === undefined || specifier.versionNumber === undefined) {
      throw new Error('specifier_invalid_version')
    }
    const key = retentionKey(specifier.set, specifier.profile, specifier.versionNumber)
    const profile = lock.instructionSets[specifier.set]?.profiles[profileSlug(specifier.profile)]
    if (!profile?.versions[`v${specifier.versionNumber}`]) unresolved.push(entry)
    retained.add(key)
  }
  if (unresolved.length > 0) throw new PruneKeepUnresolvedError(unresolved)
  const report = await verifyInstructionSetTree(out)
  if (!report.ok) throw new Error('instruction_set_prune_unverified')

  const removals: PrunePlan['removals'] = []
  for (const [setSlug, set] of Object.entries(lock.instructionSets)) {
    for (const [profileSlugValue, profile] of Object.entries(set.profiles)) {
      for (const versionSlug of Object.keys(profile.versions)) {
        const key = `${setSlug}/${profileSlugValue}/${versionSlug}`
        if (!retained.has(key)) removals.push({
          key,
          path: join(appRoot(out), 'instruction-sets', setSlug, profileSlugValue, versionSlug),
          reason: 'unreferenced by Pointers, Pins, and --keep',
        })
      }
    }
  }
  const removalKeys = new Set(removals.map(removal => removal.key))
  for (const [setSlug, set] of Object.entries(lock.instructionSets)) {
    const defaultProfile = set.profiles[set.default]
    if (defaultProfile && Object.keys(defaultProfile.versions).every(versionSlug =>
      removalKeys.has(`${setSlug}/${set.default}/${versionSlug}`)
    )) {
      throw new Error('instruction_set_prune_default_profile_empty')
    }
  }
  return { lock, removals: removals.sort((left, right) => left.key.localeCompare(right.key)) }
}

export interface PruneResult {
  skipped: PrunePlan['removals']
}

export async function applyPrune(out: string, plan: PrunePlan, keepSpecifiers: string[] = []): Promise<PruneResult> {
  return withSyncLock(appRoot(out), async () => {
    const currentPlan = await planPrune(out, keepSpecifiers)
    const currentRemovalKeys = new Set(currentPlan.removals.map(removal => removal.key))
    let removals = plan.removals.filter(removal => currentRemovalKeys.has(removal.key))
    const skipped = plan.removals
      .filter(removal => !currentRemovalKeys.has(removal.key))
      .map(removal => ({ ...removal, reason: 'became_referenced_after_planning' }))
    const removalKeys = new Set(removals.map(removal => removal.key))
    const unmanagedProfileKeys = new Set<string>()
    for (const [setSlug, set] of Object.entries(currentPlan.lock.instructionSets)) {
      for (const [profileSlugValue, profile] of Object.entries(set.profiles)) {
        const versionSlugs = Object.keys(profile.versions)
        if (!versionSlugs.every(versionSlug => removalKeys.has(`${setSlug}/${profileSlugValue}/${versionSlug}`))) continue
        const profilePath = join(appRoot(out), 'instruction-sets', setSlug, profileSlugValue)
        assertOutputConfined(out, profilePath)
        const lockedVersions = new Set(versionSlugs)
        const unmanagedEntries = readdirSync(profilePath, { withFileTypes: true })
          .filter(entry => !entry.isDirectory() || !lockedVersions.has(entry.name))
          .map(entry => entry.name)
          .sort()
        if (unmanagedEntries.length === 0) continue
        unmanagedProfileKeys.add(`${setSlug}/${profileSlugValue}`)
        for (const removal of removals) {
          if (!removal.key.startsWith(`${setSlug}/${profileSlugValue}/`)) continue
          skipped.push({ ...removal, reason: 'profile_directory_has_unmanaged_files', unmanagedEntries })
        }
      }
    }
    removals = removals.filter(removal => {
      const [setSlug, profileSlugValue] = removal.key.split('/')
      return !unmanagedProfileKeys.has(`${setSlug}/${profileSlugValue}`)
    })
    const candidate = parseLock(serializeLock(currentPlan.lock))
    const lockPath = join(appRoot(out), 'orizu.lock.json')
    const importMapPath = join(appRoot(out), 'generated', 'index.ts')
    const priorLock = readFileSync(lockPath, 'utf8')
    const priorImportMap = existsSync(importMapPath) ? readFileSync(importMapPath, 'utf8') : null
    const stagingRoot = join(appRoot(out), `.prune-${randomUUID()}.tmp`)
    mkdirSync(stagingRoot)
    const staged: Array<{ removal: PrunePlan['removals'][number]; stagedPath: string; specifier: string }> = []

    try {
      for (const [index, removal] of removals.entries()) {
        assertOutputConfined(out, removal.path)
        const [setSlug, profileSlugValue, versionSlug] = removal.key.split('/')
        const manifest = JSON.parse(readFileSync(join(removal.path, 'manifest.json'), 'utf8')) as { modelConfigIdentity: string }
        const stagedPath = join(stagingRoot, String(index))
        renameSync(removal.path, stagedPath)
        staged.push({ removal, stagedPath, specifier: `${setSlug}/${manifest.modelConfigIdentity}@${versionSlug}` })
        const profile = candidate.instructionSets[setSlug]!.profiles[profileSlugValue]!
        delete profile.versions[versionSlug]
        if (Object.keys(profile.versions).length === 0) delete candidate.instructionSets[setSlug]!.profiles[profileSlugValue]
      }
      const handledProfiles = new Set<string>()
      for (const item of staged) {
        const [setSlug, profileSlugValue] = item.removal.key.split('/')
        const profilePath = join(item.removal.path, '..')
        if (candidate.instructionSets[setSlug]!.profiles[profileSlugValue] || handledProfiles.has(profilePath)) continue
        handledProfiles.add(profilePath)
        rmdirSync(profilePath)
      }
      atomicWrite(lockPath, serializeLock(candidate))
      if (existsSync(importMapPath)) reconcileGeneratedIndex(appRoot(out), candidate)
      holdBeforePruneVerifyForProcessTest()
      const report = await verifyInstructionSetTree(out)
      if (!report.ok) {
        throw new Error(`instruction_set_prune_verification_failed:${report.failures[0]?.code ?? 'unknown'}`)
      }
      rmSync(stagingRoot, { recursive: true, force: true })
      return { skipped }
    } catch (error) {
      for (const item of [...staged].reverse()) {
        mkdirSync(join(item.removal.path, '..'), { recursive: true })
        if (existsSync(item.stagedPath)) renameSync(item.stagedPath, item.removal.path)
      }
      atomicWrite(lockPath, priorLock)
      if (priorImportMap === null) rmSync(importMapPath, { force: true })
      else atomicWrite(importMapPath, priorImportMap)
      rmSync(stagingRoot, { recursive: true, force: true })
      throw error
    }
  })
}
