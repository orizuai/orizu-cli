import { randomUUID } from 'node:crypto'

import { dispatchGepaEngine } from './gepa-engine-dispatch.js'
import { parseHostedGepaNumericValue } from './hosted-gepa-numeric-values.js'
import { authedFetch } from './http.js'
import { hostedProviderFromModel, hostedProviderSettingsError, unsupportedHostedProviderMessage } from './hosted-provider-settings.js'
import {
  hostedOptimizationRefusalBody,
  type HostedOptimizationRefusalCode,
} from './hosted-optimization-refusals.js'
import { parseJsonResponse } from './json-response.js'
import {
  extractFlagValue,
  RunnerVerificationError,
  verifyRunnerDirRegistered,
} from './runner-dir-verify.js'

interface HostedGepaOptions {
  args: string[]
  project: string
  environment: NodeJS.ProcessEnv
  json: boolean
  printJson: (value: Record<string, unknown>) => void
  printLine: (value: string) => void
  /** Test seam for cleanup-failure orchestration; production always uses the real verifier. */
  verifyRunnerDir?: typeof verifyRunnerDirRegistered
}

function argumentValue(args: string[], name: string): string | null {
  const index = args.indexOf(name)
  if (index >= 0 && index + 1 < args.length) return args[index + 1]
  return args.find(argument => argument.startsWith(`${name}=`))?.slice(name.length + 1) ?? null
}

function dispatchArgs(args: string[]): string[] {
  const filtered: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--hosted') continue
    if (args[index] === '--launch-intent-id') { index += 1; continue }
    if (args[index].startsWith('--launch-intent-id=')) continue
    filtered.push(args[index])
  }
  return filtered
}

export async function runHostedGepaOptimization(options: HostedGepaOptions): Promise<void> {
  const refuse = (code: HostedOptimizationRefusalCode, detail?: string): true => {
    const body = hostedOptimizationRefusalBody(code, { detail })
    if (options.json) {
      options.printJson(body)
      process.exitCode = 1
      return true
    }
    throw new Error(`${detail ?? body.error} ${body.remediation}`)
  }
  const hasLaunchIntent = options.args.some(argument =>
    argument === '--launch-intent-id' || argument.startsWith('--launch-intent-id='))
  const explicitLaunchIntent = argumentValue(options.args, '--launch-intent-id')
  if (hasLaunchIntent && (!explicitLaunchIntent || explicitLaunchIntent.startsWith('-')
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(explicitLaunchIntent))) {
    throw new Error('--launch-intent-id must be a UUIDv4 value when provided.')
  }
  const args = dispatchArgs(options.args)
  if (['--max-iterations', '--max-full-evals', '--max-metric-calls', '--max-candidate-proposals']
    .some(flag => args.some(argument => argument === flag || argument.startsWith(`${flag}=`)))) {
    refuse(
      'hosted_optimization_budget_exceeds_ceiling',
      'Hosted optimization requires a named --budget preset; numeric budget controls are not accepted.'
    )
    return
  }
  for (const [dirFlag, versionFlag] of [
    ['--candidate-runner-dir', '--runner-version-id'],
    ['--scorer-runner-dir', '--scorer-runner-version-id'],
  ] as const) {
    for (const flag of [dirFlag, versionFlag]) {
      const occurrences = args.filter(argument =>
        argument === flag || argument.startsWith(`${flag}=`)
      ).length
      if (occurrences > 1) {
        refuse(
          'hosted_optimization_runner_flags_ambiguous',
          `Duplicate ${flag}: pass each runner flag exactly once so verified and launched identities cannot diverge.`
        )
        return
      }
    }
    const dir = extractFlagValue(args, dirFlag)
    if (!dir) continue
    const runnerVersionId = extractFlagValue(args, versionFlag)
    if (!runnerVersionId) {
      refuse(dirFlag === '--scorer-runner-dir'
        ? 'hosted_optimization_scorer_runner_not_registered'
        : 'hosted_optimization_candidate_runner_not_registered')
      return
    }
    let verified: Awaited<ReturnType<typeof verifyRunnerDirRegistered>>
    try {
      verified = await (options.verifyRunnerDir ?? verifyRunnerDirRegistered)({
        runnerVersionId, dir, flag: dirFlag,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Runner verification request failed.'
      if (!(error instanceof RunnerVerificationError)) {
        if (detail.startsWith('Session expired.') || detail.startsWith('Not logged in for ')) {
          refuse('hosted_optimization_runner_verification_auth_failed', detail)
          return
        }
        refuse('hosted_optimization_runner_verification_unavailable', detail)
        return
      }
      const code: HostedOptimizationRefusalCode = error.kind === 'directory_mismatch'
        ? 'hosted_optimization_runner_dir_mismatch'
        : error.kind === 'not_registered'
          ? dirFlag === '--scorer-runner-dir'
            ? 'hosted_optimization_scorer_runner_not_registered'
            : 'hosted_optimization_candidate_runner_not_registered'
          : error.kind === 'manifest_invalid'
            ? 'hosted_optimization_runner_manifest_invalid'
            : error.kind === 'authentication'
              ? 'hosted_optimization_runner_verification_auth_failed'
              : error.kind === 'authorization'
                ? 'hosted_optimization_runner_verification_forbidden'
                : 'hosted_optimization_runner_verification_unavailable'
      refuse(code, detail)
      return
    }
    try {
      verified.cleanup()
    } catch (error) {
      refuse(
        'hosted_optimization_runner_verification_cleanup_failed',
        error instanceof Error ? error.message : 'Runner verification cleanup failed.'
      )
      return
    }
  }
  const dispatch = dispatchGepaEngine(args, options.project, options.environment)
  if (dispatch.engine !== 'official') {
    refuse('hosted_optimization_unsupported_option', 'Hosted optimization requires the official GEPA engine.')
    return
  }
  const env = dispatch.environment
  if (env.ORIZU_PROMOTION_LABEL !== undefined) {
    refuse('hosted_optimization_unsupported_option', 'Hosted optimization does not accept a promotion label.')
    return
  }
  const required = [
    ['ORIZU_OPTIMIZER_VERSION_ID', '--optimizer-version-id'], ['ORIZU_RUNNER_VERSION_ID', '--runner-version-id'],
    ['ORIZU_SCORER_VERSION_ID', '--scorer-version-id'], ['ORIZU_SCORER_RUNNER_VERSION_ID', '--scorer-runner-version-id'],
    ['ORIZU_DATASET_VERSION_ID', '--dataset-version-id'], ['ORIZU_SPLIT_SET_ID', '--split-set-id'],
  ] as const
  for (const [name, flag] of required) if (!env[name]) throw new Error(`${flag} is required for hosted optimization.`)
  const providerSettings = JSON.parse(env.ORIZU_REFLECTION_PROVIDER_SETTINGS ?? '{}') as Record<string, unknown>
  const reflectionModel = env.ORIZU_REFLECTION_MODEL ?? 'anthropic/'
  const reflectionProvider = reflectionModel.split('/', 1)[0] || reflectionModel
  if (!hostedProviderFromModel(reflectionModel)) {
    refuse(
      'hosted_optimization_unsupported_provider',
      unsupportedHostedProviderMessage(reflectionProvider)
    )
    return
  }
  const providerSettingsError = hostedProviderSettingsError(providerSettings,
    reflectionModel, env.ORIZU_REFLECTION_TEMPERATURE)
  if (providerSettingsError) throw new Error(providerSettingsError)
  const optional: Record<string, unknown> = {}
  const fields: Array<[string, string, 'number' | 'json' | 'boolean' | 'string']> = [
    ['candidateProposer', 'ORIZU_CANDIDATE_PROPOSER', 'string'], ['candidateProposerConfig', 'ORIZU_SKILLED_PROPOSER_CONFIG', 'json'],
    ['proposalMaxCalls', 'ORIZU_PROPOSAL_MAX_CALLS', 'number'], ['proposalMaxTokens', 'ORIZU_PROPOSAL_MAX_TOKENS', 'number'],
    ['minibatchSize', 'ORIZU_MINIBATCH_SIZE', 'number'], ['numThreads', 'ORIZU_NUM_THREADS', 'number'],
    ['candidateSelectionStrategy', 'ORIZU_CANDIDATE_SELECTION_STRATEGY', 'string'], ['epsilon', 'ORIZU_EPSILON', 'number'],
    ['reflectionModel', 'ORIZU_REFLECTION_MODEL', 'string'], ['reflectionTemperature', 'ORIZU_REFLECTION_TEMPERATURE', 'number'],
    ['reflectionMaxTokens', 'ORIZU_REFLECTION_MAX_TOKENS', 'number'], ['reflectionRetryAttempts', 'ORIZU_REFLECTION_RETRY_ATTEMPTS', 'number'],
    ['reflectionHttpTimeoutSeconds', 'ORIZU_REFLECTION_HTTP_TIMEOUT_SECONDS', 'number'],
    ['reflectionPromptTemplate', 'ORIZU_REFLECTION_PROMPT_TEMPLATE', 'string'],
    ['reflectionProviderSettings', 'ORIZU_REFLECTION_PROVIDER_SETTINGS', 'json'], ['objective', 'ORIZU_OBJECTIVE', 'string'],
    ['seed', 'ORIZU_SEED', 'number'], ['disableEvaluationCache', 'ORIZU_DISABLE_EVALUATION_CACHE', 'boolean'],
    ['allowDegenerateSeed', 'ORIZU_ALLOW_DEGENERATE_SEED', 'boolean'],
    ['autoPromote', 'ORIZU_AUTO_PROMOTE', 'boolean'],
    ['skipPerfectParentReflection', 'ORIZU_SKIP_PERFECT_PARENT_REFLECTION', 'boolean'],
  ]
  for (const [field, name, kind] of fields) {
    if (env[name] === undefined) continue
    optional[field] = kind === 'number' ? parseHostedGepaNumericValue(field, env[name]!)
      : kind === 'json' ? JSON.parse(env[name]!) : kind === 'boolean' ? env[name] === '1' : env[name]
  }
  const launchIntentId = explicitLaunchIntent || randomUUID()
  const body = {
    hosted: true, launchIntentId, optimizerVersionId: env.ORIZU_OPTIMIZER_VERSION_ID,
    promptVersionIds: env.ORIZU_PROMPT_VERSION_ID ? [env.ORIZU_PROMPT_VERSION_ID] : [],
    ...(env.ORIZU_INSTRUCTION_SET_NAME ? { instructionSetName: env.ORIZU_INSTRUCTION_SET_NAME,
      modelConfigIdentity: env.ORIZU_MODEL_CONFIG_IDENTITY, componentSelector: env.ORIZU_COMPONENT_SELECTOR } : {}),
    runnerVersionId: env.ORIZU_RUNNER_VERSION_ID,
    scorers: [{ scorerVersionId: env.ORIZU_SCORER_VERSION_ID,
      scorerRunnerVersionId: env.ORIZU_SCORER_RUNNER_VERSION_ID, role: 'selection', scorerConfig: {} }],
    datasetVersionId: env.ORIZU_DATASET_VERSION_ID, splitSetId: env.ORIZU_SPLIT_SET_ID,
    trainSplitName: env.ORIZU_TRAIN_SPLIT ?? 'train', validationSplitName: env.ORIZU_VALIDATION_SPLIT ?? 'validation',
    engine: 'official', scorerInputContract: env.ORIZU_SCORER_INPUT_CONTRACT ?? 'gepa',
    scorerCandidateField: env.ORIZU_SCORER_CANDIDATE_FIELD ?? null, budget: env.ORIZU_BUDGET ?? 'auto', ...optional,
    ...(optional.autoPromote === true ? { promotionLabel: null } : {}),
  }
  const response = await authedFetch(`/api/cli/optimization-runs?project=${encodeURIComponent(options.project)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const data = await parseJsonResponse<Record<string, unknown>>(response, 'Hosted optimization launch')
  if (!response.ok) {
    if (options.json) { options.printJson(data); process.exitCode = 1; return }
    throw new Error(JSON.stringify(data))
  }
  if (options.json) { options.printJson(data); return }
  options.printLine('Queued hosted optimization.')
  options.printLine(`Launch intent: ${launchIntentId}`)
  options.printLine(String(data.monitorUrl))
}
