interface NumericRule {
  field: string
  flag: string
  grammar: string
  accepts: (value: unknown) => boolean
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const isInteger = (value: unknown): value is number =>
  isFiniteNumber(value) && Number.isInteger(value)
const isPositiveInteger = (value: unknown): value is number =>
  isInteger(value) && value > 0

const rules: NumericRule[] = [
  ...[
    ['proposalMaxCalls', '--proposal-max-calls'],
    ['proposalMaxTokens', '--proposal-max-tokens'],
    ['maxIterations', '--max-iterations'],
    ['maxCandidateProposals', '--max-candidate-proposals'],
    ['maxFullEvals', '--max-full-evals'],
    ['maxMetricCalls', '--max-metric-calls'],
    ['minibatchSize', '--minibatch-size'],
    ['reflectionMaxTokens', '--reflection-max-tokens'],
    ['reflectionRetryAttempts', '--reflection-retry-attempts'],
    ['reflectionHttpTimeoutSeconds', '--reflection-http-timeout-seconds'],
  ].map(([field, flag]) => ({ field, flag, grammar: 'positive integer', accepts: isPositiveInteger })),
  {
    field: 'numThreads', flag: '--num-threads', grammar: 'auto or positive integer',
    accepts: value => value === 'auto' || isPositiveInteger(value),
  },
  ...[
    ['epsilon', '--epsilon'],
    ['reflectionTemperature', '--reflection-temperature'],
  ].map(([field, flag]) => ({ field, flag, grammar: 'finite number', accepts: isFiniteNumber })),
  { field: 'seed', flag: '--seed', grammar: 'integer', accepts: isInteger },
]

const integerPattern = /^[+-]?\d+$/
const floatPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

export function parseHostedGepaNumericValue(field: string, rawValue: string): number | 'auto' {
  const rule = rules.find(candidate => candidate.field === field)
  if (!rule) throw new Error(`Unknown hosted numeric field ${field}`)
  const trimmed = rawValue.trim()
  if (field === 'numThreads' && trimmed.toLowerCase() === 'auto') return 'auto'
  const lexicalPattern = rule.grammar === 'finite number' ? floatPattern : integerPattern
  const parsed = lexicalPattern.test(trimmed) ? Number(trimmed) : Number.NaN
  if (!rule.accepts(parsed)) throw new Error(`${rule.flag} must be ${rule.grammar}`)
  return parsed
}

export function hostedGepaNumericError(values: Record<string, unknown>): string | null {
  for (const rule of rules) {
    if (values[rule.field] !== undefined && !rule.accepts(values[rule.field])) {
      return `${rule.field} must be ${rule.grammar}`
    }
  }
  return null
}
