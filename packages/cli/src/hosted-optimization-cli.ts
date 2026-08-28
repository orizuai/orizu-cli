import { spawn, spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { ARTIFACT_MAX_BYTES } from './artifact-pull.js'

interface Io { print: (line: string) => void; printErr?: (line: string) => void }
interface JobSpec extends Record<string, unknown> {
  optimizerVersionId?: string
  candidateVersionIds?: string[]
  instructionSetProfileVersionId?: string | null
  runnerVersionId?: string
  scorerVersionId?: string
  scorerRunnerVersionId?: string
  datasetVersionId?: string
  splitSetId?: string
}
interface TokenPayload {
  token?: string
  expiresAt?: string
  jobSpec?: JobSpec
  projectRef?: string
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function callback(
  coordinator: string, runId: string, bootSecret: string,
  action: 'ready' | 'result', body: Record<string, unknown>
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${coordinator.replace(/\/+$/, '')}/optimizations/${encodeURIComponent(runId)}/${action}`, {
      method: 'POST', headers: {
        authorization: `Bearer ${bootSecret}`, 'content-type': 'application/json',
      }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
      })
      if (response.ok) return
      if (response.status < 500 && response.status !== 404) throw new Error(`${action} callback failed (${response.status})`)
    } catch (error) { if (attempt === 2) throw error }
    await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt))
  }
  throw new Error(`${action} callback remained ambiguous`)
}

async function materializeRunner(
  baseUrl: string, token: string, versionId: string
): Promise<{ dir: string; cleanup: () => void }> {
  const response = await fetch(
    `${baseUrl.replace(/\/+$/, '')}/api/cli/runner-versions/${encodeURIComponent(versionId)}/download`,
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) }
  )
  if (!response.ok) throw new Error(`runner download failed (${response.status})`)
  const root = mkdtempSync(join(tmpdir(), 'orizu-hosted-optimization-runner-'))
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  try {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > ARTIFACT_MAX_BYTES) throw new Error('runner artifact exceeds limit')
    const archive = join(root, 'runner.zip')
    const dir = join(root, 'runner')
    writeFileSync(archive, bytes)
    const unzip = spawnSync('unzip', ['-q', archive, '-d', dir], { encoding: 'utf8' })
    if (unzip.error) throw unzip.error
    if (unzip.status !== 0) throw new Error(`runner unzip failed (${unzip.status})`)
    return { dir, cleanup }
  } catch (error) { cleanup(); throw error }
}

function append(args: string[], flag: string, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) args.push(flag, value)
  else if (typeof value === 'number' && Number.isFinite(value)) args.push(flag, String(value))
}

function gepaArgs(spec: JobSpec, project: string, candidateDir: string, scorerDir: string): string[] {
  const args = ['optimizations', 'run-gepa', '--project', project, '--engine', 'official']
  append(args, '--optimizer-version-id', spec.optimizerVersionId)
  const candidates = spec.candidateVersionIds
  if (Array.isArray(candidates) && candidates.length === 1) append(args, '--candidate-version-id', candidates[0])
  else if (!spec.instructionSetProfileVersionId) throw new Error('hosted optimization requires one candidate or an instruction-set profile')
  append(args, '--runner-version-id', spec.runnerVersionId)
  append(args, '--candidate-runner-dir', candidateDir)
  append(args, '--scorer-version-id', spec.scorerVersionId)
  append(args, '--scorer-runner-version-id', spec.scorerRunnerVersionId)
  append(args, '--scorer-runner-dir', scorerDir)
  const fields: Array<[keyof JobSpec, string]> = [
    ['datasetVersionId', '--dataset-version-id'], ['splitSetId', '--split-set-id'],
    ['trainSplitName', '--train-split'], ['validationSplitName', '--val-split'],
    ['budget', '--budget'], ['minibatchSize', '--minibatch-size'], ['numThreads', '--num-threads'],
    ['candidateSelectionStrategy', '--candidate-selection-strategy'], ['epsilon', '--epsilon'],
    ['reflectionModel', '--reflection-model'], ['reflectionTemperature', '--reflection-temperature'],
    ['reflectionMaxTokens', '--reflection-max-tokens'], ['reflectionRetryAttempts', '--reflection-retry-attempts'],
    ['reflectionHttpTimeoutSeconds', '--reflection-http-timeout-seconds'], ['objective', '--objective'],
    ['seed', '--seed'], ['scorerInputContract', '--scorer-input-contract'],
    ['scorerCandidateField', '--scorer-candidate-field'], ['componentSelector', '--component-selector'],
    ['candidateProposer', '--candidate-proposer'], ['proposalMaxCalls', '--proposal-max-calls'],
    ['proposalMaxTokens', '--proposal-max-tokens'], ['reflectionPromptTemplate', '--reflection-prompt-template'],
  ]
  for (const [field, flag] of fields) append(args, flag,
    field === 'componentSelector' && spec[field] === 'round_robin' ? 'round-robin' : spec[field])
  for (const [field, flag] of [['reflectionProviderSettings', '--reflection-provider-settings']] as const) {
    const value = spec[field]
    if (value && typeof value === 'object') args.push(flag, JSON.stringify(value))
  }
  for (const [field, flag] of [
    ['allowDegenerateSeed', '--allow-degenerate-seed'],
    ['disableEvaluationCache', '--disable-evaluation-cache'],
    ['skipPerfectParentReflection', '--skip-perfect-parent-reflection'],
  ] as const) if (spec[field] === true) args.push(flag)
  return args
}

async function waitForChild(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => signal ? reject(new Error(`GEPA killed by ${signal}`)) : resolve(code ?? 1))
  })
}

export async function hostedOptimizationCommand(io: Io): Promise<number> {
  let runId = ''
  let coordinator = ''
  let bootSecret = ''
  const cleanups: Array<() => void> = []
  let terminalOutcomeChosen = false
  try {
    runId = required('ORIZU_RUN_ID')
    const tokenUrl = required('ORIZU_AGENT_TOKEN_URL')
    bootSecret = required('ORIZU_BOOT_SECRET')
    coordinator = required('ORIZU_COORDINATOR_URL')
    const baseUrl = required('ORIZU_BASE_URL')
    const tokenResponse = await fetch(tokenUrl, {
      headers: { authorization: `Bearer ${bootSecret}` }, signal: AbortSignal.timeout(10_000),
    })
    if (!tokenResponse.ok) throw new Error(`agent token pull failed (${tokenResponse.status})`)
    const payload = await tokenResponse.json() as TokenPayload
    if (!payload.token || !payload.jobSpec || !payload.projectRef) throw new Error('agent token payload is incomplete')
    const runtime = mkdtempSync(join(tmpdir(), 'orizu-hosted-optimization-runtime-'))
    cleanups.push(() => rmSync(runtime, { recursive: true, force: true }))
    const tokenFile = join(runtime, 'agent-token')
    const resultFile = join(runtime, 'result.json')
    const writeToken = (value: string) => {
      const next = `${tokenFile}.next`; writeFileSync(next, value, { mode: 0o600 }); renameSync(next, tokenFile)
    }
    const rotationDelay = (value: string | undefined) => {
      const expiry = Date.parse(value ?? '')
      const floor = Number(process.env.ORIZU_HOSTED_OPTIMIZATION_ROTATION_FLOOR_MS) || 30_000
      return Number.isFinite(expiry) ? Math.max(floor, expiry - Date.now() - 10 * 60_000) : 50 * 60_000
    }
    writeToken(payload.token)
    let rotation: ReturnType<typeof setTimeout> | undefined
    const rotate = async () => {
      try {
        const response = await fetch(tokenUrl, { headers: { authorization: `Bearer ${bootSecret}` }, signal: AbortSignal.timeout(10_000) })
        const fresh = await response.json() as TokenPayload
        if (!response.ok || !fresh.token) throw new Error('token rotation failed')
        writeToken(fresh.token)
        rotation = setTimeout(rotate, rotationDelay(fresh.expiresAt)); rotation.unref()
      } catch { rotation = setTimeout(rotate, 30_000); rotation.unref() }
    }
    rotation = setTimeout(rotate, rotationDelay(payload.expiresAt)); rotation.unref()
    cleanups.push(() => { if (rotation) clearTimeout(rotation) })
    const candidate = await materializeRunner(baseUrl, payload.token, requiredField(payload.jobSpec, 'runnerVersionId'))
    cleanups.push(candidate.cleanup)
    const scorer = await materializeRunner(baseUrl, payload.token, requiredField(payload.jobSpec, 'scorerRunnerVersionId'))
    cleanups.push(scorer.cleanup)
    const child = spawn(process.execPath, [process.argv[1], ...gepaArgs(
      payload.jobSpec, payload.projectRef, candidate.dir, scorer.dir
    )], {
      env: {
        ...process.env, ORIZU_API_URL: baseUrl, ORIZU_TOKEN: undefined,
        ORIZU_TOKEN_FILE: tokenFile, ORIZU_HOSTED_RESULT_FILE: resultFile,
        ORIZU_HOSTED_OPTIMIZATION_RUN_ID: runId,
        ...(payload.jobSpec.candidateProposerConfig
          ? { ORIZU_HOSTED_SKILLED_PROPOSER_CONFIG: JSON.stringify(payload.jobSpec.candidateProposerConfig) }
          : {}),
        ...(payload.jobSpec.instructionSetProfileVersionId
          ? { ORIZU_HOSTED_INSTRUCTION_SET_PROFILE_VERSION_ID: payload.jobSpec.instructionSetProfileVersionId }
          : {}),
      }, stdio: 'inherit',
    })
    const childExit = waitForChild(child)
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve); child.once('error', reject)
    })
    await callback(coordinator, runId, bootSecret, 'ready', { status: 'ready' })
    const exit = await childExit
    if (exit !== 0) throw new Error(`GEPA exited ${exit}`)
    const result = JSON.parse(readFileSync(resultFile, 'utf8')) as Record<string, unknown>
    terminalOutcomeChosen = true
    await callback(coordinator, runId, bootSecret, 'result', result)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.printErr?.(message)
    if (!terminalOutcomeChosen && runId && coordinator && bootSecret) {
      await callback(coordinator, runId, bootSecret, 'result', {
        status: 'failed', failureReason: 'hosted_optimization_process_failed',
      }).catch(() => undefined)
    }
    return 1
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup()
  }
}

function requiredField(spec: JobSpec, field: keyof JobSpec): string {
  const value = spec[field]
  if (typeof value !== 'string' || !value) throw new Error(`hosted job spec is missing ${String(field)}`)
  return value
}
