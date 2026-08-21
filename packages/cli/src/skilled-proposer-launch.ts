import { spawnSync } from 'child_process'
import { join } from 'path'
import { fileURLToPath } from 'url'

import type { GepaEngine } from './gepa-engine-dispatch.js'
import { bundledOfficialGepaPythonPath } from './gepa-python-paths.js'
import { sanitizeTerminalText } from './json-response.js'

interface SkilledProposerVenvReport {
  venv: string
  sslCertFile: string | null
  pythonPathEntries: string[]
  warnings?: Array<{ code: string, message: string }>
  error?: string
  message?: string
}

export interface SkilledProposerLaunch {
  python: string
  environment: NodeJS.ProcessEnv
}

function ensureSelectedSkilledProposerVenv(
  python: string,
  vendoredGepaPath: string,
): SkilledProposerVenvReport {
  const manager = fileURLToPath(new URL('../scripts/ensure-skilled-proposer-venv.mjs', import.meta.url))
  const lock = fileURLToPath(new URL('../requirements/skilled-proposer.lock', import.meta.url))
  // This is a regenerable workspace cache. The manager's publish key further
  // separates interpreters, platforms, and lock revisions inside it.
  const cacheRoot = join(process.cwd(), '.orizu', 'cache', 'skilled-proposer')
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
  }
}
