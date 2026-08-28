import { spawn, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'

import type { GepaEngine } from './gepa-engine-dispatch.js'
import { bundledOfficialGepaPythonPath, getGepaPythonPathEntries } from './gepa-python-paths.js'
import { sanitizeTerminalText } from './json-response.js'
import { SKILLED_PROPOSER_BAKE_REPORT_FIELDS } from './skilled-proposer-bake-report.js'

interface SkilledProposerVenvReport {
  venv: string
  publishKey: string
  sslCertFile: string | null
  pythonPathEntries: string[]
  warnings: Array<{ code: string, message: string }>
  waitedForPublishLock: boolean
  error?: string
  message?: string
  publishedVenv?: boolean | null
  executedPipArgv?: string[] | null
}
export interface SkilledProposerLaunch {
  python: string
  environment: NodeJS.ProcessEnv
  report?: SkilledProposerVenvReport
}

function materializeConfigPayload(engine: GepaEngine, environment: NodeJS.ProcessEnv): (() => void) | undefined {
  const payload = environment.ORIZU_SKILLED_PROPOSER_CONFIG
  if (engine !== 'official' || environment.ORIZU_CANDIDATE_PROPOSER !== 'skilled-proposer' || payload === undefined) return undefined
  const root = mkdtempSync(join(tmpdir(), 'orizu-skilled-proposer-payload-'))
  try {
    const path = join(root, 'config.json')
    writeFileSync(path, payload, { encoding: 'utf8', mode: 0o600 })
    environment.ORIZU_SKILLED_PROPOSER_CONFIG = `@${path}`
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
  return () => rmSync(root, { recursive: true, force: true })
}

export async function spawnSkilledProposerChild(
  command: string, args: string[], engine: GepaEngine, environment: NodeJS.ProcessEnv,
  onSpawn?: () => Promise<void>,
) {
  const childEnvironment = { ...environment }
  const shouldMaterialize = engine === 'official'
    && childEnvironment.ORIZU_CANDIDATE_PROPOSER === 'skilled-proposer'
    && childEnvironment.ORIZU_SKILLED_PROPOSER_CONFIG !== undefined
  if (!shouldMaterialize) return spawnSync(command, args, { stdio: 'inherit', env: childEnvironment })

  let child: ReturnType<typeof spawn> | undefined
  let cleanup = () => {}
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const
  const handlers = signals.map(signal => ({
    signal,
    handle: () => {
      try { cleanup() }
      finally {
        try { child?.kill(signal) }
        finally {
          for (const entry of handlers) process.off(entry.signal, entry.handle)
          process.kill(process.pid, signal)
        }
      }
    },
  }))
  for (const entry of handlers) process.once(entry.signal, entry.handle)
  try {
    cleanup = materializeConfigPayload(engine, childEnvironment) ?? cleanup
    await new Promise<void>(resolve => setImmediate(resolve))
    const spawnedChild = spawn(command, args, { stdio: 'inherit', env: childEnvironment })
    child = spawnedChild
    const spawned = new Promise<void>((resolve, reject) => {
      spawnedChild.once('spawn', resolve)
      spawnedChild.once('error', reject)
    })
    const closed = new Promise<{ status: number | null, error?: Error }>(resolve => {
      let error: Error | undefined
      spawnedChild.once('error', cause => { error = cause })
      spawnedChild.once('close', status => resolve(error ? { status, error } : { status }))
    })
    await spawned
    try { await onSpawn?.() }
    catch (error) { spawnedChild.kill('SIGTERM'); await closed; throw error }
    return await closed
  } finally {
    for (const entry of handlers) process.off(entry.signal, entry.handle)
    cleanup()
  }
}

function ensureSelectedSkilledProposerVenv(
  python: string,
  vendoredGepaPath: string,
  cacheRoot = existsSync('/opt/orizu/prebaked.json')
    ? '/opt/orizu/cache/skilled-proposer'
    : join(process.cwd(), '.orizu', 'cache', 'skilled-proposer'),
): SkilledProposerVenvReport {
  const manager = fileURLToPath(new URL('../scripts/ensure-skilled-proposer-venv.mjs', import.meta.url))
  const lock = fileURLToPath(new URL('../requirements/skilled-proposer.lock', import.meta.url))
  const result = spawnSync(
    process.execPath,
    [manager, '--python', python, '--cache-root', cacheRoot, '--lock', lock,
      '--vendored-gepa-path', vendoredGepaPath, '--json'],
    {
      env: process.env,
      encoding: 'utf8',
    },
  )
  if (result.error) {
    throw new Error(`ALI_1505_VENV_MANAGER_FAILED: ${result.error.message}`, { cause: result.error })
  }
  const stdout = result.stdout || ''
  const stderr = result.stderr || ''
  let report: SkilledProposerVenvReport
  try {
    report = JSON.parse(stdout) as SkilledProposerVenvReport
  } catch {
    throw new Error(`ALI_1505_VENV_MANAGER_INVALID_REPORT: ${stderr.trim() || 'manager emitted no JSON report'}`)
  }
  if (result.status !== 0) {
    throw new Error(`${report.error || 'ALI_1505_VENV_MANAGER_FAILED'}: ${report.message || 'skilled-proposer venv manager failed'}`)
  }
  if (!report.venv) {
    throw new Error('ALI_1505_VENV_MANAGER_INVALID_REPORT: successful manager report omitted venv')
  }
  return report
}

interface BakeCommandIo { print: (value: string) => void; printErr?: (value: string) => void }
const packageRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const managerPath = join(packageRoot, 'scripts/ensure-skilled-proposer-venv.mjs')
const lockPath = join(packageRoot, 'requirements/skilled-proposer.lock')
const vendoredGepaPath = join(packageRoot, 'vendor/gepa-python/src')
const packagedPythonPathEntries = ['vendor/orizu-gepa/src', 'vendor/orizu-gepa-python/src', 'vendor/gepa-python/src'].map(path => join(packageRoot, path))
const bakedCacheRoot = '/opt/orizu/cache/skilled-proposer'

export function skilledProposerBakeCommand(io: BakeCommandIo, verify = false): number {
  try {
    const python = process.env.PYTHON || 'python3'
    if (!verify) { io.print(JSON.stringify(ensureSelectedSkilledProposerVenv(python, vendoredGepaPath, bakedCacheRoot))); return 0 }
    if (!readdirSync(join(bakedCacheRoot, 'venvs'), { withFileTypes: true }).some(entry => entry.isDirectory() && existsSync(join(bakedCacheRoot, 'venvs', entry.name, '.orizu-skilled-proposer-venv.json')))) throw new Error('ALI_1588_VENV_MARKER_MISSING')
    const environment = { ...process.env, ORIZU_CANDIDATE_PROPOSER: 'skilled-proposer' }
    const launch = prepareSkilledProposerLaunch(python, 'official', environment)
    const report = launch.report!
    if (report.publishedVenv !== false || report.executedPipArgv !== null) throw new Error('ALI_1588_DEPENDENCY_SETUP_NOT_REUSED')
    const pythonPathEntries = getGepaPythonPathEntries(undefined)
    if (JSON.stringify(pythonPathEntries) !== JSON.stringify(packagedPythonPathEntries)) throw new Error('ALI_1588_PYTHON_ROOT_MISSING')
    const completeReport = { ...report, pythonPathEntries, marker: 'ALI_1588_DEPENDENCY_SETUP_REUSED', python: launch.python, packageRoot, manager: managerPath, lock: lockPath, vendoredGepaPath, launcherVenv: launch.environment.ORIZU_SKILLED_PROPOSER_VENV ?? null, launcherSslCertFile: launch.environment.SSL_CERT_FILE ?? null }
    io.print(JSON.stringify(Object.fromEntries(SKILLED_PROPOSER_BAKE_REPORT_FIELDS.map(key => [key, completeReport[key]]))))
    return 0
  } catch (error) { io.printErr?.(`${error instanceof Error ? error.message : String(error)}\n`); return 1 }
}

export function prepareSkilledProposerLaunch(
  python: string,
  engine: GepaEngine,
  environment: NodeJS.ProcessEnv,
): SkilledProposerLaunch {
  if (engine !== 'official' || environment.ORIZU_CANDIDATE_PROPOSER !== 'skilled-proposer') {
    return { python, environment }
  }

  const vendoredGepaPath = bundledOfficialGepaPythonPath()
  if (!vendoredGepaPath) {
    throw new Error('ALI_1505_VENDORED_GEPA_MISSING: skilled-proposer requires the vendored official GEPA source')
  }
  const report = ensureSelectedSkilledProposerVenv(python, vendoredGepaPath)
  environment.ORIZU_SKILLED_PROPOSER_VENV = report.venv
  for (const warning of report.warnings ?? []) {
    console.warn(`Warning [${sanitizeTerminalText(warning.code)}]: ${sanitizeTerminalText(warning.message)}`)
  }
  // When present, the manager's reported certificate is the same value used
  // for pip. Only the opt-in path resolves or changes this setting.
  if (report.sslCertFile) environment.SSL_CERT_FILE = report.sslCertFile

  return {
    python: process.platform === 'win32'
      ? join(report.venv, 'Scripts', 'python.exe')
      : join(report.venv, 'bin', 'python'),
    environment,
    report,
  }
}
