import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { parseLock, type InstructionSetLockV1, type SyncedVersionLock } from '../instruction-set-lock/index.js'
import { MODEL_CONFIG_FIELDS } from '../model-config-fields.js'
import { managedHelperPaths, renderGeneratedIndex } from '../instruction-set-sync/helpers.js'
import { canonicalVersionDigest, profileSlug, renderGeneratedVersionModule } from '../instruction-set-sync/index.js'

export type VerifyGroup = 'group1' | 'group2' | 'group3' | 'group4'
export type VerifyGroupStatus = 'PASS' | 'FAIL' | 'SKIPPED'

export interface VerifyFinding {
  group: VerifyGroup
  code: string
  path: string
  expected?: string
  found?: string
}

export interface VerifyReport {
  ok: boolean
  groups: Record<VerifyGroup, VerifyGroupStatus>
  failures: VerifyFinding[]
  warnings: VerifyFinding[]
}

interface VersionLocation {
  setSlug: string
  profileSlug: string
  versionSlug: string
  relativePath: string
  absolutePath: string
}

interface VersionManifest {
  instructionSetId: string
  instructionSetSlug: string
  profileVersionId: string
  modelConfigIdentity: string
  profileSlug: string
  versionNumber: number
  digest: string
  components: Record<string, string>
  settings: Record<string, unknown>
  provenance: {
    instructionSetId: string
    profileVersionId: string
    digest: string
  }
}

interface GeneratedVersionModule {
  components: Record<string, string>
  manifest: VersionManifest
}

interface HelperRequest {
  specifier: string
  kind: 'exact' | 'default' | 'profile'
  path: string
  expectedInstructionSetId: string
  expectedProfileVersionId: string
  expectedDigest: string
  expectedModelConfigIdentity: string
}

interface HelperExecutionResult {
  results: HelperCheckResult[]
  unknownRejection: string | null
  malformedRejection: string | null
  modelConfigRejection: string | null
}

interface HelperCheckResult {
  specifier: string
  kind: 'exact' | 'default' | 'profile'
  loaded?: {
    components?: Record<string, string>
    settings?: Record<string, unknown>
    provenance?: { instructionSetId?: string; profileVersionId?: string; digest?: string }
  }
  modelConfig?: Record<string, unknown>
  loadError?: string
  modelConfigError?: string
  validRejection?: string
  corruptBytesRejection?: string
  wrongDigestRejection?: string
}

interface StaticImportMap {
  imports: Map<string, string>
  versions: Record<string, Record<string, Record<string, string>>>
}

class StaticObjectParser {
  private index = 0

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.parseValue()
    this.skipWhitespace()
    if (this.index !== this.source.length) throw new Error('trailing_tokens')
    return value
  }

  private parseValue(): unknown {
    this.skipWhitespace()
    if (this.source[this.index] === '{') return this.parseObject()
    if (this.source[this.index] === '"') return this.parseString()
    return this.parseIdentifier()
  }

  private parseObject(): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    this.expect('{')
    this.skipWhitespace()
    if (this.source[this.index] === '}') {
      this.index += 1
      return result
    }
    while (true) {
      const key = this.parseString()
      this.skipWhitespace()
      this.expect(':')
      result[key] = this.parseValue()
      this.skipWhitespace()
      const token = this.source[this.index]
      if (token === '}') {
        this.index += 1
        return result
      }
      this.expect(',')
    }
  }

  private parseString(): string {
    const start = this.index
    this.expect('"')
    let isEscaped = false
    while (this.index < this.source.length) {
      const character = this.source[this.index]!
      this.index += 1
      if (character === '"' && !isEscaped) {
        return JSON.parse(this.source.slice(start, this.index)) as string
      }
      isEscaped = character === '\\' && !isEscaped
      if (character !== '\\') isEscaped = false
    }
    throw new Error('unterminated_string')
  }

  private parseIdentifier(): string {
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(this.source.slice(this.index))
    if (!match) throw new Error('identifier_expected')
    this.index += match[0].length
    return match[0]
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.source[this.index] ?? '')) this.index += 1
  }

  private expect(token: string): void {
    this.skipWhitespace()
    if (this.source[this.index] !== token) throw new Error(`${token}_expected`)
    this.index += 1
  }
}

function staticImportMap(source: string): StaticImportMap {
  const imports = new Map<string, string>()
  const importPattern = /^import \* as ([A-Za-z_$][A-Za-z0-9_$]*) from '([^']+)'$/gmu
  for (const match of source.matchAll(importPattern)) imports.set(match[1]!, match[2]!)
  const versionsMatch = /^export const versions = (.+) as const$/mu.exec(source)
  if (!versionsMatch) throw new Error('versions_export_missing')
  const parsed = new StaticObjectParser(versionsMatch[1]!).parse()
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('versions_export_invalid')
  const versions: Record<string, Record<string, Record<string, string>>> = {}
  for (const [setSlug, profilesValue] of Object.entries(parsed as Record<string, unknown>)) {
    if (!profilesValue || typeof profilesValue !== 'object' || Array.isArray(profilesValue)) throw new Error('profiles_map_invalid')
    const profiles: Record<string, Record<string, string>> = {}
    for (const [profileSlug, versionsValue] of Object.entries(profilesValue as Record<string, unknown>)) {
      if (!versionsValue || typeof versionsValue !== 'object' || Array.isArray(versionsValue)) throw new Error('versions_map_invalid')
      const mappedVersions: Record<string, string> = {}
      for (const [versionSlug, identifier] of Object.entries(versionsValue as Record<string, unknown>)) {
        if (typeof identifier !== 'string') throw new Error('version_import_invalid')
        mappedVersions[versionSlug] = identifier
      }
      profiles[profileSlug] = mappedVersions
    }
    versions[setSlug] = profiles
  }
  return { imports, versions }
}

function hash(bytes: string | Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

function directoryNames(path: string): string[] {
  if (!isDirectory(path)) return []
  return readdirSync(path).filter(name => isDirectory(join(path, name))).sort()
}

function versionLocations(appRoot: string): VersionLocation[] {
  const instructionSetsRoot = join(appRoot, 'instruction-sets')
  return directoryNames(instructionSetsRoot).flatMap(setSlug =>
    directoryNames(join(instructionSetsRoot, setSlug)).flatMap(profileSlug =>
      directoryNames(join(instructionSetsRoot, setSlug, profileSlug)).map(versionSlug => ({
        setSlug,
        profileSlug,
        versionSlug,
        relativePath: `instruction-sets/${setSlug}/${profileSlug}/${versionSlug}`,
        absolutePath: join(instructionSetsRoot, setSlug, profileSlug, versionSlug),
      }))
    )
  )
}

function manifestValue(value: unknown): VersionManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const manifest = value as Record<string, unknown>
  if (
    typeof manifest.instructionSetId !== 'string' ||
    typeof manifest.instructionSetSlug !== 'string' ||
    typeof manifest.profileVersionId !== 'string' ||
    typeof manifest.modelConfigIdentity !== 'string' ||
    typeof manifest.profileSlug !== 'string' ||
    typeof manifest.versionNumber !== 'number' ||
    typeof manifest.digest !== 'string' ||
    !manifest.settings || typeof manifest.settings !== 'object' || Array.isArray(manifest.settings) ||
    !manifest.components || typeof manifest.components !== 'object' || Array.isArray(manifest.components) ||
    !Object.values(manifest.components).every(item => typeof item === 'string') ||
    !manifest.provenance || typeof manifest.provenance !== 'object' || Array.isArray(manifest.provenance) ||
    typeof (manifest.provenance as Record<string, unknown>).instructionSetId !== 'string' ||
    typeof (manifest.provenance as Record<string, unknown>).profileVersionId !== 'string' ||
    typeof (manifest.provenance as Record<string, unknown>).digest !== 'string'
  ) return null
  return manifest as unknown as VersionManifest
}

function readManifest(location: VersionLocation): VersionManifest | null {
  try {
    return manifestValue(JSON.parse(readFileSync(join(location.absolutePath, 'manifest.json'), 'utf8')))
  } catch {
    return null
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function finding(
  group: VerifyGroup,
  code: string,
  path: string,
  expected?: unknown,
  found?: unknown
): VerifyFinding {
  return {
    group,
    code,
    path,
    ...(expected !== undefined ? { expected: String(expected) } : {}),
    ...(found !== undefined ? { found: String(found) } : {}),
  }
}

function recordMismatch(
  failures: VerifyFinding[],
  group: VerifyGroup,
  code: string,
  path: string,
  expected: unknown,
  found: unknown
): void {
  if (expected !== found) failures.push(finding(group, code, path, expected, found))
}

function lockedVersions(lock: InstructionSetLockV1, appRoot: string): Array<VersionLocation & {
  instructionSetId: string
  version: SyncedVersionLock
}> {
  return Object.entries(lock.instructionSets).flatMap(([setSlug, set]) =>
    Object.entries(set.profiles).flatMap(([profileSlug, profile]) =>
      Object.entries(profile.versions).map(([versionSlug, version]) => ({
        setSlug,
        profileSlug,
        versionSlug,
        version,
        instructionSetId: set.instructionSetId,
        relativePath: `instruction-sets/${setSlug}/${profileSlug}/${versionSlug}`,
        absolutePath: join(appRoot, 'instruction-sets', setSlug, profileSlug, versionSlug),
      }))
    )
  )
}

const CUSTOMER_MODULE_TIMEOUT_MS = 1_500

class CustomerModuleError extends Error {
  constructor(readonly code: 'helper_import_failed' | 'helper_import_timeout', readonly modulePath: string, detail?: string) {
    super(detail ?? code)
    this.name = 'CustomerModuleError'
  }
}

async function runCustomerModule<T>(source: string, resolveDir: string, modulePath: string): Promise<T> {
  let result
  try {
    const { build } = await import('esbuild')
    result = await build({
      stdin: { contents: source, resolveDir, loader: 'ts' },
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      write: false,
    })
  } catch (error) {
    throw new CustomerModuleError('helper_import_failed', modulePath, errorText(error))
  }
  const compiled = result.outputFiles[0]?.contents
  if (!compiled) throw new CustomerModuleError('helper_import_failed', modulePath, 'instruction_set_module_compile_failed')
  const directory = mkdtempSync(join(tmpdir(), 'orizu-verify-module-'))
  const compiledPath = join(directory, 'module.mjs')
  writeFileSync(compiledPath, compiled)
  try {
    // Scrubbed probe environment: only locale-neutral, non-secret variables reach customer modules.
    const childEnvironment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? 'production', NO_COLOR: process.env.NO_COLOR ?? '1' }
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP'] as const) {
      if (process.env[name] !== undefined) childEnvironment[name] = process.env[name]
    }
    const child = spawnSync('node', [compiledPath], {
      encoding: 'utf8',
      env: childEnvironment,
      timeout: CUSTOMER_MODULE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    })
    if (child.error && (child.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new CustomerModuleError('helper_import_timeout', modulePath)
    }
    if (child.error) {
      throw new CustomerModuleError('helper_import_failed', modulePath, errorText(child.error))
    }
    if (child.status !== 0) {
      throw new CustomerModuleError('helper_import_failed', modulePath, child.stderr.trim() || `node_exit_${child.status}`)
    }
    try {
      return JSON.parse(child.stdout) as T
    } catch (error) {
      throw new CustomerModuleError('helper_import_failed', modulePath, `invalid_child_output:${errorText(error)}`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

async function importGeneratedVersion(path: string): Promise<GeneratedVersionModule> {
  return runCustomerModule<GeneratedVersionModule>(
    `import * as target from ${JSON.stringify(path)}; process.stdout.write(JSON.stringify({ components: target.components, manifest: target.manifest }));`,
    join(path, '..'),
    path
  )
}

async function importGeneratedLock(path: string): Promise<unknown> {
  return runCustomerModule<unknown>(
    `import * as target from ${JSON.stringify(path)}; process.stdout.write(JSON.stringify(target.lock));`,
    join(path, '..'),
    path
  )
}

async function checkHelperExport(path: string, exportName: string): Promise<boolean> {
  return runCustomerModule<boolean>(
    `import * as target from ${JSON.stringify(path)}; process.stdout.write(JSON.stringify(typeof target[${JSON.stringify(exportName)}] === 'function'));`,
    join(path, '..'),
    path
  )
}

function componentRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  return Object.values(record).every(item => typeof item === 'string')
    ? record as Record<string, string>
    : null
}

function checkGroup1(
  locations: VersionLocation[],
  lock: InstructionSetLockV1,
  manifests: Map<string, VersionManifest>,
  failures: VerifyFinding[]
): void {
  for (const location of locations) {
    const manifestPath = `${location.relativePath}/manifest.json`
    const manifest = readManifest(location)
    if (!manifest) {
      failures.push(finding('group1', 'version_manifest_invalid', manifestPath))
      continue
    }
    manifests.set(location.relativePath, manifest)
    const locked = lock.instructionSets[location.setSlug]?.profiles[location.profileSlug]?.versions[location.versionSlug]
    if (!locked) continue
    recordMismatch(failures, 'group1', 'manifest_instruction_set_slug_mismatch', manifestPath, location.setSlug, manifest.instructionSetSlug)
    recordMismatch(failures, 'group1', 'manifest_profile_slug_mismatch', manifestPath, location.profileSlug, manifest.profileSlug)
    recordMismatch(failures, 'group1', 'manifest_profile_identity_mismatch', manifestPath, location.profileSlug, profileSlug(manifest.modelConfigIdentity))
    recordMismatch(failures, 'group1', 'manifest_version_slug_mismatch', manifestPath, location.versionSlug, `v${manifest.versionNumber}`)
    recordMismatch(failures, 'group1', 'manifest_instruction_set_id_mismatch', manifestPath, lock.instructionSets[location.setSlug]!.instructionSetId, manifest.instructionSetId)
    recordMismatch(failures, 'group1', 'manifest_profile_version_id_mismatch', manifestPath, locked.profileVersionId, manifest.profileVersionId)
    recordMismatch(failures, 'group1', 'manifest_version_number_mismatch', manifestPath, locked.versionNumber, manifest.versionNumber)
    recordMismatch(failures, 'group1', 'manifest_digest_mismatch', manifestPath, locked.digest, manifest.digest)
    recordMismatch(failures, 'group1', 'manifest_provenance_instruction_set_id_mismatch', manifestPath, lock.instructionSets[location.setSlug]!.instructionSetId, manifest.provenance.instructionSetId)
    recordMismatch(failures, 'group1', 'manifest_provenance_profile_version_id_mismatch', manifestPath, locked.profileVersionId, manifest.provenance.profileVersionId)
    recordMismatch(failures, 'group1', 'manifest_provenance_digest_mismatch', manifestPath, locked.digest, manifest.provenance.digest)
  }
}

async function checkGroup2(
  versions: ReturnType<typeof lockedVersions>,
  manifests: Map<string, VersionManifest>,
  failures: VerifyFinding[],
  importGeneratedModule: boolean
): Promise<void> {
  for (const location of versions) {
    if (!isDirectory(location.absolutePath)) continue
    const manifest = manifests.get(location.relativePath)
    if (!manifest) continue
    const actualHashes: Record<string, string> = Object.create(null)
    const actualBytes: Record<string, string> = Object.create(null)
    const componentsRoot = join(location.absolutePath, 'components')
    if (isDirectory(componentsRoot)) {
      for (const filename of readdirSync(componentsRoot).sort()) {
        const absoluteComponentPath = join(componentsRoot, filename)
        if (!statSync(absoluteComponentPath).isFile() || !filename.endsWith('.prompt.md')) continue
        const name = filename.slice(0, -'.prompt.md'.length)
        if (!Object.hasOwn(location.version.components, name)) {
          failures.push(finding(
            'group2',
            `component_unexpected:${name}`,
            `${location.relativePath}/components/${filename}`,
            'absent',
            hash(readFileSync(absoluteComponentPath))
          ))
        }
      }
    }
    for (const [name, lockedHash] of Object.entries(location.version.components)) {
      const componentPath = `${location.relativePath}/components/${name}.prompt.md`
      const absoluteComponentPath = join(location.absolutePath, 'components', `${name}.prompt.md`)
      if (!existsSync(absoluteComponentPath)) {
        failures.push(finding('group2', 'component_missing', componentPath, lockedHash, 'missing'))
        continue
      }
      let bytes: Buffer
      try {
        if (!statSync(absoluteComponentPath).isFile()) {
          failures.push(finding('group2', 'component_not_regular_file', componentPath, 'regular readable file', 'non-file'))
          continue
        }
        bytes = readFileSync(absoluteComponentPath)
      } catch (error) {
        failures.push(finding('group2', 'component_unreadable', componentPath, 'readable file', errorText(error)))
        continue
      }
      const foundHash = hash(bytes)
      actualHashes[name] = foundHash
      actualBytes[name] = bytes.toString('utf8')
      recordMismatch(failures, 'group2', 'component_hash_mismatch', componentPath, lockedHash, foundHash)
      recordMismatch(failures, 'group2', 'manifest_component_hash_mismatch', componentPath, lockedHash, manifest.components[name] ?? 'missing')
    }
    for (const name of Object.keys(manifest.components)) {
      if (!Object.hasOwn(location.version.components, name)) {
        failures.push(finding('group2', 'manifest_component_not_locked', `${location.relativePath}/manifest.json`, 'absent', name))
      }
    }
    if (Object.keys(actualHashes).length === Object.keys(location.version.components).length) {
      const foundDigest = canonicalVersionDigest(actualHashes, manifest.settings)
      recordMismatch(failures, 'group2', 'version_digest_mismatch', `${location.relativePath}/manifest.json`, location.version.digest, foundDigest)
    }

    const generatedPath = `${location.relativePath}/components.generated.ts`
    const absoluteGeneratedPath = join(location.absolutePath, 'components.generated.ts')
    if (!existsSync(absoluteGeneratedPath)) {
      failures.push(finding('group2', 'generated_components_missing', generatedPath))
      continue
    }
    try {
      const generatedSource = readFileSync(absoluteGeneratedPath, 'utf8')
      const expectedSource = renderGeneratedVersionModule(actualBytes, manifest)
      if (generatedSource !== expectedSource) {
        failures.push(finding('group2', 'generated_module_drift', generatedPath))
        continue
      }
      if (!importGeneratedModule) continue
      if (failures.some(failure => failure.group === 'group2' && failure.path.startsWith(location.relativePath))) continue
      const importedModule = await importGeneratedVersion(absoluteGeneratedPath)
      const generated = componentRecord(importedModule.components)
      if (!generated) {
        failures.push(finding('group2', 'generated_components_invalid', generatedPath))
        continue
      }
      const generatedManifest = manifestValue(importedModule.manifest)
      if (!generatedManifest) {
        failures.push(finding('group2', 'generated_manifest_invalid', generatedPath))
      } else {
        const generatedRecord = generatedManifest as unknown as Record<string, unknown>
        const diskRecord = manifest as unknown as Record<string, unknown>
        const fields = [...new Set([...Object.keys(generatedRecord), ...Object.keys(diskRecord)])].sort()
        for (const field of fields) {
          if (!isDeepStrictEqual(generatedRecord[field], diskRecord[field])) {
            failures.push(finding('group2', `generated_manifest_mismatch:${field}`, generatedPath))
          }
        }
        for (const field of ['instructionSetId', 'profileVersionId', 'digest'] as const) {
          if (generatedManifest.provenance[field] !== manifest.provenance[field]) {
            failures.push(finding('group2', `generated_manifest_mismatch:provenance.${field}`, generatedPath))
          }
        }
      }
      const names = [...new Set([...Object.keys(actualBytes), ...Object.keys(generated)])].sort()
      for (const name of names) {
        if (actualBytes[name] !== generated[name]) {
          failures.push(finding(
            'group2',
            'generated_component_mismatch',
            generatedPath,
            actualBytes[name] === undefined ? 'missing' : hash(actualBytes[name]),
            generated[name] === undefined ? 'missing' : hash(generated[name])
          ))
        }
      }
    } catch (error) {
      const code = error instanceof CustomerModuleError ? error.code : 'generated_components_import_failed'
      failures.push(finding('group2', code, generatedPath, undefined, errorText(error)))
    }
  }
}

export class InstructionSetUpdateGateProfileIdentityError extends Error {
  readonly code: string

  constructor(
    specifier: string,
    readonly expected: string,
    readonly found: string,
    readonly manifestPath: string
  ) {
    const code = `instruction_set_update_gate_profile_identity_mismatch:${specifier}`
    super(`${code}; expected ${expected}, manifest ${manifestPath} records ${found}`)
    this.name = 'InstructionSetUpdateGateProfileIdentityError'
    this.code = code
  }
}

// Runs group 1 plus the pure group-2 checks; never executes customer code.
export async function verifyMaterializedVersionAgainstLock(
  appRoot: string,
  lock: InstructionSetLockV1,
  setSlug: string,
  profileSlugValue: string,
  versionSlug: string
): Promise<VerifyFinding[]> {
  const versions = lockedVersions(lock, appRoot).filter(version =>
    version.setSlug === setSlug
    && version.profileSlug === profileSlugValue
    && version.versionSlug === versionSlug
  )
  if (versions.length === 0) throw new Error('instruction_set_update_gate_no_versions')
  const failures: VerifyFinding[] = []
  const manifests = new Map<string, VersionManifest>()
  checkGroup1(versions, lock, manifests, failures)
  const expectedIdentity = lock.instructionSets[setSlug]?.profiles[profileSlugValue]?.modelConfigIdentity
  if (expectedIdentity !== undefined) {
    for (const version of versions) {
      const foundIdentity = manifests.get(version.relativePath)?.modelConfigIdentity
      if (foundIdentity !== undefined && foundIdentity !== expectedIdentity) {
        throw new InstructionSetUpdateGateProfileIdentityError(
          `${setSlug}/${expectedIdentity}@${version.versionSlug}`,
          expectedIdentity,
          foundIdentity,
          `${version.relativePath}/manifest.json`
        )
      }
    }
  }
  await checkGroup2(versions, manifests, failures, false)
  return failures
}

async function runHelperChecks(
  appRoot: string,
  loadPath: string,
  verifyPath: string,
  modelConfigPath: string,
  lock: InstructionSetLockV1,
  requests: HelperRequest[]
): Promise<HelperExecutionResult> {
  const source = `
import { loadInstructions } from ${JSON.stringify(loadPath)}
import { verifyIntegrity } from ${JSON.stringify(verifyPath)}
import { loadModelConfig } from ${JSON.stringify(modelConfigPath)}
const lock = JSON.parse(${JSON.stringify(JSON.stringify(lock))})
const requests = JSON.parse(${JSON.stringify(JSON.stringify(requests.map(({ specifier, kind }) => ({ specifier, kind }))))})
function rejection(run) {
  try { run(); return null } catch (error) {
    return typeof error?.code === 'string' && error.code.length > 0 ? error.code : '__unnamed__'
  }
}
const results = []
for (const request of requests) {
  try {
    const loaded = loadInstructions(request.specifier)
    const input = { ...loaded, digest: loaded?.provenance?.digest }
    const result = { ...request, loaded, validRejection: rejection(() => verifyIntegrity(input, lock)) }
    if (request.kind === 'exact') {
      const modelConfigFailure = rejection(() => { result.modelConfig = loadModelConfig(request.specifier) })
      if (modelConfigFailure) result.modelConfigError = modelConfigFailure
      const firstName = Object.keys(loaded.components)[0]
      const corruptComponents = { ...loaded.components, [firstName]: loaded.components[firstName] + '\\0' }
      result.corruptBytesRejection = rejection(() => verifyIntegrity({ ...input, components: corruptComponents }, lock))
      const wrongDigest = 'sha256:' + '0'.repeat(64)
      result.wrongDigestRejection = rejection(() => verifyIntegrity({
        ...input,
        digest: wrongDigest,
        provenance: { ...loaded.provenance, digest: wrongDigest },
      }, lock))
    }
    results.push(result)
  } catch (error) {
    results.push({ ...request, loadError: typeof error?.code === 'string' ? error.code : String(error) })
  }
}
const unknownRejection = rejection(() => loadInstructions('orizu-verifier-unknown'))
const malformedRejection = rejection(() => loadInstructions('bad set/'))
const modelConfigRejection = rejection(() => loadModelConfig('orizu-verifier-unknown'))
process.stdout.write(JSON.stringify({ results, unknownRejection, malformedRejection, modelConfigRejection }))
`
  return runCustomerModule<HelperExecutionResult>(source, appRoot, 'helpers/load.ts')
}

function modelConfigSetting(settings: Record<string, unknown>, key: string): { present: boolean; value?: unknown } {
  const dot = key.indexOf('.')
  if (dot < 0) return Object.hasOwn(settings, key) && settings[key] !== null
    ? { present: true, value: settings[key] }
    : { present: false }
  const parent = settings[key.slice(0, dot)]
  const child = key.slice(dot + 1)
  return parent !== null && typeof parent === 'object' && !Array.isArray(parent)
    && Object.hasOwn(parent, child) && (parent as Record<string, unknown>)[child] !== null
    ? { present: true, value: (parent as Record<string, unknown>)[child] }
    : { present: false }
}

function modelConfigFindingValue(field: string, value: unknown): string {
  if (value === undefined) return `${field}=absent`
  if (typeof value === 'string') return `${field}=${value}`
  return `${field}=${JSON.stringify(value)}`
}

async function checkGroup3(
  appRoot: string,
  lock: InstructionSetLockV1,
  versions: ReturnType<typeof lockedVersions>,
  manifests: Map<string, VersionManifest>,
  failures: VerifyFinding[]
): Promise<void> {
  if (failures.some(failure => failure.group === 'group2')) return
  const importMapPath = join(appRoot, 'generated', 'index.ts')
  if (existsSync(importMapPath) && readFileSync(importMapPath, 'utf8') !== renderGeneratedIndex(lock)) return

  const loadPath = join(appRoot, 'helpers', 'load.ts')
  const verifyPath = join(appRoot, 'helpers', 'verify.ts')
  const modelConfigPath = join(appRoot, 'helpers', 'model-config.ts')
  const absent = [loadPath, verifyPath, modelConfigPath].filter(path => !existsSync(path))
  if (absent.length > 0) {
    failures.push(finding('group3', 'helpers_missing', 'helpers', 'load.ts,verify.ts,model-config.ts', absent.map(path => relative(appRoot, path)).join(',')))
    return
  }

  try {
    const loadValid = await checkHelperExport(loadPath, 'loadInstructions')
    const verifyValid = await checkHelperExport(verifyPath, 'verifyIntegrity')
    const modelConfigValid = await checkHelperExport(modelConfigPath, 'loadModelConfig')
    if (!loadValid || !verifyValid || !modelConfigValid) {
      failures.push(finding('group3', 'helper_exports_invalid', 'helpers'))
      return
    }
  } catch (error) {
    const customerError = error instanceof CustomerModuleError ? error : null
    failures.push(finding(
      'group3',
      customerError?.code ?? 'helper_import_failed',
      customerError ? relative(appRoot, customerError.modulePath) : 'helpers',
      undefined,
      errorText(error)
    ))
    return
  }

  const requests: HelperRequest[] = []
  for (const [setSlug, set] of Object.entries(lock.instructionSets)) {
    for (const [profileSlug, profile] of Object.entries(set.profiles)) {
      if (profile.modelConfigIdentity === undefined) {
        failures.push(finding('group3', 'model_config_identity_unbound', `instruction-sets/${setSlug}/${profileSlug}`))
      }
    }
  }
  for (const location of versions) {
    if (!isDirectory(location.absolutePath)) continue
    const manifest = manifests.get(location.relativePath)
    if (!manifest) continue
    requests.push({
      specifier: `${location.setSlug}/${manifest.modelConfigIdentity}@v${location.version.versionNumber}`,
      kind: 'exact',
      path: location.relativePath,
      expectedInstructionSetId: location.instructionSetId,
      expectedProfileVersionId: location.version.profileVersionId,
      expectedDigest: location.version.digest,
      expectedModelConfigIdentity: lock.instructionSets[location.setSlug]?.profiles[location.profileSlug]?.modelConfigIdentity ?? manifest.modelConfigIdentity,
    })
  }
  for (const [setSlug, set] of Object.entries(lock.instructionSets)) {
    const defaultProfile = set.profiles[set.default]
    if (defaultProfile?.production) {
      const version = defaultProfile.versions[defaultProfile.production]
      if (version) requests.push({
        specifier: setSlug,
        kind: 'default',
        path: `instruction-sets/${setSlug}/${set.default}/${defaultProfile.production}`,
        expectedInstructionSetId: set.instructionSetId,
        expectedProfileVersionId: version.profileVersionId,
        expectedDigest: version.digest,
        expectedModelConfigIdentity: defaultProfile.modelConfigIdentity
          ?? manifests.get(`instruction-sets/${setSlug}/${set.default}/${defaultProfile.production}`)?.modelConfigIdentity
          ?? '',
      })
    }
    for (const [profileSlug, profile] of Object.entries(set.profiles)) {
      if (!profile.production) continue
      const version = profile.versions[profile.production]
      const manifest = manifests.get(`instruction-sets/${setSlug}/${profileSlug}/${profile.production}`)
      if (!version || !manifest) continue
      requests.push({
        specifier: `${setSlug}/${manifest.modelConfigIdentity}`,
        kind: 'profile',
        path: `instruction-sets/${setSlug}/${profileSlug}/${profile.production}`,
        expectedInstructionSetId: set.instructionSetId,
        expectedProfileVersionId: version.profileVersionId,
        expectedDigest: version.digest,
        expectedModelConfigIdentity: profile.modelConfigIdentity ?? manifest.modelConfigIdentity,
      })
    }
  }

  let execution: HelperExecutionResult
  try {
    execution = await runHelperChecks(appRoot, loadPath, verifyPath, modelConfigPath, lock, requests)
  } catch (error) {
    const customerError = error instanceof CustomerModuleError ? error : null
    failures.push(finding('group3', customerError?.code ?? 'helper_import_failed', customerError?.modulePath ?? 'helpers', undefined, errorText(error)))
    return
  }
  const expectedRejection = 'instruction_set_specifier_unknown'
  if (execution.unknownRejection !== expectedRejection || execution.malformedRejection !== expectedRejection) {
    failures.push(finding(
      'group3',
      'helper_rejection_inert',
      'helpers/load.ts',
      `${expectedRejection},${expectedRejection}`,
      `${execution.unknownRejection ?? 'accepted'},${execution.malformedRejection ?? 'accepted'}`
    ))
  }
  if (execution.modelConfigRejection !== expectedRejection) {
    failures.push(finding(
      'group3',
      'helper_rejection_inert',
      'helpers/model-config.ts',
      expectedRejection,
      execution.modelConfigRejection ?? 'accepted'
    ))
  }
  for (const request of requests) {
    const result = execution.results.find(candidate => candidate.specifier === request.specifier && candidate.kind === request.kind)
    if (!result || result.loadError) {
      failures.push(finding('group3', request.kind === 'exact' ? 'load_failed' : 'pointer_load_failed', request.path, request.specifier, result?.loadError ?? 'missing child result'))
      continue
    }
    if (request.kind === 'exact' && result.modelConfigError) {
      failures.push(finding('group3', 'model_config_load_failed', request.path, request.specifier, result.modelConfigError))
      continue
    }
    const identitySlash = request.expectedModelConfigIdentity.indexOf('/')
    const expectedProvider = identitySlash < 0
      ? request.expectedModelConfigIdentity
      : request.expectedModelConfigIdentity.slice(0, identitySlash)
    const expectedModel = typeof result.loaded?.settings?.model === 'string'
      ? result.loaded.settings.model
      : identitySlash < 0
        ? request.expectedModelConfigIdentity
        : request.expectedModelConfigIdentity.slice(identitySlash + 1)
    const settings = result.loaded?.settings ?? {}
    const hydratedFields = MODEL_CONFIG_FIELDS.map(definition => {
      const found = definition.settingsKeys.map(key => modelConfigSetting(settings, key)).find(item => item.present)
      const expected = definition.field === 'MODEL' && !found ? expectedModel : found?.value
      return [definition.field, expected, result.modelConfig?.[definition.field]] as const
    })
    const modelConfigComparisons = [
      ['CONFIG_IDENTITY', request.expectedModelConfigIdentity, result.modelConfig?.CONFIG_IDENTITY],
      ['PROVIDER', expectedProvider, result.modelConfig?.PROVIDER],
      ...hydratedFields,
      ['RAW', settings, result.modelConfig?.RAW],
    ] as const
    const mismatchedModelConfigFields = request.kind === 'exact'
      ? modelConfigComparisons.filter(([, expected, found]) => !isDeepStrictEqual(found, expected))
      : []
    for (const [field, expected, found] of mismatchedModelConfigFields) {
      failures.push(finding('group3', field === 'CONFIG_IDENTITY' || field === 'PROVIDER' || field === 'MODEL'
        ? 'model_config_identity_mismatch' : 'model_config_field_mismatch', request.path,
      modelConfigFindingValue(field, expected), modelConfigFindingValue(field, found)))
    }
    if (mismatchedModelConfigFields.length > 0) continue
    if (
      result.loaded?.provenance?.instructionSetId !== request.expectedInstructionSetId ||
      result.loaded?.provenance?.profileVersionId !== request.expectedProfileVersionId ||
      result.loaded?.provenance?.digest !== request.expectedDigest
    ) {
      failures.push(finding('group3', 'helper_provenance_mismatch', request.path))
      continue
    }
    if (result.validRejection) {
      failures.push(finding('group3', 'integrity_failed', request.path, undefined, result.validRejection))
      continue
    }
    if (request.kind === 'exact' && (
      !result.corruptBytesRejection || result.corruptBytesRejection === '__unnamed__' ||
      !result.wrongDigestRejection || result.wrongDigestRejection === '__unnamed__'
    )) {
      failures.push(finding('group3', 'helper_integrity_inert', request.path))
    }
  }
}

function compiledShadowFindings(
  appRoot: string,
  versions: ReturnType<typeof lockedVersions>
): VerifyFinding[] {
  const emittedTypeScriptPaths = [
    'generated/index.ts',
    ...managedHelperPaths(),
    ...versions.map(version => `${version.relativePath}/components.generated.ts`),
  ]
  return emittedTypeScriptPaths.flatMap(emittedPath => {
    const shadowPath = `${emittedPath.slice(0, -'.ts'.length)}.js`
    return existsSync(join(appRoot, shadowPath))
      ? [finding('group4', 'generated_index_compiled_shadow', shadowPath)]
      : []
  })
}

async function checkGroup4(
  appRoot: string,
  lock: InstructionSetLockV1,
  locations: VersionLocation[],
  versions: ReturnType<typeof lockedVersions>,
  manifests: Map<string, VersionManifest>,
  failures: VerifyFinding[],
  warnings: VerifyFinding[],
  hasCompiledShadows: boolean
): Promise<void> {
  for (const [setSlug, set] of Object.entries(lock.instructionSets)) {
    const defaultProfile = set.profiles[set.default]
    if (defaultProfile && !isDirectory(join(appRoot, 'instruction-sets', setSlug, set.default))) {
      failures.push(finding('group4', 'default_pointer_target_missing', `instruction-sets/${setSlug}/${set.default}`))
    }
    for (const [profileSlug, profile] of Object.entries(set.profiles)) {
      if (profile.production && !isDirectory(join(appRoot, 'instruction-sets', setSlug, profileSlug, profile.production))) {
        failures.push(finding('group4', 'pointer_target_missing', `instruction-sets/${setSlug}/${profileSlug}/${profile.production}`))
      }
    }
  }

  const lockedPaths = new Set(versions.map(version => version.relativePath))
  for (const version of versions) {
    if (!isDirectory(version.absolutePath)) {
      failures.push(finding('group4', 'lock_version_folder_missing', version.relativePath))
    }
  }
  for (const location of locations) {
    if (!lockedPaths.has(location.relativePath)) failures.push(finding('group4', 'orphan_version_folder', location.relativePath))
  }
  const instructionSetsRoot = join(appRoot, 'instruction-sets')
  for (const setSlug of directoryNames(instructionSetsRoot)) {
    if (!Object.hasOwn(lock.instructionSets, setSlug)) {
      failures.push(finding('group4', 'orphan_instruction_set_folder', `instruction-sets/${setSlug}`))
      continue
    }
    for (const profileSlug of directoryNames(join(instructionSetsRoot, setSlug))) {
      if (!Object.hasOwn(lock.instructionSets[setSlug]!.profiles, profileSlug)) {
        failures.push(finding('group4', 'orphan_profile_folder', `instruction-sets/${setSlug}/${profileSlug}`))
      }
    }
  }

  const helperFingerprints = lock.helpers ?? {}
  const expectedHelperPaths = managedHelperPaths()
  for (const helperPath of expectedHelperPaths) {
    const hasFingerprint = Object.hasOwn(helperFingerprints, helperPath)
    const absoluteHelperPath = resolve(appRoot, helperPath)
    if (!existsSync(absoluteHelperPath)) {
      failures.push(finding('group4', 'helper_missing', helperPath, hasFingerprint ? helperFingerprints[helperPath] : 'managed Helper', 'missing'))
    } else if (!hasFingerprint) {
      failures.push(finding('group4', 'helper_fingerprint_missing', helperPath))
    }
  }
  for (const [helperPath, expectedHash] of Object.entries(helperFingerprints)) {
    const absoluteHelperPath = resolve(appRoot, helperPath)
    const confined = relative(appRoot, absoluteHelperPath)
    if (confined.startsWith('..') || resolve(appRoot, confined) !== absoluteHelperPath) {
      failures.push(finding('group4', 'helper_path_unsafe', helperPath))
      continue
    }
    if (!existsSync(absoluteHelperPath)) {
      failures.push(finding('group4', 'helper_missing', helperPath, expectedHash, 'missing'))
      continue
    }
    const foundHash = hash(readFileSync(absoluteHelperPath))
    if (foundHash !== expectedHash) warnings.push(finding('group4', 'helper_modified', helperPath, expectedHash, foundHash))
  }

  const importMapPath = join(appRoot, 'generated', 'index.ts')
  if (!existsSync(importMapPath)) {
    warnings.push(finding('group4', 'import_map_missing', 'generated/index.ts'))
    return
  }
  const importMapSource = readFileSync(importMapPath, 'utf8')
  const importMapDrifted = importMapSource !== renderGeneratedIndex(lock)
  if (importMapDrifted) {
    failures.push(finding('group4', 'generated_module_drift', 'generated/index.ts'))
  }
  const versionModuleIntegrityFailed = failures.some(failure => failure.group === 'group2')
  if (!importMapDrifted && !versionModuleIntegrityFailed && !hasCompiledShadows) {
    try {
      const generatedLock = await importGeneratedLock(importMapPath)
      if (!isDeepStrictEqual(generatedLock, lock)) {
        failures.push(finding('group4', 'generated_lock_stale', 'generated/index.ts'))
      }
    } catch (error) {
      const code = error instanceof CustomerModuleError ? error.code : 'import_map_mismatch'
      failures.push(finding('group4', code, 'generated/index.ts', 'importable generated Lock', errorText(error)))
    }
  }
  try {
    const importMap = staticImportMap(importMapSource)
    const mappedKeys = Object.entries(importMap.versions).flatMap(([setSlug, profiles]) =>
      Object.entries(profiles).flatMap(([profileSlug, mappedVersions]) =>
        Object.keys(mappedVersions).map(versionSlug => `${setSlug}/${profileSlug}/${versionSlug}`)
      )
    ).sort()
    const expectedKeys = versions.map(version => `${version.setSlug}/${version.profileSlug}/${version.versionSlug}`).sort()
    if (JSON.stringify(mappedKeys) !== JSON.stringify(expectedKeys)) {
      failures.push(finding('group4', 'import_map_mismatch', 'generated/index.ts', expectedKeys.join(','), mappedKeys.join(',')))
    }
    const usedIdentifiers = new Set<string>()
    for (const version of versions) {
      const identifier = importMap.versions[version.setSlug]?.[version.profileSlug]?.[version.versionSlug]
      if (!identifier) continue
      usedIdentifiers.add(identifier)
      const foundDestination = importMap.imports.get(identifier) ?? 'missing'
      const expectedDestination = `../instruction-sets/${version.setSlug}/${version.profileSlug}/${version.versionSlug}/components.generated.js`
      if (foundDestination !== expectedDestination) {
        const manifest = manifests.get(version.relativePath)
        const specifier = manifest
          ? `${version.setSlug}/${manifest.modelConfigIdentity}@v${version.version.versionNumber}`
          : `${version.setSlug}/${version.profileSlug}@v${version.version.versionNumber}`
        failures.push(finding(
          'group4',
          `import_map_destination_mismatch:${specifier}`,
          'generated/index.ts',
          expectedDestination,
          foundDestination
        ))
      }
    }
    const importedIdentifiers = [...importMap.imports.keys()].sort()
    const mappedIdentifiers = [...usedIdentifiers].sort()
    if (JSON.stringify(importedIdentifiers) !== JSON.stringify(mappedIdentifiers)) {
      failures.push(finding('group4', 'import_map_mismatch', 'generated/index.ts', mappedIdentifiers.join(','), importedIdentifiers.join(',')))
    }
  } catch (error) {
    failures.push(finding('group4', 'import_map_mismatch', 'generated/index.ts', 'valid static map', errorText(error)))
  }
}

export async function verifyInstructionSetTree(out: string): Promise<VerifyReport> {
  const appRoot = resolve(out, 'orizu')
  const failures: VerifyFinding[] = []
  const warnings: VerifyFinding[] = []
  let lock: InstructionSetLockV1
  try {
    lock = parseLock(readFileSync(join(appRoot, 'orizu.lock.json'), 'utf8'))
  } catch (error) {
    failures.push(finding('group4', 'lock_invalid', 'orizu.lock.json', undefined, errorText(error)))
    return {
      ok: false,
      groups: { group1: 'SKIPPED', group2: 'SKIPPED', group3: 'SKIPPED', group4: 'FAIL' },
      failures,
      warnings,
    }
  }

  const locations = versionLocations(appRoot)
  const versions = lockedVersions(lock, appRoot)
  const manifests = new Map<string, VersionManifest>()
  checkGroup1(locations, lock, manifests, failures)
  await checkGroup2(versions, manifests, failures, true)
  const shadowFailures = compiledShadowFindings(appRoot, versions)
  failures.push(...shadowFailures)
  if (shadowFailures.length === 0) {
    await checkGroup3(appRoot, lock, versions, manifests, failures)
  }
  await checkGroup4(appRoot, lock, locations, versions, manifests, failures, warnings, shadowFailures.length > 0)
  const groups = Object.fromEntries(
    (['group1', 'group2', 'group3', 'group4'] as const).map(group => [
      group,
      group === 'group3' && shadowFailures.length > 0
        ? 'SKIPPED'
        : failures.some(failure => failure.group === group) ? 'FAIL' : 'PASS',
    ])
  ) as Record<VerifyGroup, VerifyGroupStatus>
  return { ok: failures.length === 0, groups, failures, warnings }
}

export function printVerifyReport(report: VerifyReport, json: boolean, print: (line: string) => void): void {
  if (json) {
    print(JSON.stringify(report))
    return
  }
  for (const group of ['group1', 'group2', 'group3', 'group4'] as const) {
    const count = report.failures.filter(failure => failure.group === group).length
    print(`${report.groups[group]} ${group}${count === 0 ? '' : ` (${count})`}`)
  }
  for (const failure of report.failures) {
    const detail = failure.expected !== undefined || failure.found !== undefined
      ? ` expected ${failure.expected ?? 'n/a'} found ${failure.found ?? 'n/a'}`
      : ''
    print(`FAIL ${failure.group} ${failure.path} ${failure.code}${detail}`)
  }
  for (const warning of report.warnings) {
    const detail = warning.expected !== undefined || warning.found !== undefined
      ? ` expected ${warning.expected ?? 'n/a'} found ${warning.found ?? 'n/a'}`
      : ''
    print(`WARN ${warning.group} ${warning.path} ${warning.code}${detail}`)
  }
}
