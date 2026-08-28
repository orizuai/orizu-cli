import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { runPipedChild } from './child-output-tee.js'
import { getGepaPythonPathEntries } from './gepa-python-paths.js'
import { INJECTED_ENV_VARS_ENV } from './hosted-environment.js'
import { materializeRunnerVersion, cleanupMaterializedRunners } from './runner-version-materialization.js'
import { prepareSkilledProposerLaunch, spawnSkilledProposerChild } from './skilled-proposer-launch.js'
import { hostedProviderFromModel } from './hosted-provider-settings.js'
import { validNormalizedSkilledProposerConfig } from './skilled-proposer-wire.js'
import { REDACTION_PLACEHOLDER, redactSecrets } from './secret-redaction.js'
interface HostedOptimizationIo { printErr?: (value: string) => void | Promise<void> }
interface BootEnvironment { agentTokenUrl: URL; baseUrl: URL; bootSecret: string; coordinatorUrl: URL; runId: string; sessionId: string }
interface MintResponse extends Record<string, unknown> { token: string; runId: string; projectRef: string; jobSpec: Record<string, unknown> }
interface TokenBroker { url: string; stop(): void; token(): string; secrets(): string[] }
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const DIAGNOSTIC_TAIL_MAX_BYTES = 1024
const DIAGNOSTIC_RAW_MAX_BYTES = 64 * 1024
const INJECTED_SECRET_ENV_NAMES = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'BRAINTRUST_API_KEY', 'ALI_1505_ENDPOINT_OVERRIDE_API_KEY', 'ORIZU_TOKEN',
] as const
const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

interface CapturedDiagnosticSource {
  state: 'captured'
}

interface ProcessDiagnosticSource extends CapturedDiagnosticSource {
  stdout_tail: string
  stderr_tail: string
}

interface BootDiagnosticSource extends CapturedDiagnosticSource {
  tail: string
}

interface MissingDiagnosticSource {
  state: 'no_diagnostics_captured'
}

interface FailureDiagnostics {
  process: ProcessDiagnosticSource | MissingDiagnosticSource
  boot: BootDiagnosticSource | MissingDiagnosticSource
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= maxBytes) return value
  let start = bytes.byteLength - maxBytes
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1
  return bytes.subarray(start).toString('utf8')
}

class BoundedTextCapture {
  private value = ''
  private pending = ''
  hasOutput = false

  constructor(private readonly secrets: () => readonly string[]) {}

  append(chunk: string): void {
    if (!chunk) return
    this.hasOutput = true
    const secrets = this.secrets()
      .filter(secret => secret.length > 0)
      .sort((left, right) => right.length - left.length)
    const overlapLength = secrets.reduce(
      (longest, secret) => Math.max(longest, secret.length - 1),
      0
    )
    const combined = this.pending + chunk
    const safeLength = Math.max(0, combined.length - overlapLength)
    const stableParts: string[] = []
    let cursor = 0
    let literalStart = 0
    while (cursor < safeLength) {
      const matchedSecret = secrets.find(secret => combined.startsWith(secret, cursor))
      if (!matchedSecret) {
        cursor += 1
        continue
      }
      stableParts.push(combined.slice(literalStart, cursor), REDACTION_PLACEHOLDER)
      cursor += matchedSecret.length
      literalStart = cursor
    }
    stableParts.push(combined.slice(literalStart, cursor))
    this.pending = combined.slice(cursor)
    this.value = utf8Tail(
      this.value + redactSecrets(stableParts.join(''), { secrets }),
      DIAGNOSTIC_RAW_MAX_BYTES
    )
  }

  tail(): string {
    const secrets = this.secrets()
      .filter(secret => secret.length > 0)
      .sort((left, right) => right.length - left.length)
    return utf8Tail(
      redactSecrets(this.value + this.pending, { secrets }),
      DIAGNOSTIC_TAIL_MAX_BYTES
    )
  }
}

interface ProcessOutputCapture {
  stdout: BoundedTextCapture
  stderr: BoundedTextCapture
}

function createProcessOutputCapture(secrets: () => readonly string[]): ProcessOutputCapture {
  return { stdout: new BoundedTextCapture(secrets), stderr: new BoundedTextCapture(secrets) }
}

function buildFailureDiagnostics(
  processOutput: ProcessOutputCapture,
  bootOutput: BoundedTextCapture
): FailureDiagnostics {
  const hasProcessOutput = processOutput.stdout.hasOutput || processOutput.stderr.hasOutput
  return {
    process: hasProcessOutput
      ? {
          state: 'captured',
          stdout_tail: processOutput.stdout.tail(),
          stderr_tail: processOutput.stderr.tail(),
        }
      : { state: 'no_diagnostics_captured' },
    boot: bootOutput.hasOutput
      ? { state: 'captured', tail: bootOutput.tail() }
      : { state: 'no_diagnostics_captured' },
  }
}

function failureDetail(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  if (isRecord(value) && typeof value.error === 'string') return value.error
  return ''
}

function injectedSecrets(
  boot: BootEnvironment,
  broker?: TokenBroker
): string[] {
  const registeredNames = (process.env[INJECTED_ENV_VARS_ENV] ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(name => ENVIRONMENT_VARIABLE_NAME.test(name))
  return Array.from(new Set([
    boot.bootSecret,
    ...[...INJECTED_SECRET_ENV_NAMES, ...registeredNames].map(name => process.env[name]),
    ...(broker?.secrets() ?? []),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)))
}
function secureUrl(value: string): URL {
  const url = new URL(value)
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname)
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error()
  return url
}
function bootEnvironment(): BootEnvironment {
  const required = ['ORIZU_RUN_ID', 'ORIZU_SESSION_ID', 'ORIZU_AGENT_TOKEN_URL', 'ORIZU_BASE_URL',
    'ORIZU_BOOT_SECRET', 'ORIZU_COORDINATOR_URL', 'ANTHROPIC_API_KEY'] as const
  const missing = required.find(name => !process.env[name])
  if (missing) throw new Error(`${missing} is required`)
  const runId = process.env.ORIZU_RUN_ID!, sessionId = process.env.ORIZU_SESSION_ID!
  if (!UUID_V4.test(runId)) throw new Error('ORIZU_RUN_ID must be a UUIDv4')
  if (!UUID_V4.test(sessionId)) throw new Error('ORIZU_SESSION_ID must be a UUIDv4')
  const agentTokenUrl = secureUrl(process.env.ORIZU_AGENT_TOKEN_URL!)
  const baseUrl = secureUrl(process.env.ORIZU_BASE_URL!)
  const coordinatorUrl = secureUrl(process.env.ORIZU_COORDINATOR_URL!)
  if (baseUrl.pathname !== '/' || baseUrl.search || coordinatorUrl.pathname !== '/' || coordinatorUrl.search
    || agentTokenUrl.search || agentTokenUrl.origin !== coordinatorUrl.origin
    || agentTokenUrl.pathname !== `/optimizations/${runId}/agent-token`) throw new Error()
  return { agentTokenUrl, baseUrl, bootSecret: process.env.ORIZU_BOOT_SECRET!, coordinatorUrl, runId, sessionId }
}
function validJobSpec(value: unknown, projectRef: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof projectRef !== 'string' || !/^[^/\s]+\/[^/\s]+$/u.test(projectRef)
    || value.schemaVersion !== 1 || value.engine !== 'official') return false
  const ids = ['optimizerVersionId', 'runnerVersionId', 'scorerVersionId', 'scorerRunnerVersionId', 'datasetVersionId', 'splitSetId']
  if (ids.some(field => typeof value[field] !== 'string' || !UUID.test(value[field]))) return false
  const candidates = value.candidateVersionIds
  const profile = value.instructionSetProfileVersionId
  if (!Array.isArray(candidates) || candidates.some(id => typeof id !== 'string' || !UUID.test(id))
    || (candidates.length > 0) === (typeof profile === 'string') || candidates.length > 1
    || (typeof profile === 'string' && !UUID.test(profile))) return false
  const booleans = ['allowDegenerateSeed', 'disableEvaluationCache', 'autoPromote', 'logRowSnapshots',
    'skipPerfectParentReflection']
  if (booleans.some(field => typeof value[field] !== 'boolean') || value.promotionLabel !== null
    || !isRecord(value.reflectionProviderSettings) || typeof value.reflectionModel !== 'string'
    || !hostedProviderFromModel(value.reflectionModel)) return false
  const skilled = value.candidateProposer === 'skilled-proposer'
  if ((value.candidateProposer !== null && !skilled)
    || (skilled && (!validNormalizedSkilledProposerConfig(value.candidateProposerConfig)
      || value.reflectionPromptTemplate !== null))
    || (!skilled && [value.candidateProposerConfig, value.proposalMaxCalls, value.proposalMaxTokens]
      .some(item => item !== null))) return false
  return true
}
class CoordinatorCallbackError extends Error {
  constructor(public readonly status: number, suffix: 'ready' | 'result') {
    super(`coordinator ${suffix} refused status ${status}`)
  }
}
// Readiness is intentionally one bounded attempt: an ambiguous ready response
// terminates the child through runPipedChild rather than spending without a
// coordinator lease. Only the already-computed terminal result gets retries.
async function postBoot(boot: BootEnvironment, suffix: 'ready' | 'result', body: Record<string, unknown>): Promise<void> {
  const response = await fetch(new URL(`optimizations/${boot.runId}/${suffix}`, boot.coordinatorUrl), {
    method: 'POST', headers: { authorization: `Bearer ${boot.bootSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new CoordinatorCallbackError(response.status, suffix)
}
async function postTerminal(boot: BootEnvironment, body: Record<string, unknown>): Promise<void> {
  const attempts = 8
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { await postBoot(boot, 'result', body); return }
    catch (cause) {
      if (cause instanceof CoordinatorCallbackError && cause.status < 500 && cause.status !== 404) throw cause
      if (attempt === attempts - 1) throw cause
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(10_000, 250 * 2 ** attempt)))
  }
}
async function mint(boot: BootEnvironment): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(boot.agentTokenUrl, {
    headers: { authorization: `Bearer ${boot.bootSecret}` },
    signal: AbortSignal.timeout(10_000),
  })
  let body: unknown = null
  try { body = await response.json() } catch { /* classified by the caller */ }
  return { response, body }
}
function parseMint(body: unknown, boot: BootEnvironment): MintResponse | null {
  if (!isRecord(body) || body.runId !== boot.runId || typeof body.token !== 'string' || !body.token
    || typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt))
    || !validJobSpec(body.jobSpec, body.projectRef)) return null
  return body as MintResponse
}
function childEnvironment(
  boot: BootEnvironment,
  minted: MintResponse,
  candidateDir: string,
  scorerDir: string,
  refreshUrl: string,
  resultFile: string
): NodeJS.ProcessEnv {
  const spec = minted.jobSpec
  const environment: NodeJS.ProcessEnv = {
    ...process.env, ORIZU_API_URL: boot.baseUrl.origin, ORIZU_BASE_URL: boot.baseUrl.origin,
    ORIZU_TOKEN: minted.token, ORIZU_PROJECT: minted.projectRef,
    ORIZU_HOSTED_OPTIMIZATION_RUN_ID: boot.runId, ORIZU_AGENT_TOKEN_URL: refreshUrl,
    ORIZU_HOSTED_RESULT_FILE: resultFile,
    ORIZU_CANDIDATE_RUNNER_DIR: candidateDir, ORIZU_SCORER_RUNNER_DIR: scorerDir,
    ORIZU_VERIFIED_RUNNER_DIRS: JSON.stringify([candidateDir, scorerDir]),
    PYTHONPATH: getGepaPythonPathEntries(process.env.PYTHONPATH).join(delimiter), PYTHONUNBUFFERED: '1',
  }
  const fields: Array<[string, string]> = [
    ['ORIZU_OPTIMIZER_VERSION_ID', 'optimizerVersionId'], ['ORIZU_RUNNER_VERSION_ID', 'runnerVersionId'],
    ['ORIZU_SCORER_VERSION_ID', 'scorerVersionId'], ['ORIZU_SCORER_RUNNER_VERSION_ID', 'scorerRunnerVersionId'],
    ['ORIZU_SCORER_INPUT_CONTRACT', 'scorerInputContract'], ['ORIZU_SCORER_CANDIDATE_FIELD', 'scorerCandidateField'],
    ['ORIZU_DATASET_VERSION_ID', 'datasetVersionId'], ['ORIZU_SPLIT_SET_ID', 'splitSetId'],
    ['ORIZU_TRAIN_SPLIT', 'trainSplitName'], ['ORIZU_VALIDATION_SPLIT', 'validationSplitName'],
    ['ORIZU_BUDGET', 'budget'], ['ORIZU_CANDIDATE_PROPOSER', 'candidateProposer'],
    ['ORIZU_COMPONENT_SELECTOR', 'componentSelector'], ['ORIZU_PROPOSAL_MAX_CALLS', 'proposalMaxCalls'],
    ['ORIZU_PROPOSAL_MAX_TOKENS', 'proposalMaxTokens'], ['ORIZU_MAX_ITERATIONS', 'maxIterations'],
    ['ORIZU_MAX_CANDIDATE_PROPOSALS', 'maxCandidateProposals'], ['ORIZU_MAX_FULL_EVALS', 'maxFullEvals'],
    ['ORIZU_MAX_METRIC_CALLS', 'maxMetricCalls'], ['ORIZU_MINIBATCH_SIZE', 'minibatchSize'],
    ['ORIZU_NUM_THREADS', 'numThreads'], ['ORIZU_CANDIDATE_SELECTION_STRATEGY', 'candidateSelectionStrategy'],
    ['ORIZU_EPSILON', 'epsilon'], ['ORIZU_REFLECTION_MODEL', 'reflectionModel'],
    ['ORIZU_REFLECTION_TEMPERATURE', 'reflectionTemperature'], ['ORIZU_REFLECTION_MAX_TOKENS', 'reflectionMaxTokens'],
    ['ORIZU_REFLECTION_RETRY_ATTEMPTS', 'reflectionRetryAttempts'],
    ['ORIZU_REFLECTION_HTTP_TIMEOUT_SECONDS', 'reflectionHttpTimeoutSeconds'],
    ['ORIZU_REFLECTION_PROMPT_TEMPLATE', 'reflectionPromptTemplate'], ['ORIZU_OBJECTIVE', 'objective'],
    ['ORIZU_SEED', 'seed'],
  ]
  for (const name of [...fields.map(([name]) => name), 'ORIZU_PROMPT_VERSION_ID', 'ORIZU_INSTRUCTION_SET_PROFILE_VERSION_ID',
    'ORIZU_REFLECTION_PROVIDER_SETTINGS', 'ORIZU_SKILLED_PROPOSER_CONFIG', 'ORIZU_ALLOW_DEGENERATE_SEED',
    'ORIZU_DISABLE_EVALUATION_CACHE', 'ORIZU_AUTO_PROMOTE', 'ORIZU_LOG_ROW_SNAPSHOTS', 'ORIZU_PROMOTION_LABEL',
    'ORIZU_SKIP_PERFECT_PARENT_REFLECTION']) delete environment[name]
  for (const [name, field] of fields) if (spec[field] !== null && spec[field] !== undefined) environment[name] = String(spec[field])
  const candidates = spec.candidateVersionIds as string[]
  environment[candidates.length ? 'ORIZU_PROMPT_VERSION_ID' : 'ORIZU_INSTRUCTION_SET_PROFILE_VERSION_ID'] =
    candidates[0] ?? String(spec.instructionSetProfileVersionId)
  environment.ORIZU_REFLECTION_PROVIDER_SETTINGS = JSON.stringify(spec.reflectionProviderSettings)
  if (spec.candidateProposerConfig !== null) environment.ORIZU_SKILLED_PROPOSER_CONFIG = JSON.stringify(spec.candidateProposerConfig)
  for (const [name, field] of [['ORIZU_ALLOW_DEGENERATE_SEED', 'allowDegenerateSeed'],
    ['ORIZU_DISABLE_EVALUATION_CACHE', 'disableEvaluationCache'], ['ORIZU_AUTO_PROMOTE', 'autoPromote'],
    ['ORIZU_LOG_ROW_SNAPSHOTS', 'logRowSnapshots']] as const) if (spec[field] === true) environment[name] = '1'
  environment.ORIZU_SKIP_PERFECT_PARENT_REFLECTION = spec.skipPerfectParentReflection ? '1' : '0'
  return environment
}
async function startTokenBroker(
  boot: BootEnvironment,
  initial: MintResponse
): Promise<TokenBroker> {
  const nonce = randomUUID(), fingerprint = JSON.stringify(initial.jobSpec)
  let activeToken = initial.token
  const tokens = new Set([initial.token])
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    response.setHeader('content-type', 'application/json')
    if (request.method !== 'GET' || url.pathname !== `/${nonce}` || url.search) {
      response.writeHead(404).end()
      return
    }
    try {
      const fresh = await mint(boot)
      if (!fresh.response.ok) {
        const retryAfter = fresh.response.headers.get('retry-after')
        response.writeHead(fresh.response.status, retryAfter ? { 'retry-after': retryAfter } : {})
        response.end(JSON.stringify({ error: 'token refresh failed' }))
        return
      }
      const parsed = parseMint(fresh.body, boot)
      if (!parsed || parsed.projectRef !== initial.projectRef || JSON.stringify(parsed.jobSpec) !== fingerprint) throw new Error()
      activeToken = parsed.token
      tokens.add(parsed.token)
      response.end(JSON.stringify({ token: parsed.token }))
    } catch {
      response.writeHead(502).end(JSON.stringify({ error: 'token refresh failed' }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('token broker did not bind a TCP port')
  }
  return {
    url: `http://127.0.0.1:${address.port}/${nonce}`,
    stop: () => { server.close() },
    token: () => activeToken,
    secrets: () => [...tokens],
  }
}
async function spawnOfficial(
  python: string,
  environment: NodeJS.ProcessEnv,
  ready: () => Promise<void>,
  output: ProcessOutputCapture
): Promise<{ status: number | null; error?: Error }> {
  if (environment.ORIZU_CANDIDATE_PROPOSER === 'skilled-proposer') {
    return spawnSkilledProposerChild(
      python,
      ['-m', 'orizu_gepa_connector'],
      'official',
      environment,
      ready,
      {
        stdout: chunk => output.stdout.append(chunk),
        stderr: chunk => output.stderr.append(chunk),
      }
    )
  }
  return runPipedChild(
    python,
    ['-m', 'orizu_gepa_connector'],
    environment,
    ready,
    {
      stdout: chunk => output.stdout.append(chunk),
      stderr: chunk => output.stderr.append(chunk),
    }
  )
}
async function ensureFailedRun(
  boot: BootEnvironment,
  token: string,
  engineError: string,
  diagnostics: FailureDiagnostics
): Promise<void> {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const response = await fetch(new URL(`/api/cli/optimization-runs/${boot.runId}`, boot.baseUrl), {
    method: 'PATCH', headers, body: JSON.stringify({ status: 'failed', metadata: {
      failure_reason: 'hosted_optimization_process_failed', engine_error: engineError,
      failure_diagnostics: diagnostics,
    } }),
  })
  const body = response.ok ? await response.json() as Record<string, unknown> : {}
  const run = isRecord(body.optimizationRun) ? body.optimizationRun : {}, metadata = run.metadata
  if (!isRecord(metadata) || metadata.failure_reason !== 'hosted_optimization_process_failed'
    || typeof metadata.engine_error !== 'string' || !isRecord(metadata.failure_diagnostics)) {
    throw new Error('canonical hosted failure was not persisted')
  }
}
function readTerminalResult(path: string): Record<string, unknown> {
  if (!existsSync(path)) throw new Error('hosted optimization result file was not written')
  const body: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(body)) throw new Error('hosted optimization result file was malformed')
  return body
}
export async function hostedOptimizationCommand(io: HostedOptimizationIo): Promise<number> {
  let boot: BootEnvironment
  try { boot = bootEnvironment() } catch (error) {
    const message = error instanceof Error && error.message ? `: ${error.message}` : ''
    await io.printErr?.(`hosted_optimization_invalid_environment${message}`)
    return 1
  }
  delete process.env.ORIZU_BOOT_SECRET
  let reason = 'hosted_optimization_mint_refused'
  const cleanups: Array<() => void> = []
  let broker: TokenBroker | undefined
  const resultFile = join(tmpdir(), `orizu-hosted-optimization-result-${boot.runId}-${randomUUID()}.json`)
  const diagnosticSecrets = () => injectedSecrets(boot, broker)
  const processOutput = createProcessOutputCapture(diagnosticSecrets)
  const bootOutput = new BoundedTextCapture(diagnosticSecrets)
  let failureDiagnostics: FailureDiagnostics | undefined
  try {
    const first = await mint(boot)
    if (first.response.status === 422) reason = 'hosted_optimization_spec_missing'
    if (!first.response.ok) {
      throw new Error(failureDetail(first.body) || `mint status ${first.response.status}`)
    }
    const minted = parseMint(first.body, boot)
    if (!minted) {
      reason = isRecord(first.body) && first.body.runId !== undefined && first.body.runId !== boot.runId
        ? 'hosted_optimization_mint_refused' : 'hosted_optimization_spec_missing'
      throw new Error(
        failureDetail(first.body) || 'mint response did not contain a valid hosted job specification'
      )
    }
    process.env.ORIZU_BASE_URL = boot.baseUrl.origin
    process.env.ORIZU_TOKEN = minted.token
    reason = 'hosted_optimization_materialization_failed'
    const candidate = await materializeRunnerVersion(String(minted.jobSpec.runnerVersionId)); cleanups.push(candidate.cleanup)
    const scorer = await materializeRunnerVersion(String(minted.jobSpec.scorerRunnerVersionId)); cleanups.push(scorer.cleanup)
    broker = await startTokenBroker(boot, minted)
    const environment = childEnvironment(boot, minted, candidate.runnerDir, scorer.runnerDir, broker.url, resultFile)
    const launch = prepareSkilledProposerLaunch(process.env.PYTHON || 'python3', 'official', environment)
    reason = 'hosted_optimization_process_failed'
    const result = await spawnOfficial(
      launch.python,
      launch.environment,
      () => postBoot(boot, 'ready', { status: 'ready' }),
      processOutput
    )
    if (result.error || result.status !== 0) {
      const processFailure = result.error?.message || `optimizer exited with status ${result.status}`
      const secrets = injectedSecrets(boot, broker)
      failureDiagnostics = buildFailureDiagnostics(processOutput, bootOutput)
      const engineError = utf8Tail(
        redactSecrets(processFailure, { secrets }),
        DIAGNOSTIC_TAIL_MAX_BYTES
      )
      await ensureFailedRun(boot, broker.token(), engineError, failureDiagnostics)
      throw new Error(processFailure)
    }
    try { await postTerminal(boot, readTerminalResult(resultFile)) }
    catch { await io.printErr?.(reason); return 1 }
    return 0
  } catch (cause) {
    if (!failureDiagnostics) {
      bootOutput.append(failureDetail(cause) || reason)
      failureDiagnostics = buildFailureDiagnostics(
        processOutput,
        bootOutput
      )
    }
    try {
      await postTerminal(boot, {
        status: 'failed',
        failureReason: reason,
        failureDiagnostics,
      })
    } catch { /* retain original phase */ }
    await io.printErr?.(reason)
    return 1
  } finally {
    broker?.stop()
    rmSync(resultFile, { force: true })
    cleanupMaterializedRunners(cleanups)
  }
}
