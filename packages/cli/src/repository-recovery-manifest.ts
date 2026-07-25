import { createHash } from 'node:crypto'

export const REPOSITORY_RECOVERY_MANIFEST_KIND =
  'orizu.repository-recovery-manifest' as const
export const REPOSITORY_RECOVERY_MANIFEST_VERSION = 1 as const
export const REPOSITORY_BACKUP_ADMISSION_ENVELOPE_VERSION = 1 as const

export type RepositoryBackupAdmissionEnvelopeVersion =
  typeof REPOSITORY_BACKUP_ADMISSION_ENVELOPE_VERSION

export type GitObjectType = 'blob' | 'commit' | 'tag' | 'tree'

export interface RepositoryRecoveryRef {
  name: string
  objectId: string
}

export interface RepositoryRecoveryObject {
  objectId: string
  type: GitObjectType
  size: number
}

export type RepositoryRefBindingMode =
  | 'exact'
  | 'reachability'
export type RepositoryDatabasePinRefBindingMode =
  RepositoryRefBindingMode
export type RepositoryDatabasePinPathObjectType = 'blob' | 'tree'

export interface FrozenRepositoryDatabasePin {
  pinId: string
  kind: string
  commitSha: string
  /** Frozen provenance ref. Reachability mode does not imply it is still at commitSha. */
  ref: string
  /** Whether the provenance ref tip itself is frozen or only commit reachability is. */
  refBindingMode: RepositoryDatabasePinRefBindingMode
  path?: string
  pathObjectType?: RepositoryDatabasePinPathObjectType
  pathObjectId?: string
  /** Optional byte-level proof for blob pins; tree identity is the Git object ID. */
  contentSha256?: string
}

export interface RepositoryRecoveryManifestInput {
  admissionEnvelopeVersion: RepositoryBackupAdmissionEnvelopeVersion
  objectFormat: 'sha1'
  headTarget: string | null
  headObjectId: string | null
  requiredRef: string
  requiredRefBindingMode: RepositoryRefBindingMode
  requiredCommitSha: string
  refs: readonly RepositoryRecoveryRef[]
  objects: readonly RepositoryRecoveryObject[]
  databasePins: readonly FrozenRepositoryDatabasePin[]
}

export interface RepositoryRecoveryManifest {
  kind: typeof REPOSITORY_RECOVERY_MANIFEST_KIND
  version: typeof REPOSITORY_RECOVERY_MANIFEST_VERSION
  admissionEnvelopeVersion: RepositoryBackupAdmissionEnvelopeVersion
  objectFormat: 'sha1'
  headTarget: string | null
  headObjectId: string | null
  requiredRef: string
  requiredRefBindingMode: RepositoryRefBindingMode
  requiredCommitSha: string
  refs: RepositoryRecoveryRef[]
  objects: RepositoryRecoveryObject[]
  databasePins: FrozenRepositoryDatabasePin[]
  totals: {
    refCount: number
    objectCount: number
    objectBytes: number
    databasePinCount: number
  }
}

const SHA1_PATTERN = /^[0-9a-f]{40}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const OBJECT_TYPES = new Set<GitObjectType>(['blob', 'commit', 'tag', 'tree'])
const DATABASE_PIN_REF_BINDING_MODES =
  new Set<RepositoryRefBindingMode>([
    'exact',
    'reachability',
  ])

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertNonEmptyIdentifier(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a non-empty, bounded identifier without control characters`)
  }
}

export function assertSha1ObjectId(value: string, label = 'Git object ID'): void {
  if (!SHA1_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase 40-character SHA-1 object ID`)
  }
}

export function assertSha256(value: string, label = 'SHA-256 digest'): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase 64-character SHA-256 digest`)
  }
}

/**
 * A deliberately explicit subset of `git check-ref-format`. Recovery accepts
 * every ordinary `refs/*` namespace, but never pseudo refs or replace refs:
 * importing `refs/replace/*` would change object resolution during verification.
 */
export function assertRecoveryRefName(value: string, label = 'Git ref'): void {
  if (
    typeof value !== 'string' ||
    !value.startsWith('refs/') ||
    Buffer.byteLength(value, 'utf8') > 1024 ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.includes('//') ||
    value.includes('..') ||
    value.includes('@{') ||
    /[\u0000-\u0020\u007f~^:?*[\]\\]/.test(value)
  ) {
    throw new Error(`${label} is not a safe fully-qualified refs/* name`)
  }

  const components = value.split('/')
  if (
    components.some(component =>
      component.length === 0 ||
      component === '.' ||
      component === '..' ||
      component.startsWith('.') ||
      component.endsWith('.lock')
    )
  ) {
    throw new Error(`${label} contains a forbidden ref component`)
  }

  if (value.startsWith('refs/replace/')) {
    throw new Error(`${label} uses the forbidden refs/replace namespace`)
  }
}

export function assertSafeRecoveryPath(value: string, label = 'repository path'): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 4096 ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a bounded relative Git path`)
  }

  const parts = value.split('/')
  if (
    parts.some(part =>
      part.length === 0 ||
      part === '.' ||
      part === '..' ||
      part.toLowerCase() === '.git'
    )
  ) {
    throw new Error(`${label} contains a forbidden traversal or .git component`)
  }
}

function canonicalizeRef(ref: RepositoryRecoveryRef): RepositoryRecoveryRef {
  assertRecoveryRefName(ref.name, 'recovery manifest ref')
  assertSha1ObjectId(ref.objectId, `object ID for ${ref.name}`)
  return { name: ref.name, objectId: ref.objectId }
}

function canonicalizeObject(
  object: RepositoryRecoveryObject
): RepositoryRecoveryObject {
  assertSha1ObjectId(object.objectId, 'recovery manifest object ID')
  if (!OBJECT_TYPES.has(object.type)) {
    throw new Error(`unsupported Git object type: ${String(object.type)}`)
  }
  if (!Number.isSafeInteger(object.size) || object.size < 0) {
    throw new Error(`Git object ${object.objectId} has an invalid byte size`)
  }
  return { objectId: object.objectId, type: object.type, size: object.size }
}

function canonicalizePin(
  pin: FrozenRepositoryDatabasePin
): FrozenRepositoryDatabasePin {
  assertNonEmptyIdentifier(pin.pinId, 'database pin ID')
  assertNonEmptyIdentifier(pin.kind, 'database pin kind')
  assertSha1ObjectId(pin.commitSha, `database pin ${pin.pinId} commit`)
  assertRecoveryRefName(pin.ref, `database pin ${pin.pinId} ref`)
  if (!DATABASE_PIN_REF_BINDING_MODES.has(pin.refBindingMode)) {
    throw new Error(
      `database pin ${pin.pinId} ref binding mode must be exact or reachability`
    )
  }

  const pathIdentityFields = [
    pin.path,
    pin.pathObjectType,
    pin.pathObjectId,
  ]
  const hasPathIdentity = pathIdentityFields.some(
    value => value !== undefined
  )
  if (
    hasPathIdentity &&
    pathIdentityFields.some(value => value === undefined)
  ) {
    throw new Error(
      `database pin ${pin.pinId} must provide path, pathObjectType, and pathObjectId together`
    )
  }
  if (!hasPathIdentity && pin.contentSha256 !== undefined) {
    throw new Error(
      `database pin ${pin.pinId} cannot provide contentSha256 without a path identity`
    )
  }
  if (hasPathIdentity) {
    assertSafeRecoveryPath(pin.path!, `database pin ${pin.pinId} path`)
    if (
      pin.pathObjectType !== 'blob' &&
      pin.pathObjectType !== 'tree'
    ) {
      throw new Error(
        `database pin ${pin.pinId} path object type must be blob or tree`
      )
    }
    assertSha1ObjectId(
      pin.pathObjectId!,
      `database pin ${pin.pinId} path object ID`
    )
    if (pin.contentSha256 !== undefined) {
      if (pin.pathObjectType !== 'blob') {
        throw new Error(
          `database pin ${pin.pinId} contentSha256 is valid only for a blob path`
        )
      }
      assertSha256(
        pin.contentSha256,
        `database pin ${pin.pinId} content hash`
      )
    }
  }

  return {
    pinId: pin.pinId,
    kind: pin.kind,
    commitSha: pin.commitSha,
    ref: pin.ref,
    refBindingMode: pin.refBindingMode,
    ...(!hasPathIdentity
      ? {}
      : {
          path: pin.path,
          pathObjectType: pin.pathObjectType,
          pathObjectId: pin.pathObjectId,
          ...(pin.contentSha256 === undefined
            ? {}
            : { contentSha256: pin.contentSha256 }),
        }),
  }
}

export function canonicalizeRepositoryRecoveryManifest(
  input: RepositoryRecoveryManifestInput
): RepositoryRecoveryManifest {
  if (
    input.admissionEnvelopeVersion !==
    REPOSITORY_BACKUP_ADMISSION_ENVELOPE_VERSION
  ) {
    throw new Error(
      'repository backup admission envelope version is unsupported'
    )
  }
  if (input.objectFormat !== 'sha1') {
    throw new Error('repository recovery supports SHA-1 Git object format only')
  }
  assertRecoveryRefName(input.requiredRef, 'required ref')
  if (
    !DATABASE_PIN_REF_BINDING_MODES.has(
      input.requiredRefBindingMode
    )
  ) {
    throw new Error(
      'required ref binding mode must be exact or reachability'
    )
  }
  assertSha1ObjectId(input.requiredCommitSha, 'required commit SHA')
  if (input.headTarget !== null) {
    assertRecoveryRefName(input.headTarget, 'HEAD target')
  }
  if (input.headObjectId !== null) {
    assertSha1ObjectId(input.headObjectId, 'HEAD object ID')
  }

  const refs = input.refs.map(canonicalizeRef).sort((left, right) =>
    compareStrings(left.name, right.name) ||
    compareStrings(left.objectId, right.objectId)
  )
  const objects = input.objects.map(canonicalizeObject).sort((left, right) =>
    compareStrings(left.objectId, right.objectId) ||
    compareStrings(left.type, right.type) ||
    left.size - right.size
  )
  const databasePins = input.databasePins.map(canonicalizePin).sort((left, right) =>
    compareStrings(left.kind, right.kind) ||
    compareStrings(left.pinId, right.pinId) ||
    compareStrings(left.commitSha, right.commitSha) ||
    compareStrings(left.ref, right.ref) ||
    compareStrings(left.refBindingMode, right.refBindingMode) ||
    compareStrings(left.path ?? '', right.path ?? '') ||
    compareStrings(left.pathObjectType ?? '', right.pathObjectType ?? '') ||
    compareStrings(left.pathObjectId ?? '', right.pathObjectId ?? '') ||
    compareStrings(left.contentSha256 ?? '', right.contentSha256 ?? '')
  )

  const refNames = new Set<string>()
  for (const ref of refs) {
    if (refNames.has(ref.name)) {
      throw new Error(`duplicate ref in recovery manifest: ${ref.name}`)
    }
    refNames.add(ref.name)
  }

  const objectIds = new Set<string>()
  const objectTypes = new Map<string, GitObjectType>()
  for (const object of objects) {
    if (objectIds.has(object.objectId)) {
      throw new Error(`duplicate object in recovery manifest: ${object.objectId}`)
    }
    objectIds.add(object.objectId)
    objectTypes.set(object.objectId, object.type)
  }

  const pinKeys = new Set<string>()
  for (const pin of databasePins) {
    const key = `${pin.kind}\u0000${pin.pinId}`
    if (pinKeys.has(key)) {
      throw new Error(`duplicate database pin in recovery manifest: ${pin.kind}/${pin.pinId}`)
    }
    pinKeys.add(key)
    if (objectTypes.get(pin.commitSha) !== 'commit') {
      throw new Error(
        `database pin ${pin.kind}/${pin.pinId} commit is not a reachable commit object`
      )
    }
    if (
      pin.pathObjectId !== undefined &&
      objectTypes.get(pin.pathObjectId) !== pin.pathObjectType
    ) {
      throw new Error(
        `database pin ${pin.kind}/${pin.pinId} path object is not a reachable ${pin.pathObjectType}`
      )
    }
    if (pin.refBindingMode === 'exact') {
      const pinnedRef = refs.find(ref => ref.name === pin.ref)
      if (!pinnedRef || pinnedRef.objectId !== pin.commitSha) {
        throw new Error(
          `database pin ${pin.kind}/${pin.pinId} ref does not resolve to its exact commit`
        )
      }
    }
  }

  const required = refs.find(ref => ref.name === input.requiredRef)
  if (!required) {
    throw new Error('required provenance ref is absent')
  }
  if (
    input.requiredRefBindingMode === 'exact' &&
    required.objectId !== input.requiredCommitSha
  ) {
    throw new Error(
      'required ref does not resolve to the exact required commit'
    )
  }
  if (objectTypes.get(input.requiredCommitSha) !== 'commit') {
    throw new Error('required commit SHA is not a reachable commit object')
  }
  if (input.headTarget !== null) {
    const headRef = refs.find(ref => ref.name === input.headTarget)
    if (!headRef || headRef.objectId !== input.headObjectId) {
      throw new Error('HEAD target/object does not match the recovery ref inventory')
    }
  } else if (
    input.headObjectId !== null &&
    !objectIds.has(input.headObjectId)
  ) {
    throw new Error('detached HEAD object is not reachable from the recovery refs')
  }
  if (
    input.headObjectId !== null &&
    objectTypes.get(input.headObjectId) !== 'commit'
  ) {
    throw new Error('HEAD object is not a reachable commit')
  }
  const objectBytes = objects.reduce((sum, object) => sum + object.size, 0)
  if (!Number.isSafeInteger(objectBytes)) {
    throw new Error('recovery manifest object byte total exceeds the safe integer range')
  }

  return {
    kind: REPOSITORY_RECOVERY_MANIFEST_KIND,
    version: REPOSITORY_RECOVERY_MANIFEST_VERSION,
    admissionEnvelopeVersion: input.admissionEnvelopeVersion,
    objectFormat: 'sha1',
    headTarget: input.headTarget,
    headObjectId: input.headObjectId,
    requiredRef: input.requiredRef,
    requiredRefBindingMode: input.requiredRefBindingMode,
    requiredCommitSha: input.requiredCommitSha,
    refs,
    objects,
    databasePins,
    totals: {
      refCount: refs.length,
      objectCount: objects.length,
      objectBytes,
      databasePinCount: databasePins.length,
    },
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, child]) => [key, sortJsonValue(child)])
    )
  }
  return value
}

export function serializeRepositoryRecoveryManifest(
  manifest: RepositoryRecoveryManifest
): Buffer {
  const canonical = canonicalizeRepositoryRecoveryManifest(manifest)
  return Buffer.from(`${JSON.stringify(sortJsonValue(canonical), null, 2)}\n`, 'utf8')
}

/**
 * Parse persisted evidence without silently upgrading, normalizing, or
 * discarding fields. The byte comparison rejects duplicate JSON keys,
 * unexpected fields, changed totals, non-canonical ordering/whitespace, and
 * any future manifest version this runtime does not explicitly understand.
 */
export function parseRepositoryRecoveryManifestBytes(
  bytes: Uint8Array
): RepositoryRecoveryManifest {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error('Repository recovery manifest bytes are invalid')
  }

  let value: unknown
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes
    )
    value = JSON.parse(text) as unknown
  } catch {
    throw new Error('Repository recovery manifest is not valid UTF-8 JSON')
  }

  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new Error('Repository recovery manifest must be a JSON object')
  }
  const record = value as Record<string, unknown>
  if (
    record.kind !== REPOSITORY_RECOVERY_MANIFEST_KIND ||
    record.version !== REPOSITORY_RECOVERY_MANIFEST_VERSION
  ) {
    throw new Error(
      'Repository recovery manifest kind or version is unsupported'
    )
  }

  let canonical: RepositoryRecoveryManifest
  try {
    canonical = canonicalizeRepositoryRecoveryManifest(
      value as RepositoryRecoveryManifest
    )
  } catch {
    throw new Error('Repository recovery manifest evidence is invalid')
  }

  const canonicalBytes =
    serializeRepositoryRecoveryManifest(canonical)
  if (!Buffer.from(bytes).equals(canonicalBytes)) {
    throw new Error(
      'Repository recovery manifest does not match its canonical persisted bytes'
    )
  }
  return canonical
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
