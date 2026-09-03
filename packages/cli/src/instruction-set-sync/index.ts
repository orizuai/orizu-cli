import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  MAX_VERSION_NUMBER,
  parseLock,
  parseSpecifier,
  serializeLock,
  validateInstructionSetComponentKeys,
  type InstructionSetLockV1,
  type ParsedSpecifier,
} from '../instruction-set-lock/index.js'
import { assertOutputConfined, createManagedArtifactJournal, emitManagedArtifacts } from './helpers.js'

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u
const SYNC_LOCK_WAIT_MS = 5_000
const SYNC_LOCK_RETRY_MS = 50
const SYNC_LOCK_STALE_MS = 60_000

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

export type SyncTarget = 'ts'

export function parseSyncTarget(value: string | undefined): SyncTarget {
  const target = value ?? 'ts'
  if (target !== 'ts') throw new Error(`instruction_set_sync_target_unsupported:${target}`)
  return target
}

export interface SyncedComponent { body: string }
export interface SyncedVersionPayload {
  profileVersionId: string
  versionNumber: number
  components: Record<string, SyncedComponent>
  settings: Record<string, unknown>
  sourceProvenance?: string
}
export interface SyncPayload {
  instructionSet: {
    instructionSetId: string
    name: string
    slug: string
    status?: 'active' | 'archived'
    description?: string | null
    defaultProfile: { modelConfigIdentity: string; profileSlug: string }
    profile: { modelConfigIdentity: string; profileSlug: string; production: string | null }
    version: SyncedVersionPayload | null
  }
}

export interface SyncRequestPlan {
  parsed: ParsedSpecifier
  path: string
  lock: InstructionSetLockV1
  usedRecordedPointer: boolean
  expectedProfileIdentity?: string
  expectedProfileSlug?: string
}

function safeSegment(value: string): void {
  if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..' || value.startsWith('.')) {
    throw new Error('instruction_set_path_unsafe')
  }
}

export function profileSlug(identity: string): string {
  return identity.replaceAll('/', '__').replace(/[^A-Za-z0-9._-]/gu, '_')
}

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex')
}

function readLock(appRoot: string, project: string): InstructionSetLockV1 {
  const path = join(appRoot, 'orizu.lock.json')
  if (!existsSync(path)) return { lockfileVersion: 1, project, instructionSets: {} }
  const lock = parseLock(readFileSync(path, 'utf8'))
  if (lock.project !== project) throw new Error('instruction_set_sync_project_mismatch')
  return lock
}

function lockedProfileIdentity(
  appRoot: string,
  setSlug: string,
  profileSlugValue: string,
  profile: InstructionSetLockV1['instructionSets'][string]['profiles'][string]
): string {
  const versionSlugs = [
    ...(profile.production ? [profile.production] : []),
    ...Object.keys(profile.versions).filter(version => version !== profile.production).sort(),
  ]
  for (const versionSlug of versionSlugs) {
    try {
      const manifest = JSON.parse(readFileSync(
        join(appRoot, 'instruction-sets', setSlug, profileSlugValue, versionSlug, 'manifest.json'),
        'utf8'
      )) as { modelConfigIdentity?: unknown; profileSlug?: unknown }
      if (manifest.profileSlug === profileSlugValue && typeof manifest.modelConfigIdentity === 'string') {
        return manifest.modelConfigIdentity
      }
    } catch {
      // Try another Synced version before failing closed.
    }
  }
  throw new Error('instruction_set_sync_lock_profile_identity_missing')
}

function positiveVersion(value: string | null): number | undefined {
  if (value === null) return undefined
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error('--version must be a positive integer')
  const version = Number(value)
  if (!Number.isSafeInteger(version) || version > MAX_VERSION_NUMBER) throw new Error('--version must be a positive integer')
  return version
}

export function planSyncRequest(
  reference: string,
  versionFlag: string | null,
  out: string,
  project: string
): SyncRequestPlan {
  const parsed = parseSpecifier(reference)
  const flagVersion = positiveVersion(versionFlag)
  if (parsed.versionNumber !== undefined && flagVersion !== undefined && parsed.versionNumber !== flagVersion) {
    throw new Error('instruction_set_sync_version_conflict')
  }
  if (flagVersion !== undefined && parsed.profile === undefined) {
    throw new Error('instruction_set_sync_version_requires_profile')
  }
  let versionNumber = parsed.versionNumber ?? flagVersion
  const appRoot = join(out, 'orizu')
  const lock = readLock(appRoot, project)
  const lockedSet = lock.instructionSets[parsed.set]
  const query = new URLSearchParams({ project })
  let usedRecordedPointer = false
  let selectedProfileSlug: string | undefined
  let expectedProfileIdentity: string | undefined
  let expectedProfileSlug: string | undefined

  if (parsed.profile !== undefined) {
    query.set('profile', parsed.profile)
    selectedProfileSlug = profileSlug(parsed.profile)
    expectedProfileIdentity = parsed.profile
  } else if (lockedSet) {
    selectedProfileSlug = lockedSet.default
    expectedProfileSlug = selectedProfileSlug
    const lockedProfile = lockedSet.profiles[selectedProfileSlug]
    if (lockedProfile) {
      expectedProfileIdentity = lockedProfileIdentity(appRoot, parsed.set, selectedProfileSlug, lockedProfile)
      query.set('profile', expectedProfileIdentity)
    } else {
      query.set('profileSlug', selectedProfileSlug)
    }
    usedRecordedPointer = true
  }

  if (versionNumber !== undefined) {
    query.set('version', String(versionNumber))
  } else if (selectedProfileSlug) {
    const production = lockedSet?.profiles[selectedProfileSlug]?.production
    if (production) {
      versionNumber = Number(production.slice(1))
      query.set('version', String(versionNumber))
      usedRecordedPointer = true
    }
  }

  return {
    parsed: { ...parsed, ...(versionNumber !== undefined ? { versionNumber } : {}) },
    path: `/api/cli/instruction-sets/${encodeURIComponent(parsed.set)}/sync?${query.toString()}`,
    lock,
    usedRecordedPointer,
    ...(expectedProfileIdentity ? { expectedProfileIdentity } : {}),
    ...(expectedProfileSlug ? { expectedProfileSlug } : {}),
  }
}

function isLegacyManifest(path: string, setSlug?: string, setName?: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    const value = JSON.parse(readFileSync(path, 'utf8')) as {
      manifestVersion?: unknown
      name?: unknown
      slug?: unknown
    }
    return value.manifestVersion === 1
      && (setSlug === undefined || value.slug === setSlug || value.name === setName)
  } catch {
    return false
  }
}

function refuseLegacyLayout(out: string, setSlug: string, setName: string): void {
  const candidates = [
    join(out, setSlug, 'manifest.json'),
    join(out, 'orizu', 'instruction-sets', setSlug, 'manifest.json'),
  ]
  if (candidates.some(path => isLegacyManifest(path))) {
    throw new Error('instruction_set_sync_legacy_layout: see the migration guide in docs/cli.md#migrating-the-legacy-sync-layout')
  }
  try {
    for (const entry of readdirSync(out, { withFileTypes: true })) {
      if (entry.name === 'orizu' || !entry.isDirectory()) continue
      candidates.push(join(out, entry.name, 'manifest.json'))
    }
  } catch {
    // A missing output root has no legacy layout to refuse.
  }
  if (candidates.some(path => isLegacyManifest(path, setSlug, setName))) {
    throw new Error('instruction_set_sync_legacy_layout: see the migration guide in docs/cli.md#migrating-the-legacy-sync-layout')
  }
}

function settingsPath(parent: string, key: string | number): string {
  return typeof key === 'number' ? `${parent}[${key}]` : `${parent}[${JSON.stringify(key)}]`
}

function canonicalJson(value: unknown, path = '$'): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('instruction_set_sync_response_mismatch')
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`instruction_set_sync_settings_precision:${path}`)
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item, index) => canonicalJson(item, settingsPath(path, index))).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key], settingsPath(path, key))}`).join(',')}}`
  }
  throw new Error('instruction_set_sync_response_mismatch')
}

function canonicalValue<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T
}

export function canonicalVersionDigest(components: Record<string, string>, settings: Record<string, unknown>): string {
  let input = Object.keys(components).sort()
    .map(name => `${name}\0${components[name]!.slice('sha256:'.length)}\n`)
    .join('')
  if (Object.keys(settings).length > 0) {
    input += `\0settings\0${sha256(canonicalJson(settings))}\n`
  }
  return `sha256:${sha256(input)}`
}

export function recordResolvedPayloadInLock(
  lock: InstructionSetLockV1,
  payload: SyncPayload,
  now: () => Date = () => new Date()
): InstructionSetLockV1 {
  const set = payload.instructionSet
  const material = set.version
  if (!material || set.profile.production !== `v${material.versionNumber}`) {
    throw new Error('instruction_set_pointer_unresolved:production')
  }
  if (set.profile.profileSlug !== profileSlug(set.profile.modelConfigIdentity)) {
    throw new Error('instruction_set_update_response_mismatch')
  }
  const existingSet = lock.instructionSets[set.slug]
  if (!existingSet || existingSet.instructionSetId !== set.instructionSetId) {
    throw new Error('instruction_set_update_response_mismatch')
  }
  const componentHashes: Record<string, string> = {}
  for (const name of Object.keys(material.components).sort()) {
    safeSegment(name)
    const body = material.components[name]?.body
    if (typeof body !== 'string') throw new Error('instruction_set_unresolvable')
    componentHashes[name] = `sha256:${sha256(body)}`
  }
  if (Object.keys(componentHashes).length === 0) throw new Error('instruction_set_unresolvable')
  if (material.settings === null || Array.isArray(material.settings) || typeof material.settings !== 'object') {
    throw new Error('instruction_set_update_response_mismatch')
  }
  const versionSlug = `v${material.versionNumber}`
  const expectedVersion = {
    profileVersionId: material.profileVersionId,
    versionNumber: material.versionNumber,
    digest: canonicalVersionDigest(componentHashes, canonicalValue(material.settings)),
    components: componentHashes,
  }
  const existingProfile = existingSet.profiles[set.profile.profileSlug]
  const existingVersion = existingProfile?.versions[versionSlug]
  assertVersionMatches(existingVersion, expectedVersion, `${set.slug}/${set.profile.profileSlug}@${versionSlug}`)
  lock.instructionSets[set.slug] = {
    instructionSetId: set.instructionSetId,
    default: set.defaultProfile.profileSlug,
    profiles: {
      ...existingSet.profiles,
      [set.profile.profileSlug]: {
        production: versionSlug,
        versions: {
          ...(existingProfile?.versions ?? {}),
          [versionSlug]: existingVersion ?? {
            ...expectedVersion,
            syncedAt: now().toISOString(),
          },
        },
      },
    },
  }
  return lock
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function generatedJsonParse(value: unknown): string {
  const jsonTextLiteral = JSON.stringify(canonicalJson(value))
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
    .replace(/</gu, '\\u003c')
  return `JSON.parse(${jsonTextLiteral})`
}

function generatedStringProperties(keys: string[]): string {
  return keys.map(key => `  readonly ${JSON.stringify(key)}: string;`).join('\n')
}

export function renderGeneratedVersionModule(components: Record<string, string>, manifest: unknown): string {
  const componentKeys = Object.keys(components).sort()
  const componentLiteral = Object.fromEntries(componentKeys.map(name => [name, components[name]]))
  const componentProperties = generatedStringProperties(componentKeys)
  return `// @generated
export interface GeneratedComponents {
${componentProperties}
}

export interface GeneratedManifest {
  readonly manifestVersion: number;
  readonly instructionSetId: string;
  readonly instructionSetName: string;
  readonly instructionSetSlug: string;
  readonly profileVersionId: string;
  readonly modelConfigIdentity: string;
  readonly profileSlug: string;
  readonly versionNumber: number;
  readonly components: Readonly<Record<keyof GeneratedComponents, string>>;
  readonly digest: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly provenance: Readonly<Record<string, string>>;
  readonly sourceProvenance?: unknown;
}

export const components = ${generatedJsonParse(componentLiteral)} as GeneratedComponents;

export const manifest = ${generatedJsonParse(manifest)} as GeneratedManifest;
`
}

function recordsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
}

function validateVersionIdentity(
  project: string,
  set: SyncPayload['instructionSet'],
  versionSlug: string,
  version: { profileVersionId: string; versionNumber: number; digest: string; components: Record<string, string> }
): void {
  // Exercise the same public Lock schema that will attest these bytes before
  // creating any output directory. This covers UUID, bounded integer, digest,
  // and every Component hash shape without maintaining a second validator.
  parseLock(serializeLock({
    lockfileVersion: 1,
    project,
    instructionSets: {
      [set.slug]: {
        instructionSetId: set.instructionSetId,
        default: set.defaultProfile.profileSlug,
        profiles: {
          [set.profile.profileSlug]: {
            production: versionSlug,
            versions: {
              [versionSlug]: { ...version, syncedAt: '2000-01-01T00:00:00.000Z' },
            },
          },
        },
      },
    },
  }))
}

function assertVersionMatches(
  existing: InstructionSetLockV1['instructionSets'][string]['profiles'][string]['versions'][string] | undefined,
  expected: { profileVersionId: string; versionNumber: number; digest: string; components: Record<string, string> },
  address: string
): void {
  if (existing && (existing.profileVersionId !== expected.profileVersionId
    || existing.versionNumber !== expected.versionNumber
    || existing.digest !== expected.digest
    || !recordsEqual(existing.components, expected.components))) {
    throw new Error(`instruction_set_sync_version_conflict:${address}`)
  }
}

function assertExistingVersionMatches(
  destination: string,
  componentHashes: Record<string, string>,
  manifestBytes: string,
  generatedBytes: string
): void {
  try {
    const expectedComponentFiles = Object.keys(componentHashes).map(name => `${name}.prompt.md`).sort()
    if (JSON.stringify(readdirSync(join(destination, 'components')).sort()) !== JSON.stringify(expectedComponentFiles)) {
      throw new Error('mismatch')
    }
    for (const [name, expectedHash] of Object.entries(componentHashes)) {
      const body = readFileSync(join(destination, 'components', `${name}.prompt.md`), 'utf8')
      if (`sha256:${sha256(body)}` !== expectedHash) throw new Error('mismatch')
    }
    if (readFileSync(join(destination, 'manifest.json'), 'utf8') !== manifestBytes) throw new Error('mismatch')
    if (readFileSync(join(destination, 'components.generated.ts'), 'utf8') !== generatedBytes) throw new Error('mismatch')
  } catch {
    throw new Error('instruction_set_sync_version_conflict')
  }
}

interface ObservedSyncLock {
  raw: string
  mtimeMs: number
  pid?: number
  ownerIsAlive?: boolean
}

function observeSyncLock(lockPath: string): ObservedSyncLock {
  const raw = readFileSync(lockPath, 'utf8')
  const mtimeMs = statSync(lockPath).mtimeMs
  try {
    const value = JSON.parse(raw) as { pid?: unknown; createdAt?: unknown }
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || typeof value.createdAt !== 'string'
      || new Date(value.createdAt).toISOString() !== value.createdAt) {
      return { raw, mtimeMs }
    }
    const pid = value.pid as number
    try {
      process.kill(pid, 0)
      return { raw, mtimeMs, pid, ownerIsAlive: true }
    } catch (error) {
      if (isNodeError(error) && error.code === 'ESRCH') return { raw, mtimeMs, pid, ownerIsAlive: false }
      // EPERM proves the process exists; unknown probe errors also fail closed.
      return { raw, mtimeMs, pid, ownerIsAlive: true }
    }
  } catch {
    return { raw, mtimeMs }
  }
}

function removeObservedSyncLock(lockPath: string, observed: ObservedSyncLock): boolean {
  holdForProcessTest('ORIZU_TEST_SYNC_HOLD_STALE_TAKEOVER_MS')
  if (readFileSync(lockPath, 'utf8') !== observed.raw) return false
  rmSync(lockPath)
  console.warn(`instruction_set_sync_lock_stale_removed:${lockPath}`)
  return true
}

export function withSyncLock<T>(appRoot: string, operation: () => T): T {
  mkdirSync(appRoot, { recursive: true })
  const lockPath = join(appRoot, '.orizu.lock.json.lock')
  const metadata = `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`
  const deadline = Date.now() + SYNC_LOCK_WAIT_MS

  while (true) {
    try {
      writeFileSync(lockPath, metadata, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      break
    } catch (error) {
      if (!(isNodeError(error) && error.code === 'EEXIST')) throw error
      let busyPid: number | undefined
      try {
        const observed = observeSyncLock(lockPath)
        busyPid = observed.ownerIsAlive ? observed.pid : undefined
        const isStale = observed.ownerIsAlive === false
          || (observed.ownerIsAlive === undefined && Date.now() - observed.mtimeMs > SYNC_LOCK_STALE_MS)
        if (isStale && removeObservedSyncLock(lockPath, observed)) continue
      } catch (inspectionError) {
        if (isNodeError(inspectionError) && inspectionError.code === 'ENOENT') continue
        throw inspectionError
      }
      if (Date.now() >= deadline) {
        throw new Error(`instruction_set_sync_lock_busy${busyPid === undefined ? '' : `:${busyPid}`}`)
      }
      sleepSync(Math.min(SYNC_LOCK_RETRY_MS, Math.max(1, deadline - Date.now())))
    }
  }

  const release = () => {
    try {
      if (readFileSync(lockPath, 'utf8') === metadata) rmSync(lockPath)
    } catch (error) {
      if (!(isNodeError(error) && error.code === 'ENOENT')) throw error
    }
  }
  let result: T
  try {
    result = operation()
  } catch (error) {
    release()
    throw error
  }
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    return Promise.resolve(result).finally(release) as T
  }
  release()
  return result
}

// Test-only process boundary hooks. Production behavior is unchanged unless a
// test child explicitly supplies one of the bounded ORIZU_TEST_SYNC_HOLD_* values.
function holdForProcessTest(name: string): void {
  const raw = process.env[name]
  if (raw === undefined) return
  const milliseconds = Number(raw)
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 10_000) {
    throw new Error(`instruction_set_sync_test_hold_invalid:${name}`)
  }
  sleepSync(milliseconds)
}

export interface SyncDiskResult { destination: string; wasPresent: boolean; warnings: string[] }
export interface SyncDiskOptions {
  now?: () => Date
  forceHelpers?: boolean
  pointerMode?: 'preserve' | 'replace'
  target?: SyncTarget
  platform?: NodeJS.Platform
}

export function syncPayloadToDisk(
  out: string,
  project: string,
  plan: SyncRequestPlan,
  payload: SyncPayload,
  options: SyncDiskOptions = {}
): SyncDiskResult {
  const target = parseSyncTarget(options.target)
  const now = options.now ?? (() => new Date())
  const set = payload.instructionSet
  if (!set || set.slug !== plan.parsed.set || !set.instructionSetId) throw new Error('instruction_set_sync_response_mismatch')
  const lock = plan.lock
  const existingSet = lock.instructionSets[set.slug]
  if (existingSet && existingSet.instructionSetId !== set.instructionSetId) throw new Error('instruction_set_sync_identity_mismatch')
  safeSegment(set.slug)
  refuseLegacyLayout(out, set.slug, set.name)

  if (set.defaultProfile.profileSlug !== profileSlug(set.defaultProfile.modelConfigIdentity)) {
    throw new Error('instruction_set_sync_response_mismatch')
  }
  safeSegment(set.defaultProfile.profileSlug)
  if (plan.expectedProfileSlug && set.profile.profileSlug !== plan.expectedProfileSlug) {
    throw new Error('instruction_set_sync_response_mismatch')
  }
  if (plan.expectedProfileIdentity && set.profile.modelConfigIdentity !== plan.expectedProfileIdentity) {
    throw new Error('instruction_set_sync_response_mismatch')
  }
  if (!plan.expectedProfileIdentity && !plan.expectedProfileSlug
    && set.profile.modelConfigIdentity !== set.defaultProfile.modelConfigIdentity) {
    throw new Error('instruction_set_sync_response_mismatch')
  }
  if (set.profile.profileSlug !== profileSlug(set.profile.modelConfigIdentity)) throw new Error('instruction_set_sync_response_mismatch')

  const material = set.version
  if (!material) {
    throw new Error(`instruction_set_sync_production_unset: run orizu instructions profiles promote ${set.slug} --model-config ${set.profile.modelConfigIdentity} --version <n>`)
  }
  if (plan.parsed.versionNumber !== undefined && material.versionNumber !== plan.parsed.versionNumber) {
    throw new Error('instruction_set_sync_response_mismatch')
  }
  const versionSlug = `v${material.versionNumber}`
  safeSegment(set.profile.profileSlug); safeSegment(versionSlug)
  const componentBytes: Record<string, string> = Object.create(null)
  const componentHashes: Record<string, string> = Object.create(null)
  const componentNames = Object.keys(material.components).sort()
  for (const name of componentNames) safeSegment(name)
  validateInstructionSetComponentKeys(componentNames, '/components', (options.platform ?? process.platform) === 'win32')
  for (const name of componentNames) {
    const body = material.components[name]?.body
    if (typeof body !== 'string') throw new Error('instruction_set_unresolvable')
    componentBytes[name] = body
    componentHashes[name] = `sha256:${sha256(body)}`
  }
  if (Object.keys(componentBytes).length === 0) throw new Error('instruction_set_unresolvable')
  const rawSettings = material.settings
  if (rawSettings === null || Array.isArray(rawSettings) || typeof rawSettings !== 'object') {
    throw new Error('instruction_set_sync_response_mismatch')
  }
  const settings = canonicalValue(rawSettings)
  const digest = canonicalVersionDigest(componentHashes, settings)
  const provenance = { instructionSetId: set.instructionSetId, profileVersionId: material.profileVersionId, digest }
  const expectedVersion = {
    profileVersionId: material.profileVersionId,
    versionNumber: material.versionNumber,
    digest,
    components: componentHashes,
  }
  validateVersionIdentity(project, set, versionSlug, expectedVersion)
  const existingProfile = existingSet?.profiles[set.profile.profileSlug]
  const existingVersion = existingProfile?.versions[versionSlug]
  const address = `${set.slug}/${set.profile.profileSlug}@${versionSlug}`
  assertVersionMatches(existingVersion, expectedVersion, address)

  const manifest = {
    manifestVersion: 1,
    instructionSetId: set.instructionSetId,
    instructionSetName: set.name,
    instructionSetSlug: set.slug,
    profileVersionId: material.profileVersionId,
    modelConfigIdentity: set.profile.modelConfigIdentity,
    profileSlug: set.profile.profileSlug,
    versionNumber: material.versionNumber,
    components: componentHashes,
    digest,
    settings,
    provenance,
    ...(material.sourceProvenance ? { sourceProvenance: material.sourceProvenance } : {}),
  }

  const manifestBytes = stableJson(manifest)
  const generatedBytes = renderGeneratedVersionModule(componentBytes, manifest)
  const appRoot = join(out, 'orizu')
  if (existingProfile && lockedProfileIdentity(appRoot, set.slug, set.profile.profileSlug, existingProfile) !== set.profile.modelConfigIdentity) {
    throw new Error(`instruction_set_slug_collision:${set.profile.profileSlug}`)
  }
  const destination = join(appRoot, 'instruction-sets', set.slug, set.profile.profileSlug, versionSlug)
  mkdirSync(out, { recursive: true })
  assertOutputConfined(out, destination)
  mkdirSync(join(destination, '..'), { recursive: true })
  const wasPresent = existsSync(destination)
  let stagedTemp: string | null = null
  if (!wasPresent) {
    stagedTemp = join(appRoot, `.sync-${randomUUID()}.tmp`)
    mkdirSync(join(stagedTemp, 'components'), { recursive: true })
    try {
      for (const [name, body] of Object.entries(componentBytes)) writeFileSync(join(stagedTemp, 'components', `${name}.prompt.md`), body)
      writeFileSync(join(stagedTemp, 'manifest.json'), manifestBytes)
      writeFileSync(join(stagedTemp, 'components.generated.ts'), generatedBytes)
    } catch (error) {
      rmSync(stagedTemp, { recursive: true, force: true })
      throw error
    }
  } else {
    assertExistingVersionMatches(destination, componentHashes, manifestBytes, generatedBytes)
  }

  let warnings: string[] = []
  try {
    withSyncLock(appRoot, () => {
      holdForProcessTest('ORIZU_TEST_SYNC_HOLD_BEFORE_PUBLISH_MS')
      const currentLock = readLock(appRoot, project)
      holdForProcessTest('ORIZU_TEST_SYNC_HOLD_LOCK_MS')
      const currentSet = currentLock.instructionSets[set.slug]
      if (currentSet && currentSet.instructionSetId !== set.instructionSetId) {
        throw new Error('instruction_set_sync_identity_mismatch')
      }
      const currentProfile = currentSet?.profiles[set.profile.profileSlug]
      if (currentProfile && lockedProfileIdentity(appRoot, set.slug, set.profile.profileSlug, currentProfile) !== set.profile.modelConfigIdentity) {
        throw new Error(`instruction_set_slug_collision:${set.profile.profileSlug}`)
      }
      const currentVersion = currentProfile?.versions[versionSlug]
      assertVersionMatches(currentVersion, expectedVersion, address)
      const pointerMode = options.pointerMode ?? 'preserve'
      const defaultProfileSlug = pointerMode === 'replace'
        ? set.defaultProfile.profileSlug
        : currentSet?.default ?? existingSet?.default ?? set.defaultProfile.profileSlug
      const payloadProduction = plan.parsed.versionNumber === undefined && set.profile.production === versionSlug
        ? versionSlug
        : null
      const production = pointerMode === 'replace'
        ? payloadProduction
        : currentProfile?.production ?? existingProfile?.production ?? payloadProduction
      const preservedVersion = currentVersion ?? existingVersion
      const versions = { ...(currentProfile?.versions ?? existingProfile?.versions ?? {}), [versionSlug]: preservedVersion ?? {
        ...expectedVersion,
        syncedAt: now().toISOString(),
      } }
      currentLock.instructionSets[set.slug] = {
        instructionSetId: set.instructionSetId,
        default: defaultProfileSlug,
        profiles: {
          ...(currentSet?.profiles ?? existingSet?.profiles ?? {}),
          [set.profile.profileSlug]: { production, versions },
        },
      }
      const journal = createManagedArtifactJournal()
      const priorHelpers = currentLock.helpers
      let publishedDestination: string | null = null
      try {
        if (stagedTemp) {
          assertOutputConfined(out, destination)
          if (existsSync(destination)) {
            assertExistingVersionMatches(destination, componentHashes, manifestBytes, generatedBytes)
            rmSync(stagedTemp, { recursive: true, force: true })
          } else {
            renameSync(stagedTemp, destination)
            publishedDestination = destination
          }
          stagedTemp = null
        }
        warnings = emitManagedArtifacts(out, appRoot, currentLock, options.forceHelpers ?? false, target, journal)
        journal.write(join(appRoot, 'orizu.lock.json'), serializeLock(currentLock))
      } catch (error) {
        journal.rollback()
        currentLock.helpers = priorHelpers
        if (publishedDestination) {
          rmSync(publishedDestination, { recursive: true, force: true })
          const instructionSetsRoot = join(appRoot, 'instruction-sets')
          let ancestor = join(publishedDestination, '..')
          while (ancestor !== instructionSetsRoot && existsSync(ancestor) && readdirSync(ancestor).length === 0) {
            rmSync(ancestor, { recursive: true })
            ancestor = join(ancestor, '..')
          }
        }
        throw error
      }
    })
  } finally {
    if (stagedTemp) rmSync(stagedTemp, { recursive: true, force: true })
  }
  return { destination, wasPresent, warnings }
}
