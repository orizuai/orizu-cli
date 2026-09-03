import { instructionSetLockSchemaV1 } from './schema.v1.js'

export interface SyncedVersionLock {
  profileVersionId: string
  versionNumber: number
  digest: string
  components: Record<string, string>
  syncedAt: string
}

export interface ProfileLock {
  production: string | null
  versions: Record<string, SyncedVersionLock>
}

export interface InstructionSetLock {
  instructionSetId: string
  default: string
  profiles: Record<string, ProfileLock>
}

export interface InstructionSetLockV1 {
  lockfileVersion: 1
  project: string
  instructionSets: Record<string, InstructionSetLock>
  helpers?: Record<string, string>
  pins?: string[]
}

export type LockParseErrorCode =
  | 'lock_invalid_json'
  | 'lock_unsupported_version'
  | 'lock_production_not_a_version'
  | `lock_component_key_unsafe:${string}`
  | `lock_component_key_reserved:${string}`
  | `lock_helper_path_invalid:${string}`
  | `lock_set_slug_invalid:${string}`
  | `lock_profile_slug_invalid:${string}`
  | `lock_default_slug_invalid:${string}`
  | `lock_instruction_set_id_duplicate:${string}`
  | `lock_profile_version_id_duplicate:${string}`
  | `instruction_set_lock_component_key_collision:${string},${string}`
  | `instruction_set_lock_helper_path_collision:${string},${string}`
  | `lock_schema_violation:${string}`
  | `lock_pin_invalid:${string}:${SpecifierParseErrorCode}`

export class LockParseError extends Error {
  readonly code: LockParseErrorCode
  readonly path?: string

  constructor(code: LockParseErrorCode, path?: string) {
    super(code)
    this.name = 'LockParseError'
    this.code = code
    this.path = path
  }
}

export type SpecifierParseErrorCode =
  | 'specifier_empty'
  | 'specifier_invalid_set'
  | 'specifier_profile_missing'
  | 'specifier_invalid_profile'
  | 'specifier_version_without_profile'
  | 'specifier_invalid_version'

export class SpecifierParseError extends Error {
  readonly code: SpecifierParseErrorCode

  constructor(code: SpecifierParseErrorCode) {
    super(code)
    this.name = 'SpecifierParseError'
    this.code = code
  }
}

export interface ParsedSpecifier {
  set: string
  profile?: string
  versionNumber?: number
}

interface JsonSchema {
  $ref?: string
  const?: unknown
  type?: string | string[]
  required?: string[]
  properties?: Record<string, JsonSchema>
  patternProperties?: Record<string, JsonSchema>
  propertyNames?: JsonSchema
  additionalProperties?: boolean | JsonSchema
  items?: JsonSchema
  uniqueItems?: boolean
  pattern?: string
  format?: string
  minimum?: number
  maximum?: number
  minLength?: number
  minProperties?: number
}

const lockSchema = instructionSetLockSchemaV1
const rootSchema = lockSchema as unknown as JsonSchema
export const INSTRUCTION_SET_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
export const INSTRUCTION_SET_PROFILE_SLUG = /^[a-z0-9][a-z0-9._-]*__[a-z0-9][a-z0-9._-]*$/u
const PROFILE_IDENTITY = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u
export const INSTRUCTION_SET_COMPONENT_KEY = /^(?!\.)[A-Za-z0-9._-]+$/u
const WINDOWS_RESERVED_COMPONENT_KEY = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu
export const INSTRUCTION_SET_HELPER_PATH = /^helpers\/(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u
const MAX_VERSION_NUMBER = 2_147_483_647
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const VERSION = /^v([1-9][0-9]*)$/u

export function windowsPathIdentity(value: string): string {
  return value.toLowerCase().replace(/[. ]+$/u, '')
}

function escapeJsonPointer(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1')
}

function childPath(path: string, segment: string): string {
  return `${path}/${escapeJsonPointer(segment)}`
}

function schemaAtReference(reference: string): JsonSchema {
  if (!reference.startsWith('#/')) return {}
  let current: unknown = lockSchema
  for (const encodedSegment of reference.slice(2).split('/')) {
    const segment = encodedSegment.replaceAll('~1', '/').replaceAll('~0', '~')
    if (!current || typeof current !== 'object' || Array.isArray(current)) return {}
    current = (current as Record<string, unknown>)[segment]
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? current as JsonSchema
    : {}
}

function hasJsonType(value: unknown, expected: string): boolean {
  if (expected === 'null') return value === null
  if (expected === 'array') return Array.isArray(value)
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  if (expected === 'integer') return typeof value === 'number' && Number.isSafeInteger(value)
  return typeof value === expected
}

function isValidDateTime(value: string): boolean {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) return false
  const canonicalUtc = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u
  return !canonicalUtc.test(value) || parsed.toISOString() === value
}

function firstSchemaViolation(value: unknown, schema: JsonSchema, path: string): string | null {
  if (schema.$ref) return firstSchemaViolation(value, schemaAtReference(schema.$ref), path)
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return path || '/'

  if (schema.type) {
    const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!expectedTypes.some(expected => hasJsonType(value, expected))) return path || '/'
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return path || '/'
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) return path || '/'
    if (schema.format === 'uuid' && !UUID.test(value)) return path || '/'
    if (schema.format === 'date-time' && !isValidDateTime(value)) return path || '/'
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return path || '/'
    if (schema.maximum !== undefined && value > schema.maximum) return path || '/'
  }

  if (Array.isArray(value)) {
    if (schema.uniqueItems) {
      const seen = new Set(value.map(item => JSON.stringify(item)))
      if (seen.size !== value.length) return path || '/'
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const violation = firstSchemaViolation(value[index], schema.items, childPath(path, String(index)))
        if (violation) return violation
      }
    }
    return null
  }

  if (value === null || typeof value !== 'object') return null
  const object = value as Record<string, unknown>
  const keys = Object.keys(object)
  if (schema.minProperties !== undefined && keys.length < schema.minProperties) return path || '/'

  for (const required of schema.required ?? []) {
    if (!Object.hasOwn(object, required)) return childPath(path, required)
  }

  for (const key of keys) {
    const keyPath = childPath(path, key)
    if (schema.propertyNames) {
      const violation = firstSchemaViolation(key, schema.propertyNames, keyPath)
      if (violation) return violation
    }
    const propertySchema = schema.properties && Object.hasOwn(schema.properties, key)
      ? schema.properties[key]
      : undefined
    if (propertySchema) {
      const violation = firstSchemaViolation(object[key], propertySchema, keyPath)
      if (violation) return violation
      continue
    }
    const matchingSchemas = Object.entries(schema.patternProperties ?? {})
      .filter(([pattern]) => new RegExp(pattern, 'u').test(key))
      .map(([, matchingSchema]) => matchingSchema)
    if (matchingSchemas.length > 0) {
      for (const matchingSchema of matchingSchemas) {
        const violation = firstSchemaViolation(object[key], matchingSchema, keyPath)
        if (violation) return violation
      }
      continue
    }
    if (schema.additionalProperties === false) return keyPath
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      const violation = firstSchemaViolation(object[key], schema.additionalProperties, keyPath)
      if (violation) return violation
    }
  }
  return null
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isUnsafeComponentKey(key: string): boolean {
  return !INSTRUCTION_SET_COMPONENT_KEY.test(key)
}

export function validateInstructionSetComponentKeys(
  componentKeys: string[],
  pathPrefix = '/components',
  rejectWindowsReserved = false
): void {
  const componentKeysByCaseFold = new Map<string, string>()
  for (const componentKey of componentKeys) {
    const caseFoldedKey = componentKey.toLowerCase()
    const collidingKey = componentKeysByCaseFold.get(caseFoldedKey)
    if (collidingKey !== undefined) {
      throw new LockParseError(
        `instruction_set_lock_component_key_collision:${collidingKey},${componentKey}`
      )
    }
    componentKeysByCaseFold.set(caseFoldedKey, componentKey)
    const path = childPath(pathPrefix, componentKey)
    if (rejectWindowsReserved && WINDOWS_RESERVED_COMPONENT_KEY.test(componentKey)) {
      throw new LockParseError(`lock_component_key_reserved:${path}`, path)
    }
    if (isUnsafeComponentKey(componentKey)) {
      throw new LockParseError(`lock_component_key_unsafe:${path}`, path)
    }
  }
}

function validateComponentKeys(value: unknown): void {
  const instructionSets = objectRecord(objectRecord(value)?.instructionSets)
  if (!instructionSets) return
  for (const [setSlug, instructionSetValue] of Object.entries(instructionSets)) {
    const profiles = objectRecord(objectRecord(instructionSetValue)?.profiles)
    if (!profiles) continue
    for (const [profileSlug, profileValue] of Object.entries(profiles)) {
      const versions = objectRecord(objectRecord(profileValue)?.versions)
      if (!versions) continue
      for (const [versionKey, versionValue] of Object.entries(versions)) {
        const components = objectRecord(objectRecord(versionValue)?.components)
        if (!components) continue
        const pathPrefix = [
          'instructionSets',
          setSlug,
          'profiles',
          profileSlug,
          'versions',
          versionKey,
          'components',
        ].reduce(childPath, '')
        validateInstructionSetComponentKeys(Object.keys(components), pathPrefix)
      }
    }
  }
}

function validateLockSlugs(value: unknown): void {
  const instructionSets = objectRecord(objectRecord(value)?.instructionSets)
  if (!instructionSets) return
  for (const [setSlug, instructionSetValue] of Object.entries(instructionSets)) {
    if (!INSTRUCTION_SET_SLUG.test(setSlug)) {
      const path = childPath(childPath('', 'instructionSets'), setSlug)
      throw new LockParseError(`lock_set_slug_invalid:${path}`, path)
    }
    const instructionSet = objectRecord(instructionSetValue)
    const defaultSlug = instructionSet?.default
    if (typeof defaultSlug === 'string' && !INSTRUCTION_SET_PROFILE_SLUG.test(defaultSlug)) {
      const path = [
        'instructionSets',
        setSlug,
        'default',
      ].reduce(childPath, '')
      throw new LockParseError(`lock_default_slug_invalid:${path}`, path)
    }
    const profiles = objectRecord(instructionSet?.profiles)
    if (!profiles) continue
    for (const profileSlug of Object.keys(profiles)) {
      if (INSTRUCTION_SET_PROFILE_SLUG.test(profileSlug)) continue
      const path = [
        'instructionSets',
        setSlug,
        'profiles',
        profileSlug,
      ].reduce(childPath, '')
      throw new LockParseError(`lock_profile_slug_invalid:${path}`, path)
    }
  }
}

function validateHelperPaths(value: unknown): void {
  const helpers = objectRecord(objectRecord(value)?.helpers)
  if (!helpers) return
  const helperPathsByWindowsIdentity = new Map<string, string>()
  for (const helperPath of Object.keys(helpers)) {
    const pathIdentity = windowsPathIdentity(helperPath)
    const collidingPath = helperPathsByWindowsIdentity.get(pathIdentity)
    if (collidingPath !== undefined) {
      throw new LockParseError(
        `instruction_set_lock_helper_path_collision:${collidingPath},${helperPath}`
      )
    }
    helperPathsByWindowsIdentity.set(pathIdentity, helperPath)
    if (INSTRUCTION_SET_HELPER_PATH.test(helperPath)) continue
    const path = childPath(childPath('', 'helpers'), helperPath)
    throw new LockParseError(`lock_helper_path_invalid:${path}`, path)
  }
}

function validatePinSpecifiers(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return
  const pins = (value as Record<string, unknown>).pins
  if (!Array.isArray(pins)) return

  for (const [index, pin] of pins.entries()) {
    if (typeof pin !== 'string') continue
    const path = childPath(childPath('', 'pins'), String(index))
    try {
      const specifier = parseSpecifier(pin)
      if (specifier.versionNumber === undefined) {
        throw new SpecifierParseError('specifier_invalid_version')
      }
    } catch (error) {
      if (!(error instanceof SpecifierParseError)) throw error
      throw new LockParseError(`lock_pin_invalid:${path}:${error.code}`, path)
    }
  }
}

function validateUniqueIds(lock: InstructionSetLockV1): void {
  const instructionSetIds = new Set<string>()
  const profileVersionIds = new Set<string>()
  for (const [setSlug, instructionSet] of Object.entries(lock.instructionSets)) {
    const instructionSetId = instructionSet.instructionSetId.toLowerCase()
    if (instructionSetIds.has(instructionSetId)) {
      const path = [
        'instructionSets',
        setSlug,
        'instructionSetId',
      ].reduce(childPath, '')
      throw new LockParseError(`lock_instruction_set_id_duplicate:${path}`, path)
    }
    instructionSetIds.add(instructionSetId)

    for (const [profileSlug, profile] of Object.entries(instructionSet.profiles)) {
      for (const [versionKey, version] of Object.entries(profile.versions)) {
        const profileVersionId = version.profileVersionId.toLowerCase()
        if (profileVersionIds.has(profileVersionId)) {
          const path = [
            'instructionSets',
            setSlug,
            'profiles',
            profileSlug,
            'versions',
            versionKey,
            'profileVersionId',
          ].reduce(childPath, '')
          throw new LockParseError(`lock_profile_version_id_duplicate:${path}`, path)
        }
        profileVersionIds.add(profileVersionId)
      }
    }
  }
}

function validateLockValue(value: unknown): InstructionSetLockV1 {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).lockfileVersion === 'number' &&
    (value as Record<string, unknown>).lockfileVersion !== 1
  ) {
    throw new LockParseError('lock_unsupported_version')
  }

  validateComponentKeys(value)
  validateLockSlugs(value)
  validateHelperPaths(value)
  validatePinSpecifiers(value)
  const violation = firstSchemaViolation(value, rootSchema, '')
  if (violation) {
    throw new LockParseError(`lock_schema_violation:${violation}`, violation)
  }

  const lock = value as InstructionSetLockV1
  validateUniqueIds(lock)
  for (const [setSlug, instructionSet] of Object.entries(lock.instructionSets)) {
    for (const [profileSlug, profile] of Object.entries(instructionSet.profiles)) {
      for (const [versionKey, version] of Object.entries(profile.versions)) {
        if (versionKey !== `v${version.versionNumber}`) {
          const path = childPath(
            childPath(
              childPath(
                childPath(childPath('', 'instructionSets'), setSlug),
                'profiles'
              ),
              profileSlug
            ),
            'versions'
          )
          const versionPath = childPath(path, versionKey)
          throw new LockParseError(`lock_schema_violation:${versionPath}`, versionPath)
        }
      }
      if (profile.production !== null && !Object.hasOwn(profile.versions, profile.production)) {
        throw new LockParseError(
          'lock_production_not_a_version',
          childPath(
            childPath(childPath(childPath('', 'instructionSets'), setSlug), 'profiles'),
            profileSlug
          )
        )
      }
    }
  }
  return lock
}

export function parseLock(text: string): InstructionSetLockV1 {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new LockParseError('lock_invalid_json')
  }
  return validateLockValue(value)
}

type OrderedJson =
  | string
  | number
  | boolean
  | null
  | OrderedJson[]
  | ReadonlyMap<string, OrderedJson>

function orderedObject(entries: Array<[string, OrderedJson]>): ReadonlyMap<string, OrderedJson> {
  return new Map(entries)
}

function orderedRecord<T>(
  record: Record<string, T>,
  mapValue: (value: T) => OrderedJson
): ReadonlyMap<string, OrderedJson> {
  return orderedObject(Object.keys(record).sort().map(key => [key, mapValue(record[key]!)]))
}

function stringifyOrdered(value: OrderedJson, depth = 0): string {
  if (value instanceof Map) {
    if (value.size === 0) return '{}'
    const entries = [...value.entries()].map(([key, child]) =>
      `${'  '.repeat(depth + 1)}${JSON.stringify(key)}: ${stringifyOrdered(child, depth + 1)}`
    )
    return `{\n${entries.join(',\n')}\n${'  '.repeat(depth)}}`
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map(item => `${'  '.repeat(depth + 1)}${stringifyOrdered(item, depth + 1)}`)
    return `[\n${items.join(',\n')}\n${'  '.repeat(depth)}]`
  }
  return JSON.stringify(value)
}

export function serializeLock(lock: InstructionSetLockV1): string {
  const validLock = validateLockValue(lock)
  const instructionSets = orderedRecord(validLock.instructionSets, instructionSet => orderedObject([
    ['instructionSetId', instructionSet.instructionSetId],
    ['default', instructionSet.default],
    ['profiles', orderedRecord(instructionSet.profiles, profile => orderedObject([
      ['production', profile.production],
      ['versions', orderedObject(Object.entries(profile.versions)
        .sort((left, right) => left[1].versionNumber - right[1].versionNumber)
        .map(([versionKey, version]) => [versionKey, orderedObject([
          ['profileVersionId', version.profileVersionId],
          ['versionNumber', version.versionNumber],
          ['digest', version.digest],
          ['components', orderedRecord(version.components, digest => digest)],
          ['syncedAt', version.syncedAt],
        ])]))],
    ]))],
  ]))
  const entries: Array<[string, OrderedJson]> = [
    ['lockfileVersion', 1],
    ['project', validLock.project],
    ['instructionSets', instructionSets],
  ]
  if (validLock.helpers) entries.push([
    'helpers',
    orderedRecord(validLock.helpers, digest => digest),
  ])
  if (validLock.pins) entries.push(['pins', [...validLock.pins]])
  return `${stringifyOrdered(orderedObject(entries))}\n`
}

export function parseSpecifier(text: string): ParsedSpecifier {
  if (text.length === 0) throw new SpecifierParseError('specifier_empty')
  const firstSlash = text.indexOf('/')
  if (firstSlash === -1) {
    if (text.includes('@')) throw new SpecifierParseError('specifier_version_without_profile')
    if (!INSTRUCTION_SET_SLUG.test(text)) throw new SpecifierParseError('specifier_invalid_set')
    return { set: text }
  }

  const set = text.slice(0, firstSlash)
  if (!INSTRUCTION_SET_SLUG.test(set)) throw new SpecifierParseError('specifier_invalid_set')
  const profileAndVersion = text.slice(firstSlash + 1)
  if (profileAndVersion.length === 0 || profileAndVersion.startsWith('@')) {
    throw new SpecifierParseError('specifier_profile_missing')
  }
  const at = profileAndVersion.indexOf('@')
  const profile = at === -1 ? profileAndVersion : profileAndVersion.slice(0, at)
  if (!PROFILE_IDENTITY.test(profile) || profile.startsWith('/') || profile.endsWith('/')) {
    throw new SpecifierParseError('specifier_invalid_profile')
  }
  if (at === -1) return { set, profile }

  const versionText = profileAndVersion.slice(at + 1)
  const match = VERSION.exec(versionText)
  if (!match) throw new SpecifierParseError('specifier_invalid_version')
  const versionNumber = Number(match[1])
  if (versionNumber > MAX_VERSION_NUMBER) throw new SpecifierParseError('specifier_invalid_version')
  return { set, profile, versionNumber }
}
