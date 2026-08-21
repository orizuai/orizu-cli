import { existsSync, readFileSync } from 'fs'

export type GepaEngine = 'official' | 'legacy'

export interface GepaEngineDispatch {
  engine: GepaEngine
  args: string[]
  environment: NodeJS.ProcessEnv
  module: string
}

interface EnvironmentOption {
  flag: string
  environment: string
  readFile?: boolean
  json?: boolean
  allowEmpty?: boolean
}

const VALUE_OPTIONS: EnvironmentOption[] = [
  { flag: '--optimizer-version-id', environment: 'ORIZU_OPTIMIZER_VERSION_ID' },
  { flag: '--candidate-version-id', environment: 'ORIZU_PROMPT_VERSION_ID' },
  { flag: '--runner-version-id', environment: 'ORIZU_RUNNER_VERSION_ID' },
  { flag: '--candidate-runner-dir', environment: 'ORIZU_CANDIDATE_RUNNER_DIR' },
  { flag: '--scorer-version-id', environment: 'ORIZU_SCORER_VERSION_ID' },
  { flag: '--scorer-runner-version-id', environment: 'ORIZU_SCORER_RUNNER_VERSION_ID' },
  { flag: '--scorer-runner-dir', environment: 'ORIZU_SCORER_RUNNER_DIR' },
  { flag: '--scorer-input-contract', environment: 'ORIZU_SCORER_INPUT_CONTRACT' },
  { flag: '--scorer-candidate-field', environment: 'ORIZU_SCORER_CANDIDATE_FIELD' },
  { flag: '--dataset-version-id', environment: 'ORIZU_DATASET_VERSION_ID' },
  { flag: '--split-set-id', environment: 'ORIZU_SPLIT_SET_ID' },
  { flag: '--train-split', environment: 'ORIZU_TRAIN_SPLIT', allowEmpty: true },
  { flag: '--val-split', environment: 'ORIZU_VALIDATION_SPLIT', allowEmpty: true },
  { flag: '--budget', environment: 'ORIZU_BUDGET' },
  { flag: '--max-iterations', environment: 'ORIZU_MAX_ITERATIONS' },
  { flag: '--max-candidate-proposals', environment: 'ORIZU_MAX_CANDIDATE_PROPOSALS' },
  { flag: '--proposal-max-calls', environment: 'ORIZU_PROPOSAL_MAX_CALLS' },
  { flag: '--proposal-max-tokens', environment: 'ORIZU_PROPOSAL_MAX_TOKENS' },
  { flag: '--max-full-evals', environment: 'ORIZU_MAX_FULL_EVALS' },
  { flag: '--max-metric-calls', environment: 'ORIZU_MAX_METRIC_CALLS' },
  { flag: '--minibatch-size', environment: 'ORIZU_MINIBATCH_SIZE' },
  { flag: '--num-threads', environment: 'ORIZU_NUM_THREADS' },
  { flag: '--candidate-selection-strategy', environment: 'ORIZU_CANDIDATE_SELECTION_STRATEGY' },
  { flag: '--epsilon', environment: 'ORIZU_EPSILON' },
  { flag: '--reflection-model', environment: 'ORIZU_REFLECTION_MODEL' },
  { flag: '--reflection-temperature', environment: 'ORIZU_REFLECTION_TEMPERATURE' },
  { flag: '--reflection-max-tokens', environment: 'ORIZU_REFLECTION_MAX_TOKENS' },
  { flag: '--reflection-retry-attempts', environment: 'ORIZU_REFLECTION_RETRY_ATTEMPTS' },
  { flag: '--reflection-http-timeout-seconds', environment: 'ORIZU_REFLECTION_HTTP_TIMEOUT_SECONDS' },
  { flag: '--reflection-prompt-template', environment: 'ORIZU_REFLECTION_PROMPT_TEMPLATE', readFile: true },
  { flag: '--reflection-provider-settings', environment: 'ORIZU_REFLECTION_PROVIDER_SETTINGS', readFile: true, json: true },
  { flag: '--objective', environment: 'ORIZU_OBJECTIVE', allowEmpty: true },
  { flag: '--seed', environment: 'ORIZU_SEED' },
  { flag: '--promotion-label', environment: 'ORIZU_PROMOTION_LABEL', allowEmpty: true },
  { flag: '--log-dir', environment: 'ORIZU_LOCAL_LOG_DIR' },
]

const BOOLEAN_OPTIONS = [
  ['--allow-degenerate-seed', 'ORIZU_ALLOW_DEGENERATE_SEED', '1'],
  ['--disable-evaluation-cache', 'ORIZU_DISABLE_EVALUATION_CACHE', '1'],
  ['--auto-promote', 'ORIZU_AUTO_PROMOTE', '1'],
  ['--log-row-snapshots', 'ORIZU_LOG_ROW_SNAPSHOTS', '1'],
  ['--no-local-log', 'ORIZU_NO_LOCAL_LOG', '1'],
  ['--skip-perfect-parent-reflection', 'ORIZU_SKIP_PERFECT_PARENT_REFLECTION', '1'],
  ['--no-skip-perfect-parent-reflection', 'ORIZU_SKIP_PERFECT_PARENT_REFLECTION', '0'],
] as const

function textValue(value: string): string {
  if (value.startsWith('@')) return readFileSync(value.slice(1), 'utf8')
  const path = value
  return existsSync(path) ? readFileSync(path, 'utf8') : value
}

function jsonObjectValue(value: string, flag: string): string {
  const raw = textValue(value)
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${flag} must be a JSON object`)
  }
  // Validate in JavaScript, but preserve the raw spelling for Python's JSON
  // parser so large numbers and exponent forms do not lose precision here.
  return raw
}

function removeEngine(args: string[]): { engine: GepaEngine; args: string[] } {
  let engine: string | undefined
  const forwarded: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--engine') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error('--engine must be one of official, legacy')
      }
      if (engine !== undefined && engine !== value) {
        throw new Error('--engine must select exactly one of official, legacy')
      }
      engine = value
      index += 1
      continue
    }
    if (argument.startsWith('--engine=')) {
      const value = argument.slice('--engine='.length)
      if (engine !== undefined && engine !== value) {
        throw new Error('--engine must select exactly one of official, legacy')
      }
      engine = value
      continue
    }
    forwarded.push(argument)
  }
  if (engine !== undefined && engine !== 'official' && engine !== 'legacy') {
    throw new Error(`--engine must be one of official, legacy; received ${engine}`)
  }
  return { engine: engine ?? 'official', args: forwarded }
}

function validateLegacyMetadata(args: string[]): void {
  let raw: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--metadata') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error('--metadata must be a JSON object')
      }
      raw = value
      index += 1
      continue
    }
    if (args[index].startsWith('--metadata=')) {
      raw = args[index].slice('--metadata='.length)
    }
  }
  let metadata: unknown = {}
  if (raw !== undefined) {
    try {
      // The frozen legacy CLI hands this value directly to json.loads. Do not
      // add @file/path expansion here: only reflection inputs support it.
      metadata = JSON.parse(raw)
    } catch {
      throw new Error('--metadata must be a JSON object containing valid JSON')
    }
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new Error('--metadata must be a JSON object')
  }
  // The frozen CLI consumes the original argv with json.loads. Keep the raw
  // spelling so Python, not JavaScript, owns JSON number precision and adds
  // the selected legacy-engine tag to the run metadata.
}

interface BooleanEnvironmentOption {
  environment: string
  value: string
}

// Parsing starts from an arbitrary command-line string. Keep the literal
// tuples above checked, then widen only the map boundary used for lookup.
const VALUE_OPTIONS_BY_FLAG: ReadonlyMap<string, EnvironmentOption> = new Map(
  VALUE_OPTIONS.map(option => [option.flag, option])
)
const BOOLEAN_OPTIONS_BY_FLAG: ReadonlyMap<string, BooleanEnvironmentOption> = new Map(
  BOOLEAN_OPTIONS.map(([flag, environment, value]) => [flag, { environment, value }])
)
const CONTROLLED_ENVIRONMENT_NAMES = new Set([
  'ORIZU_PROJECT',
  'ORIZU_METADATA',
  ...VALUE_OPTIONS.map(option => option.environment),
  ...BOOLEAN_OPTIONS.map(([, environment]) => environment),
  'ORIZU_USE_MERGE',
  'ORIZU_MAX_MERGE_INVOCATIONS',
  'ORIZU_SAMPLING_STRATEGY',
  'ORIZU_SELECTION_STRATEGY',
  'ORIZU_MAX_PAYLOAD_CHARS',
  // Candidate selection is an explicit opt-in.  Clearing it before option
  // translation prevents an inherited environment from selecting a proposer
  // on an otherwise byte-for-byte normal official-GEPA launch.
  'ORIZU_CANDIDATE_PROPOSER',
])

function optionValueOrThrow(args: string[], index: number, flag: string, allowEmpty = false): { value: string; nextIndex: number } {
  const argument = args[index]
  const equalsPrefix = `${flag}=`
  if (argument.startsWith(equalsPrefix)) {
    const value = argument.slice(equalsPrefix.length)
    if ((!allowEmpty && value === '') || value.startsWith('--')) {
      throw new Error(`${flag} requires a value that does not start with --`)
    }
    return { value, nextIndex: index }
  }

  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value that does not start with --`)
  }
  return { value, nextIndex: index + 1 }
}

function translateOfficialOptions(args: string[], project: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const connectorEnvironment: NodeJS.ProcessEnv = { ...environment }
  for (const name of CONTROLLED_ENVIRONMENT_NAMES) {
    delete connectorEnvironment[name]
  }
  connectorEnvironment.ORIZU_PROJECT = project

  let metadata: string | undefined
  const budgetFlags: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected run-gepa argument ${argument}`)
    }

    const flag = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument
    if (flag === '--project') {
      const parsed = optionValueOrThrow(args, index, flag)
      connectorEnvironment.ORIZU_PROJECT = parsed.value
      index = parsed.nextIndex
      continue
    }
    if (flag === '--metadata') {
      const parsed = optionValueOrThrow(args, index, flag)
      metadata = parsed.value
      index = parsed.nextIndex
      continue
    }
    if (flag === '--candidate-proposer') {
      const parsed = optionValueOrThrow(args, index, flag)
      if (parsed.value !== 'skilled-proposer') {
        throw new Error('--candidate-proposer must be skilled-proposer')
      }
      connectorEnvironment.ORIZU_CANDIDATE_PROPOSER = parsed.value
      index = parsed.nextIndex
      continue
    }
    const option = VALUE_OPTIONS_BY_FLAG.get(flag)
    if (option) {
      const parsed = optionValueOrThrow(args, index, flag, option.allowEmpty)
      if (flag === '--budget') {
        if (!['auto', 'light', 'medium', 'heavy'].includes(parsed.value)) {
          throw new Error('--budget must be one of auto, light, medium, heavy')
        }
        budgetFlags.push(flag)
      }
      if (['--max-metric-calls', '--max-full-evals', '--max-iterations', '--max-candidate-proposals'].includes(flag)) {
        budgetFlags.push(flag)
      }
      if (flag === '--candidate-selection-strategy' && !['pareto', 'current_best', 'epsilon_greedy'].includes(parsed.value)) {
        throw new Error('--candidate-selection-strategy must be one of pareto, current_best, epsilon_greedy')
      }
      if (flag === '--scorer-input-contract' && !['gepa', 'flat_row'].includes(parsed.value)) {
        throw new Error('--scorer-input-contract must be one of gepa, flat_row')
      }
      connectorEnvironment[option.environment] = option.json
        ? jsonObjectValue(parsed.value, option.flag)
        : option.readFile ? textValue(parsed.value) : parsed.value
      index = parsed.nextIndex
      continue
    }
    const boolean = BOOLEAN_OPTIONS_BY_FLAG.get(flag)
    if (boolean) {
      if (argument.includes('=')) {
        throw new Error(`${flag} does not accept a value`)
      }
      if (args[index + 1] !== undefined && !args[index + 1].startsWith('--')) {
        throw new Error(`${flag} does not accept a value`)
      }
      connectorEnvironment[boolean.environment] = boolean.value
      continue
    }
    throw new Error(`Unknown run-gepa option ${flag}`)
  }

  if (budgetFlags.length > 1) {
    throw new Error('Budget options are mutually exclusive; choose at most one of --budget, --max-metric-calls, --max-full-evals, --max-iterations, --max-candidate-proposals')
  }
  if ((connectorEnvironment.ORIZU_PROPOSAL_MAX_CALLS !== undefined
       || connectorEnvironment.ORIZU_PROPOSAL_MAX_TOKENS !== undefined)
      && connectorEnvironment.ORIZU_CANDIDATE_PROPOSER !== 'skilled-proposer') {
    throw new Error('--proposal-max-calls and --proposal-max-tokens require --candidate-proposer skilled-proposer')
  }

  const reflectionModel = connectorEnvironment.ORIZU_REFLECTION_MODEL ?? 'anthropic/claude-opus-4-7'
  if (!reflectionModel.startsWith('openai/') && connectorEnvironment.ORIZU_REFLECTION_MAX_TOKENS === undefined) {
    throw new Error('--reflection-max-tokens is required for Anthropic reflection models')
  }

  connectorEnvironment.ORIZU_METADATA = validatedMetadata(metadata)
  return connectorEnvironment
}

function validatedMetadata(raw: string | undefined): string {
  if (raw === undefined) return '{}'
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error()
  } catch {
    throw new Error('--metadata must be a JSON object containing valid JSON')
  }
  return raw
}

export function dispatchGepaEngine(args: string[], project: string, environment: NodeJS.ProcessEnv): GepaEngineDispatch {
  const selected = removeEngine(args)
  if (selected.engine === 'legacy') {
    for (const flag of ['--max-candidate-proposals', '--candidate-proposer', '--proposal-max-calls', '--proposal-max-tokens']) {
      if (selected.args.some(argument => argument === flag || argument.startsWith(`${flag}=`))) {
        throw new Error(`${flag} is supported by the official GEPA engine only`)
      }
    }
    validateLegacyMetadata(selected.args)
    return {
      engine: 'legacy',
      args: selected.args,
      environment,
      module: 'orizu_gepa.cli',
    }
  }

  const connectorEnvironment = translateOfficialOptions(selected.args, project, environment)
  return { engine: 'official', args: [], environment: connectorEnvironment, module: 'orizu_gepa_connector' }
}
