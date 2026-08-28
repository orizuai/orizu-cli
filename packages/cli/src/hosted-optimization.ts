import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { getGepaPythonPathEntries } from './gepa-python-paths.js'
import { materializeRunnerVersion, cleanupMaterializedRunners } from './runner-version-materialization.js'
import { prepareSkilledProposerLaunch, spawnSkilledProposerChild } from './skilled-proposer-launch.js'
import { validNormalizedSkilledProposerConfig } from './skilled-proposer-wire.js'
interface HostedOptimizationIo { printErr?: (value: string) => void }
interface BootEnvironment { agentTokenUrl: URL; baseUrl: URL; bootSecret: string; coordinatorUrl: URL; runId: string; sessionId: string }
interface MintResponse extends Record<string, unknown> { token: string; runId: string; projectRef: string; jobSpec: Record<string, unknown> }
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
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
    || !isRecord(value.reflectionProviderSettings)) return false
  const skilled = value.candidateProposer === 'skilled-proposer'
  if ((value.candidateProposer !== null && !skilled)
    || (skilled && (!validNormalizedSkilledProposerConfig(value.candidateProposerConfig)
      || value.reflectionPromptTemplate !== null))
    || (!skilled && [value.candidateProposerConfig, value.proposalMaxCalls, value.proposalMaxTokens]
      .some(item => item !== null))) return false
  return true
}
async function postBoot(boot: BootEnvironment, suffix: 'ready' | 'result', body: Record<string, unknown>): Promise<void> {
  const response = await fetch(new URL(`optimizations/${boot.runId}/${suffix}`, boot.coordinatorUrl), {
    method: 'POST', headers: { authorization: `Bearer ${boot.bootSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`coordinator ${suffix} refused status ${response.status}`)
}
async function postTerminal(boot: BootEnvironment, body: Record<string, unknown>): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) { try { await postBoot(boot, 'result', body); return }
    catch (cause) { if (attempt === 1) throw cause }
  }
}
async function mint(boot: BootEnvironment): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(boot.agentTokenUrl, { headers: { authorization: `Bearer ${boot.bootSecret}` } })
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
async function startTokenBroker(boot: BootEnvironment, initial: MintResponse): Promise<{ url: string; stop: () => void; token: () => string }> {
  const nonce = randomUUID(), fingerprint = JSON.stringify(initial.jobSpec)
  let activeToken = initial.token
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method !== 'GET' || url.pathname !== `/${nonce}` || url.search) {
        response.writeHead(404).end(); return
      }
      try {
        const fresh = await mint(boot), parsed = fresh.response.ok ? parseMint(fresh.body, boot) : null
        if (!parsed || parsed.projectRef !== initial.projectRef || JSON.stringify(parsed.jobSpec) !== fingerprint) throw new Error()
        activeToken = parsed.token
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: parsed.token }))
      } catch {
        response.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'token refresh failed' }))
      }
    })().catch(() => response.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'token refresh failed' })))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('token broker failed to bind')
  return { url: `http://127.0.0.1:${address.port}/${nonce}`, stop: () => { server.close() }, token: () => activeToken }
}
async function spawnOfficial(python: string, environment: NodeJS.ProcessEnv, ready: () => Promise<void>): Promise<{ status: number | null; error?: Error; stderr: string }> {
  if (environment.ORIZU_CANDIDATE_PROPOSER === 'skilled-proposer') {
    const result = await spawnSkilledProposerChild(python, ['-m', 'orizu_gepa_connector'], 'official', environment, ready)
    return { ...result, stderr: result.error?.message ?? '' }
  }
  const child = spawn(python, ['-m', 'orizu_gepa_connector'], { env: environment, stdio: ['inherit', 'inherit', 'pipe'] })
  let stderr = '', error: Error | undefined
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += String(chunk); process.stderr.write(chunk) })
  const spawned = new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  const closed = new Promise<number | null>(resolve => { child.once('error', cause => { error = cause }); child.once('close', resolve) })
  await spawned
  try { await ready() }
  catch (cause) { child.kill('SIGTERM'); await closed; throw cause }
  return { status: await closed, ...(error ? { error } : {}), stderr }
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
    io.printErr?.(`hosted_optimization_invalid_environment${message}`)
    return 1
  }
  delete process.env.ORIZU_BOOT_SECRET
  let reason = 'hosted_optimization_mint_refused'
  const cleanups: Array<() => void> = []
  let broker: Awaited<ReturnType<typeof startTokenBroker>> | undefined
  const resultFile = join(tmpdir(), `orizu-hosted-optimization-result-${boot.runId}-${randomUUID()}.json`)
  try {
    const first = await mint(boot)
    if (first.response.status === 422) reason = 'hosted_optimization_spec_missing'
    if (!first.response.ok) throw new Error()
    const minted = parseMint(first.body, boot)
    if (!minted) {
      reason = isRecord(first.body) && first.body.runId !== undefined && first.body.runId !== boot.runId
        ? 'hosted_optimization_mint_refused' : 'hosted_optimization_spec_missing'
      throw new Error()
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
    const result = await spawnOfficial(launch.python, launch.environment, () => postBoot(boot, 'ready', { status: 'ready' }))
    if (result.error || result.status !== 0) throw new Error()
    try { await postTerminal(boot, readTerminalResult(resultFile)) }
    catch { io.printErr?.(reason); return 1 }
    return 0
  } catch {
    try { await postTerminal(boot, { status: 'failed', failureReason: reason }) } catch { /* retain original phase */ }
    io.printErr?.(reason)
    return 1
  } finally {
    broker?.stop()
    rmSync(resultFile, { force: true })
    cleanupMaterializedRunners(cleanups)
  }
}
