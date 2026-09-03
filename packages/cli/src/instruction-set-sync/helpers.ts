import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { serializeLock, type InstructionSetLockV1 } from '../instruction-set-lock/index.js'
import type { SyncTarget } from './index.js'

const LOAD_HELPER = String.raw`import { lock, versions } from '../generated/index.js'

interface VersionModule {
  components: Record<string, string>
  manifest: {
    settings?: Record<string, unknown>
    modelSettings?: Record<string, unknown>
    provenance: { instructionSetId: string; profileVersionId: string; digest: string }
  }
}

interface ParsedSpecifier {
  set: string
  profile?: string
  version?: string
}

export class InstructionSetLoadError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'InstructionSetLoadError'
    this.code = code
  }
}

function parseSpecifier(value: string): ParsedSpecifier {
  const firstSlash = value.indexOf('/')
  if (firstSlash < 0) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new InstructionSetLoadError('instruction_set_specifier_unknown')
    return { set: value }
  }
  const set = value.slice(0, firstSlash)
  const remainder = value.slice(firstSlash + 1)
  const at = remainder.indexOf('@')
  const profile = at < 0 ? remainder : remainder.slice(0, at)
  const version = at < 0 ? undefined : remainder.slice(at + 1)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(set) ||
      !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(profile) ||
      (version !== undefined && !/^v[1-9][0-9]*$/.test(version))) {
    throw new InstructionSetLoadError('instruction_set_specifier_unknown')
  }
  return { set, profile, ...(version === undefined ? {} : { version }) }
}

function profileSlug(identity: string): string {
  return identity.replaceAll('/', '__').replace(/[^A-Za-z0-9._-]/g, '_')
}

export function loadInstructions(specifier: string): {
  components: Record<string, string>
  settings: Record<string, unknown>
  provenance: { instructionSetId: string; profileVersionId: string; digest: string }
  generatedProvenance: { instructionSetId: string; profileVersionId: string; digest: string }
} {
  const parsed = parseSpecifier(specifier)
  const instructionSet = lock.instructionSets[parsed.set as keyof typeof lock.instructionSets]
  const setVersions = versions[parsed.set as keyof typeof versions]
  if (!instructionSet || !setVersions) throw new InstructionSetLoadError('instruction_set_specifier_unknown')

  const selectedProfile = parsed.profile === undefined ? instructionSet.default : profileSlug(parsed.profile)
  const profile = instructionSet.profiles[selectedProfile as keyof typeof instructionSet.profiles]
  const profileVersions = setVersions[selectedProfile as keyof typeof setVersions]
  if (!profile || !profileVersions) throw new InstructionSetLoadError('instruction_set_specifier_unknown')

  const selectedVersion = parsed.version ?? profile.production
  if (selectedVersion === null) throw new InstructionSetLoadError('instruction_set_pointer_unresolved:production')
  const loaded = profileVersions[selectedVersion as keyof typeof profileVersions] as unknown as VersionModule | undefined
  if (!loaded) throw new InstructionSetLoadError('instruction_set_specifier_unknown')

  const lockedVersion = profile.versions[selectedVersion as keyof typeof profile.versions]
  if (!lockedVersion) throw new InstructionSetLoadError('instruction_set_specifier_unknown')

  return {
    components: loaded.components,
    settings: loaded.manifest.settings ?? loaded.manifest.modelSettings ?? {},
    provenance: {
      instructionSetId: instructionSet.instructionSetId,
      profileVersionId: lockedVersion.profileVersionId,
      digest: lockedVersion.digest,
    },
    generatedProvenance: loaded.manifest.provenance,
  }
}
`

const LOAD_TEST = String.raw`import { InstructionSetLoadError, loadInstructions } from './load.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function runLoadSelfCheck(): void {
  let failure: unknown
  try { loadInstructions('orizu-self-check-missing') } catch (error) { failure = error }
  assert(failure instanceof InstructionSetLoadError, 'load Helper must reject an unknown Specifier')
  assert(failure.code === 'instruction_set_specifier_unknown', 'load Helper must use its named unknown-Specifier error')
}
`

const PROVENANCE_HELPER = String.raw`export const PROVENANCE_ATTRIBUTE_NAMES = {
  instructionSetId: 'orizu.instruction_set.id',
  profileVersionId: 'orizu.profile_version.id',
  digest: 'orizu.instruction_set.digest',
} as const

interface LoadedInstructions {
  provenance: {
    instructionSetId: string
    profileVersionId: string
    digest: string
  }
}

interface SpanLike {
  setAttribute(name: string, value: string): unknown
}

type AttributionPayload = Record<string, unknown>

export function provenanceOf(loaded: LoadedInstructions): LoadedInstructions['provenance'] {
  return {
    instructionSetId: loaded.provenance.instructionSetId,
    profileVersionId: loaded.provenance.profileVersionId,
    digest: loaded.provenance.digest,
  }
}

export function attachProvenance<T extends SpanLike | AttributionPayload>(
  target: T,
  loaded: LoadedInstructions
): T {
  const provenance = provenanceOf(loaded)
  const attributes = {
    [PROVENANCE_ATTRIBUTE_NAMES.instructionSetId]: provenance.instructionSetId,
    [PROVENANCE_ATTRIBUTE_NAMES.profileVersionId]: provenance.profileVersionId,
    [PROVENANCE_ATTRIBUTE_NAMES.digest]: provenance.digest,
  }
  if ('setAttribute' in target && typeof target.setAttribute === 'function') {
    for (const [name, value] of Object.entries(attributes)) target.setAttribute(name, value)
  } else {
    Object.assign(target, attributes)
  }
  return target
}
`

const PROVENANCE_TEST = String.raw`import { attachProvenance, provenanceOf } from './provenance.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function runProvenanceSelfCheck(): void {
  const loaded = { provenance: { instructionSetId: 'set', profileVersionId: 'version', digest: 'sha256:digest' } }
  const payload: Record<string, unknown> = { existing: true }
  attachProvenance(payload, loaded)
  assert(payload.existing === true, 'Provenance Helper must preserve attribution payload fields')
  assert(payload['orizu.profile_version.id'] === 'version', 'Provenance Helper must attach the stable Profile Version attribute')
  assert(provenanceOf(loaded).digest === 'sha256:digest', 'Provenance Helper must return the loaded digest')
}
`

const VERIFY_HELPER = String.raw`interface Provenance {
  instructionSetId: string
  profileVersionId: string
  digest: string
}

interface LoadedBytes {
  components: Record<string, string>
  settings: Record<string, unknown>
  digest: string
  provenance: Provenance
  generatedProvenance: Provenance
}

interface LockedVersion {
  profileVersionId: string
  digest: string
  components: Record<string, string>
}

interface ParsedLock {
  instructionSets: Record<string, {
    instructionSetId: string
    profiles: Record<string, { versions: Record<string, LockedVersion> }>
  }>
}

export class IntegrityVerificationError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'IntegrityVerificationError'
    this.code = code
  }
}

function sha256(value: string): string {
  const Encoder = (globalThis as unknown as {
    TextEncoder: new () => { encode: (input: string) => Uint8Array }
  }).TextEncoder
  const bytes = new Encoder().encode(value)
  const words: number[] = []
  const bitLength = bytes.length * 8
  for (let index = 0; index < bytes.length; index += 1) {
    words[index >> 2] = (words[index >> 2] ?? 0) | bytes[index]! << (24 - (index % 4) * 8)
  }
  words[bitLength >> 5] = (words[bitLength >> 5] ?? 0) | 0x80 << (24 - bitLength % 32)
  const paddedLength = (((bitLength + 64) >> 9) << 4) + 15
  words[paddedLength] = bitLength

  const constants = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]
  const hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
  const rotate = (value: number, count: number) => value >>> count | value << (32 - count)
  for (let offset = 0; offset < words.length; offset += 16) {
    const schedule = new Array<number>(64)
    for (let index = 0; index < 64; index += 1) {
      if (index < 16) schedule[index] = words[offset + index] ?? 0
      else {
        const left = schedule[index - 15]!
        const right = schedule[index - 2]!
        const s0 = rotate(left, 7) ^ rotate(left, 18) ^ left >>> 3
        const s1 = rotate(right, 17) ^ rotate(right, 19) ^ right >>> 10
        schedule[index] = (schedule[index - 16]! + s0 + schedule[index - 7]! + s1) | 0
      }
    }
    let [a,b,c,d,e,f,g,h] = hash as [number,number,number,number,number,number,number,number]
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)
      const choice = e & f ^ ~e & g
      const first = (h + s1 + choice + constants[index]! + schedule[index]!) | 0
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)
      const majority = a & b ^ a & c ^ b & c
      const second = (s0 + majority) | 0
      h=g; g=f; f=e; e=(d+first)|0; d=c; c=b; b=a; a=(first+second)|0
    }
    const state = [a,b,c,d,e,f,g,h]
    for (let index = 0; index < 8; index += 1) hash[index] = (hash[index]! + state[index]!) | 0
  }
  return hash.map(value => (value >>> 0).toString(16).padStart(8, '0')).join('')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new IntegrityVerificationError('instruction_set_integrity_settings_invalid')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return '{' + Object.keys(record).sort()
      .map(key => JSON.stringify(key) + ':' + canonicalJson(record[key]))
      .join(',') + '}'
  }
  throw new IntegrityVerificationError('instruction_set_integrity_settings_invalid')
}

function wholeDigest(components: Record<string, string>, settings: Record<string, unknown>): string {
  let input = Object.keys(components).sort()
    .map(name => name + '\0' + components[name]!.slice('sha256:'.length) + '\n')
    .join('')
  if (Object.keys(settings).length > 0) {
    input += '\0settings\0' + sha256(canonicalJson(settings)) + '\n'
  }
  return 'sha256:' + sha256(input)
}

export function verifyIntegrity(loadedBytes: LoadedBytes, lock: ParsedLock): void {
  if (!Object.hasOwn(loadedBytes, 'settings')) {
    throw new IntegrityVerificationError('instruction_set_integrity_settings_missing')
  }
  if (loadedBytes.settings === null || Array.isArray(loadedBytes.settings) || typeof loadedBytes.settings !== 'object') {
    throw new IntegrityVerificationError('instruction_set_integrity_settings_invalid')
  }
  let hasDigest = false
  let locked: { instructionSetId: string; version: LockedVersion } | undefined
  for (const instructionSet of Object.values(lock.instructionSets)) {
    for (const profile of Object.values(instructionSet.profiles)) {
      for (const version of Object.values(profile.versions)) {
        if (version.digest === loadedBytes.digest) hasDigest = true
        if (loadedBytes.provenance
          && instructionSet.instructionSetId === loadedBytes.provenance.instructionSetId
          && version.profileVersionId === loadedBytes.provenance.profileVersionId) {
          locked = { instructionSetId: instructionSet.instructionSetId, version }
        }
      }
    }
  }
  if (!hasDigest) throw new IntegrityVerificationError('instruction_set_integrity_digest_unknown')
  if (!locked) throw new IntegrityVerificationError('instruction_set_integrity_provenance_mismatch')
  const lockedProvenance = {
    instructionSetId: locked.instructionSetId,
    profileVersionId: locked.version.profileVersionId,
    digest: locked.version.digest,
  }
  for (const provenance of [loadedBytes.provenance, loadedBytes.generatedProvenance]) {
    if (!provenance || provenance.instructionSetId !== lockedProvenance.instructionSetId
      || provenance.profileVersionId !== lockedProvenance.profileVersionId
      || provenance.digest !== lockedProvenance.digest) {
      throw new IntegrityVerificationError('instruction_set_integrity_provenance_mismatch')
    }
  }

  const names = Object.keys(loadedBytes.components).sort()
  if (names.join('\0') !== Object.keys(locked.version.components).sort().join('\0')) {
    throw new IntegrityVerificationError('instruction_set_integrity_component_set_mismatch')
  }
  const actualHashes: Record<string, string> = Object.create(null)
  for (const name of names) {
    actualHashes[name] = 'sha256:' + sha256(loadedBytes.components[name]!)
    if (actualHashes[name] !== locked.version.components[name]) {
      throw new IntegrityVerificationError('instruction_set_integrity_component_mismatch:' + name)
    }
  }
  if (wholeDigest(actualHashes, loadedBytes.settings) !== loadedBytes.digest) {
    throw new IntegrityVerificationError('instruction_set_integrity_digest_mismatch')
  }
}
`

const VERIFY_TEST = String.raw`import { IntegrityVerificationError, verifyIntegrity } from './verify.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function runVerifySelfCheck(): void {
  const digest = 'sha256:b71899f0e13a58405ecef8ed7b7e0930a32f40e799828f8716ea8ace8e8ca782'
  const provenance = { instructionSetId: 'set-check', profileVersionId: 'version-check', digest }
  const lock = { instructionSets: { check: { instructionSetId: provenance.instructionSetId, profiles: { profile: { versions: { v1: {
    profileVersionId: provenance.profileVersionId,
    digest,
    components: { a: 'sha256:2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881' },
  } } } } } } }
  verifyIntegrity({ components: { a: 'x' }, settings: {}, digest, provenance, generatedProvenance: provenance }, lock)
  let failure: unknown
  try { verifyIntegrity({ components: { a: 'x ' }, settings: {}, digest, provenance, generatedProvenance: provenance }, lock) } catch (error) { failure = error }
  assert(failure instanceof IntegrityVerificationError, 'verify Helper must reject changed bytes')
}
`

const HELPER_FILES: Record<string, string> = {
  'helpers/load.ts': LOAD_HELPER,
  'helpers/load.selfcheck.ts': LOAD_TEST,
  'helpers/provenance.ts': PROVENANCE_HELPER,
  'helpers/provenance.selfcheck.ts': PROVENANCE_TEST,
  'helpers/verify.ts': VERIFY_HELPER,
  'helpers/verify.selfcheck.ts': VERIFY_TEST,
}

const RETIRED_HELPERS = ['helpers/load.test.ts', 'helpers/provenance.test.ts', 'helpers/verify.test.ts']

export function managedHelperPaths(): string[] {
  return Object.keys(HELPER_FILES).sort()
}

function fingerprint(bytes: string): string {
  return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`
}

export function assertOutputConfined(out: string, destination: string): void {
  const lexicalRoot = resolve(out)
  const realRoot = realpathSync(lexicalRoot)
  const relativeDestination = relative(lexicalRoot, resolve(destination))
  if (relativeDestination === '..' || relativeDestination.startsWith(`..${sep}`) || isAbsolute(relativeDestination)) {
    throw new Error(`instruction_set_sync_out_escaped:${destination}`)
  }
  let ancestor = lexicalRoot
  for (const segment of relativeDestination.split(sep)) {
    ancestor = join(ancestor, segment)
    if (!existsSync(ancestor)) continue
    const realAncestor = realpathSync(ancestor)
    if (realAncestor !== realRoot && !realAncestor.startsWith(`${realRoot}${sep}`)) {
      throw new Error(`instruction_set_sync_out_escaped:${ancestor}`)
    }
  }
}

function writeAtomic(path: string, bytes: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === bytes) return
  mkdirSync(join(path, '..'), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  writeFileSync(temp, bytes)
  try { renameSync(temp, path) } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

export function renderGeneratedIndex(lock: InstructionSetLockV1): string {
  const imports: string[] = []
  const sets: string[] = []
  let importNumber = 0
  for (const setSlug of Object.keys(lock.instructionSets).sort()) {
    const profiles: string[] = []
    for (const profileSlug of Object.keys(lock.instructionSets[setSlug]!.profiles).sort()) {
      const profile = lock.instructionSets[setSlug]!.profiles[profileSlug]!
      const versions: string[] = []
      for (const [versionSlug] of Object.entries(profile.versions).sort((left, right) => left[1].versionNumber - right[1].versionNumber)) {
        const identifier = `v${importNumber}`
        importNumber += 1
        imports.push(`import * as ${identifier} from '../instruction-sets/${setSlug}/${profileSlug}/${versionSlug}/components.generated.js'`)
        versions.push(`${JSON.stringify(versionSlug)}: ${identifier}`)
      }
      profiles.push(`${JSON.stringify(profileSlug)}: { ${versions.join(', ')} }`)
    }
    sets.push(`${JSON.stringify(setSlug)}: { ${profiles.join(', ')} }`)
  }
  const lockJsonLiteral = JSON.stringify(serializeLock(lock).trimEnd())
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
    .replace(/</gu, '\\u003c')
  const lockType = `interface GeneratedLock {
  lockfileVersion: 1
  project: string
  helpers?: Record<string, string>
  instructionSets: Record<string, {
    instructionSetId: string
    default: string
    profiles: Record<string, {
      production: string | null
      versions: Record<string, {
        profileVersionId: string
        versionNumber: number
        digest: string
        components: Record<string, string>
        syncedAt: string
      }>
    }>
  }>
}`
  return `// @generated\n${imports.join('\n')}\n\n${lockType}\n\nexport const versions = { ${sets.join(', ')} } as const\n\nexport const lock = JSON.parse(${lockJsonLiteral}) as GeneratedLock\n`
}

export function reconcileGeneratedIndex(appRoot: string, lock: InstructionSetLockV1): void {
  writeAtomic(join(appRoot, 'generated', 'index.ts'), renderGeneratedIndex(lock))
}

function addGeneratedAttribute(out: string): void {
  const path = join(out, '.gitattributes')
  const line = 'orizu/generated/** linguist-generated=true'
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (existing.split(/\r?\n/u).includes(line)) return
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  writeAtomic(path, `${existing}${separator}${line}\n`)
}

export function emitManagedArtifacts(
  out: string,
  appRoot: string,
  lock: InstructionSetLockV1,
  forceHelpers: boolean,
  target: SyncTarget
): string[] {
  if (target !== 'ts') throw new Error(`instruction_set_sync_target_unsupported:${String(target)}`)
  const warnings: string[] = []
  const managedPaths = [
    ...[...Object.keys(HELPER_FILES), ...RETIRED_HELPERS].map(relative => join(appRoot, ...relative.split('/'))),
    join(appRoot, 'generated', 'index.ts'),
    join(out, '.gitattributes'),
  ]
  for (const path of managedPaths) assertOutputConfined(out, path)

  const priorFingerprints = lock.helpers ?? {}
  const nextFingerprints = { ...priorFingerprints }
  for (const relative of RETIRED_HELPERS) {
    const path = join(appRoot, ...relative.split('/'))
    const priorFingerprint = priorFingerprints[relative]
    if (existsSync(path) && (priorFingerprint === undefined || fingerprint(readFileSync(path, 'utf8')) !== priorFingerprint)) {
      warnings.push(`Helper ${relative} differs from its pristine fingerprint; preserving the edited file.`)
      continue
    }
    rmSync(path, { force: true })
    delete nextFingerprints[relative]
  }
  for (const [relative, bytes] of Object.entries(HELPER_FILES)) {
    const path = join(appRoot, ...relative.split('/'))
    const priorFingerprint = priorFingerprints[relative]
    const currentFingerprint = fingerprint(bytes)
    const existingFingerprint = existsSync(path) ? fingerprint(readFileSync(path, 'utf8')) : null
    const isEdited = existingFingerprint !== null
      && existingFingerprint !== priorFingerprint
      && existingFingerprint !== currentFingerprint
    if (isEdited && !forceHelpers) {
      warnings.push(`Helper ${relative} differs from its pristine fingerprint; preserving the edited file (use --force-helpers to overwrite).`)
      continue
    }
    writeAtomic(path, bytes)
    nextFingerprints[relative] = currentFingerprint
  }
  lock.helpers = nextFingerprints
  reconcileGeneratedIndex(appRoot, lock)
  addGeneratedAttribute(out)
  return warnings
}
