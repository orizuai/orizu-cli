#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { SKILLED_PROPOSER_BAKE_REPORT_FIELDS } from '../src/skilled-proposer-bake-report.js'
import { buildPublishKey, characterizePython, readAndValidateHashLock } from '../src/skilled-proposer-venv-manager.mjs'
export const POSITIVE_MARKER = 'ALI_1588_DEPENDENCY_SETUP_REUSED'
export const ARTIFACT_PROBE_TIMEOUTS = { verifier: 160_000, curl: 5_000, pipCheck: 30_000, importSmoke: 60_000 } as const
export const ARTIFACT_VERIFY_ARGUMENTS = ['internal', 'verify-skilled-proposer-bake', '--json'] as const
export interface ArtifactVerificationReport {
  marker: string; venv: string; publishKey: string; python: string; sslCertFile: string | null; packageRoot: string
  manager: string; lock: string; vendoredGepaPath: string; pythonPathEntries: string[]; publishedVenv: boolean | null; waitedForPublishLock: boolean; executedPipArgv: string[] | null; warnings: Array<{ code: string, message: string }>; launcherVenv: string | null; launcherSslCertFile: string | null
}
export interface ArtifactContractObservation {
  artifactRoot: string; report: ArtifactVerificationReport
  manifest: { managerSchemaVersion?: number; publishKey?: string; lockDigest?: string; pythonIdentity?: unknown; executedPipArgv?: string[] }
  runtimePythonIdentity: unknown; basePythonExecutable: string; basePythonIdentity: unknown; actualLockDigest: string
  curlExitCode: number | null; pipCheckExitCode: number | null; importSmokeExitCode: number | null
}
interface PythonIdentity {
  implementation: string; version: number[]; executable: string; platform: string
  cacheTag: string; soabi: string; system: string; machine: string; osVersion: string; libc: string[]
}
function fail(code: string, detail: string): never { throw new Error(`${code}: ${detail}`) }
function assertRealFile(path: string, code: string): string {
  if (!existsSync(path)) fail(code, `missing ${path}`)
  return realpathSync(path)
}
function assertInside(path: string, root: string, code: string): void {
  const resolvedRoot = `${realpathSync(root)}${sep}`
  const resolvedPath = realpathSync(path)
  if (!resolvedPath.startsWith(resolvedRoot)) fail(code, `${resolvedPath} is outside ${resolvedRoot}`)
}
function isPythonIdentity(value: unknown): value is PythonIdentity {
  if (!value || typeof value !== 'object') return false
  const identity = value as Record<string, unknown>
  return ['implementation', 'executable', 'platform', 'cacheTag', 'soabi', 'system', 'machine', 'osVersion']
    .every(key => typeof identity[key] === 'string')
    && Array.isArray(identity.version) && identity.version.every(part => Number.isInteger(part))
    && Array.isArray(identity.libc) && identity.libc.every(part => typeof part === 'string')
}
export function assertArtifactContract(observation: ArtifactContractObservation): void {
  const { report, manifest } = observation
  if (report.marker !== POSITIVE_MARKER) fail('ALI_1588_POSITIVE_MARKER_MISSING', `received ${report.marker || 'empty marker'}`)
  if (report.publishedVenv !== false || report.executedPipArgv !== null) fail('ALI_1588_RUNTIME_INSTALL_ATTEMPTED', 'artifact command did not report cache reuse with a null pip argv')
  const packageRoot = assertRealFile(report.packageRoot, 'ALI_1588_PACKAGE_ROOT_MISSING')
  const artifactRoot = `${realpathSync(observation.artifactRoot)}${sep}`
  if (!packageRoot.startsWith(artifactRoot)) fail('ALI_1588_PACKAGE_ROOT_NOT_ARTIFACT_OWNED', packageRoot)
  if (packageRoot !== join(realpathSync(observation.artifactRoot), 'cli')) fail('ALI_1588_PACKAGE_ROOT_MISMATCH', packageRoot)
  for (const [path, label] of [
    [report.manager, 'MANAGER'],
    [report.lock, 'LOCK'],
    [report.vendoredGepaPath, 'VENDORED_GEPA'],
  ] as const) {
    assertRealFile(path, `ALI_1588_${label}_MISSING`)
    assertInside(path, packageRoot, `ALI_1588_${label}_NOT_PACKAGE_OWNED`)
  }
  const exactAssets = [['manager', 'scripts/ensure-skilled-proposer-venv.mjs', 'MANAGER'], ['lock', 'requirements/skilled-proposer.lock', 'LOCK'], ['vendoredGepaPath', 'vendor/gepa-python/src', 'VENDORED_GEPA']] as const
  for (const [key, suffix, label] of exactAssets) if (report[key] !== join(packageRoot, suffix)) fail(`ALI_1588_${label}_PATH_MISMATCH`, report[key])
  const exactPythonPaths = ['vendor/orizu-gepa/src', 'vendor/orizu-gepa-python/src', 'vendor/gepa-python/src'].map(path => join(packageRoot, path))
  if (JSON.stringify(report.pythonPathEntries) !== JSON.stringify(exactPythonPaths)) fail('ALI_1588_PYTHON_PATHS_MISMATCH', report.pythonPathEntries.join(delimiter))
  for (const path of exactPythonPaths) { assertRealFile(path, 'ALI_1588_PYTHON_ROOT_MISSING'); assertInside(path, packageRoot, 'ALI_1588_PYTHON_ROOT_NOT_PACKAGE_OWNED') }
  const venv = assertRealFile(report.venv, 'ALI_1588_BAKED_VENV_MISSING')
  const publishKey = manifest.publishKey
  if (!publishKey?.match(/^[a-f0-9]{64}$/)) fail('ALI_1588_VENV_MANIFEST_IDENTITY_INVALID', 'invalid publishKey')
  if (report.publishKey !== publishKey) fail('ALI_1588_VENV_MANIFEST_IDENTITY_INVALID', 'report publish key does not match marker')
  const intendedVenv = join(observation.artifactRoot, 'cache/skilled-proposer/venvs', publishKey)
  const normalizedIntendedVenv = existsSync(intendedVenv) ? realpathSync(intendedVenv) : resolve(intendedVenv)
  if (venv !== normalizedIntendedVenv) fail('ALI_1588_WORKSPACE_RELATIVE_CACHE', venv)
  assertRealFile(join(venv, 'bin/python'), 'ALI_1588_VENV_PYTHON_MISSING')
  assertRealFile(report.python, 'ALI_1588_LAUNCH_PYTHON_MISSING')
  if (report.python !== join(venv, 'bin/python')) fail('ALI_1588_LAUNCHER_VENV_MISMATCH', report.python)
  const manifestPath = join(venv, '.orizu-skilled-proposer-venv.json')
  assertRealFile(manifestPath, 'ALI_1588_VENV_MARKER_MISSING')
  assertRealFile(join(venv, 'pyvenv.cfg'), 'ALI_1588_PYVENV_CONFIG_MISSING')
  if (manifest.managerSchemaVersion !== 1 || !isPythonIdentity(manifest.pythonIdentity)) fail('ALI_1588_VENV_MANIFEST_IDENTITY_INVALID', 'manager schema or Python identity missing')
  const derivedPublishKey = buildPublishKey(manifest.pythonIdentity, readFileSync(report.lock, 'utf8')).publishKey
  if (derivedPublishKey !== publishKey) fail('ALI_1588_VENV_MANIFEST_IDENTITY_INVALID', 'publish key does not match marker identity')
  if (assertRealFile(observation.basePythonExecutable, 'ALI_1588_BASE_PYTHON_MISSING') !== realpathSync(manifest.pythonIdentity.executable)) fail('ALI_1588_BASE_PYTHON_IDENTITY_MISMATCH', manifest.pythonIdentity.executable)
  if (!isPythonIdentity(observation.runtimePythonIdentity)) fail('ALI_1588_RUNTIME_PYTHON_IDENTITY_INVALID', 'selected Python identity missing')
  for (const key of ['implementation', 'version', 'executable', 'platform', 'cacheTag', 'soabi', 'system', 'machine', 'libc'] as const) {
    if (JSON.stringify(manifest.pythonIdentity[key]) !== JSON.stringify(observation.runtimePythonIdentity[key])) fail('ALI_1588_RUNTIME_PYTHON_IDENTITY_MISMATCH', key)
  }
  if (!isPythonIdentity(observation.basePythonIdentity)) fail('ALI_1588_BASE_PYTHON_IDENTITY_INVALID', 'base Python identity missing')
  for (const key of ['implementation', 'version', 'executable', 'platform', 'cacheTag', 'soabi', 'system', 'machine', 'libc'] as const) {
    if (JSON.stringify(manifest.pythonIdentity[key]) !== JSON.stringify(observation.basePythonIdentity[key])) fail('ALI_1588_BASE_PYTHON_IDENTITY_MISMATCH', key)
  }
  if (report.launcherVenv !== report.venv) fail('ALI_1588_LAUNCHER_VENV_ENV_MISMATCH', `${report.launcherVenv || 'missing'} != ${report.venv}`)
  const installArgv = manifest.executedPipArgv
  if (!Array.isArray(installArgv)) fail('ALI_1588_BAKE_ARGV_MISSING', 'venv manifest omitted executedPipArgv')
  const bakePython = installArgv[0]
  const stageRelative = bakePython ? relative(resolve(intendedVenv, '..'), bakePython) : ''
  const stagePattern = new RegExp(`^\\.${publishKey}-[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp/bin/python$`)
  if (!bakePython || !isAbsolute(bakePython) || normalize(bakePython) !== bakePython || !stagePattern.test(stageRelative)) fail('ALI_1588_BAKE_COMMAND_MISMATCH', bakePython || 'missing')
  const exactArgv = [bakePython, '-m', 'pip', 'install', '--require-hashes', '--only-binary=:all:', '--requirement', report.lock]
  if (JSON.stringify(installArgv) !== JSON.stringify(exactArgv)) fail('ALI_1588_BAKE_COMMAND_MISMATCH', installArgv.join(' '))
  if (manifest.lockDigest !== observation.actualLockDigest) fail('ALI_1588_BAKE_LOCK_DIGEST_MISMATCH', `${manifest.lockDigest || 'missing digest'} != ${observation.actualLockDigest}`)
  if (!report.sslCertFile) fail('ALI_1588_CA_UNRESOLVED', 'artifact command reported no CA bundle')
  assertRealFile(report.sslCertFile, 'ALI_1588_CA_MISSING')
  if (report.launcherSslCertFile !== report.sslCertFile) fail('ALI_1588_LAUNCHER_CA_ENV_MISMATCH', `${report.launcherSslCertFile || 'missing'} != ${report.sslCertFile}`)
  if (observation.curlExitCode !== 0) fail('ALI_1588_CURL_UNAVAILABLE', `curl --version exited ${observation.curlExitCode}`)
  if (observation.pipCheckExitCode !== 0) fail('ALI_1588_PIP_CHECK_FAILED', `baked venv pip check exited ${observation.pipCheckExitCode}`)
  if (observation.importSmokeExitCode !== 0) fail('ALI_1588_IMPORT_SMOKE_FAILED', `baked venv import smoke exited ${observation.importSmokeExitCode}`)
}
function readNamed(path: string, missingCode: string): Buffer {
  try { return readFileSync(path) }
  catch (error) { fail(missingCode, error instanceof Error ? error.message : String(error)) }
}
function parseNamed<T>(contents: string, code: string): T {
  try { return JSON.parse(contents) as T }
  catch { fail(code, contents.trim() || 'empty input') }
}
function narrowReport(value: unknown, code = 'ALI_1588_PACKAGED_VERIFIER_REPORT_INVALID'): ArtifactVerificationReport {
  if (!value || typeof value !== 'object') fail(code, 'expected object')
  const report = value as Record<string, unknown>
  if (Object.keys(report).length !== SKILLED_PROPOSER_BAKE_REPORT_FIELDS.length || SKILLED_PROPOSER_BAKE_REPORT_FIELDS.some(key => !(key in report))) fail(code, 'report fields do not match production schema')
  for (const key of ['marker', 'venv', 'publishKey', 'python', 'packageRoot', 'manager', 'lock', 'vendoredGepaPath']) {
    if (typeof report[key] !== 'string') fail(code, `${key} must be a string`)
  }
  for (const key of ['sslCertFile', 'launcherVenv', 'launcherSslCertFile']) {
    if (report[key] !== null && typeof report[key] !== 'string') fail(code, `${key} must be string or null`)
  }
  if (!Array.isArray(report.pythonPathEntries) || !report.pythonPathEntries.every(value => typeof value === 'string')) fail(code, 'pythonPathEntries must be strings')
  if (typeof report.publishedVenv !== 'boolean' || typeof report.waitedForPublishLock !== 'boolean' || !Array.isArray(report.warnings) || !report.warnings.every(warning => warning && typeof warning === 'object' && typeof (warning as Record<string, unknown>).code === 'string' && typeof (warning as Record<string, unknown>).message === 'string') || (report.executedPipArgv !== null
      && (!Array.isArray(report.executedPipArgv) || !report.executedPipArgv.every(value => typeof value === 'string')))) {
    fail(code, 'reuse fields have invalid types')
  }
  return report as unknown as ArtifactVerificationReport
}
function narrowManifest(value: unknown): ArtifactContractObservation['manifest'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('ALI_1588_VENV_MANIFEST_INVALID', 'expected object')
  const manifest = value as Record<string, unknown>
  if (typeof manifest.managerSchemaVersion !== 'number' || typeof manifest.publishKey !== 'string'
      || typeof manifest.lockDigest !== 'string' || !manifest.pythonIdentity || typeof manifest.pythonIdentity !== 'object'
      || !Array.isArray(manifest.executedPipArgv) || !manifest.executedPipArgv.every(value => typeof value === 'string')) {
    fail('ALI_1588_VENV_MANIFEST_INVALID', 'required marker fields have invalid types')
  }
  return manifest as ArtifactContractObservation['manifest']
}
function runChecked(code: string, command: string, args: string[], timeout: number, env: NodeJS.ProcessEnv | undefined, spawn: typeof spawnSync) {
  const result = spawn(command, args, { encoding: 'utf8', timeout, env: env ?? process.env })
  if (result.error || result.status !== 0) fail(code, result.error?.message || result.stderr || result.stdout || `exit ${result.status}`)
  return result
}
export function collectArtifactObservation(options: { expectedCwd?: string, command?: string, artifactRoot?: string, spawn?: typeof spawnSync, characterize?: typeof characterizePython } = {}): ArtifactContractObservation {
  const expectedCwd = options.expectedCwd ?? '/vercel/sandbox/repo'
  if (process.cwd() !== expectedCwd) {
    fail('ALI_1588_WRONG_WORKDIR', `expected ${expectedCwd}, received ${process.cwd()}`)
  }
  const spawn = options.spawn ?? spawnSync
  const characterize = options.characterize ?? characterizePython
  const buildReport = narrowReport(parseNamed<unknown>(readNamed(
    join(options.artifactRoot ?? '/opt/orizu', 'skilled-proposer-build-verification.json'),
    'ALI_1588_BUILD_VERIFICATION_MISSING',
  ).toString('utf8'), 'ALI_1588_BUILD_VERIFICATION_INVALID'), 'ALI_1588_BUILD_VERIFICATION_INVALID')
  if (buildReport.marker !== POSITIVE_MARKER || buildReport.publishedVenv !== false
      || buildReport.executedPipArgv !== null) {
    fail('ALI_1588_BUILD_VERIFICATION_INVALID', 'build-time verifier did not record the reusable packaged runtime')
  }
  const verification = spawn(options.command ?? 'orizu', [...ARTIFACT_VERIFY_ARGUMENTS], {
    encoding: 'utf8', timeout: ARTIFACT_PROBE_TIMEOUTS.verifier, env: process.env,
  })
  if (verification.error || verification.status !== 0) {
    const detail = verification.error?.message
      || verification.stderr
      || verification.stdout
      || `exit ${verification.status}`
    fail('ALI_1588_PACKAGED_VERIFIER_FAILED', detail.trim())
  }
  const report = narrowReport(parseNamed<unknown>(verification.stdout, 'ALI_1588_PACKAGED_VERIFIER_REPORT_INVALID'))
  for (const key of SKILLED_PROPOSER_BAKE_REPORT_FIELDS) {
    if (JSON.stringify(buildReport[key]) !== JSON.stringify(report[key])) fail('ALI_1588_BUILD_VERIFICATION_INVALID', `build-time report mismatch at ${key}`)
  }
  const manifestBytes = readNamed(
    join(report.venv, '.orizu-skilled-proposer-venv.json'),
    'ALI_1588_VENV_MANIFEST_MISSING',
  )
  const manifest = narrowManifest(parseNamed<unknown>(manifestBytes.toString('utf8'), 'ALI_1588_VENV_MANIFEST_INVALID'))
  const pyvenv = readNamed(join(report.venv, 'pyvenv.cfg'), 'ALI_1588_PYVENV_CONFIG_MISSING').toString('utf8')
  const basePythonExecutable = /^executable\s*=\s*(.+)$/m.exec(pyvenv)?.[1]?.trim()
  if (!basePythonExecutable) fail('ALI_1588_PYVENV_CONFIG_INVALID', 'missing executable')
  const lockBytes = readNamed(report.lock, 'ALI_1588_LOCK_READ_FAILED')
  try { readAndValidateHashLock(report.lock) }
  catch (error) { fail('ALI_1588_LOCK_INVALID', error instanceof Error ? error.message : String(error)) }
  const actualLockDigest = createHash('sha256').update(lockBytes).digest('hex')
  let runtimePythonIdentity: unknown
  try { runtimePythonIdentity = characterize(report.python) }
  catch (error) { fail('ALI_1588_RUNTIME_PYTHON_IDENTITY_INVALID', error instanceof Error ? error.message : String(error)) }
  let basePythonIdentity: unknown
  try { basePythonIdentity = characterize(basePythonExecutable) }
  catch (error) { fail('ALI_1588_BASE_PYTHON_IDENTITY_INVALID', error instanceof Error ? error.message : String(error)) }
  const curl = runChecked('ALI_1588_CURL_UNAVAILABLE', 'curl', ['--version'], ARTIFACT_PROBE_TIMEOUTS.curl, undefined, spawn)
  const pipCheck = runChecked('ALI_1588_PIP_CHECK_FAILED', report.python, ['-m', 'pip', 'check'], ARTIFACT_PROBE_TIMEOUTS.pipCheck, undefined, spawn)
  const importSmoke = runChecked('ALI_1588_IMPORT_SMOKE_FAILED',
    report.python,
    ['-c', 'import dspy; import skilled_proposer; from skilled_proposer import SkilledProposer; SkilledProposer(skills=[]); from orizu_gepa_connector.__main__ import main as official_main; from orizu_gepa.cli import main as legacy_main'],
    ARTIFACT_PROBE_TIMEOUTS.importSmoke, { ...process.env, PYTHONPATH: report.pythonPathEntries.join(delimiter) }, spawn,
  )
  return { artifactRoot: options.artifactRoot ?? '/opt/orizu', report, manifest, runtimePythonIdentity, basePythonExecutable, basePythonIdentity, actualLockDigest, curlExitCode: curl.status, pipCheckExitCode: pipCheck.status, importSmokeExitCode: importSmoke.status }
}
if (import.meta.main) {
  assertArtifactContract(collectArtifactObservation())
  process.stdout.write(`${POSITIVE_MARKER}\n`)
}
