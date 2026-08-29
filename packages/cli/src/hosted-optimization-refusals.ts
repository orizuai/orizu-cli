export const HOSTED_OPTIMIZATION_REFUSAL_CONTRACTS = {
  hosted_optimization_candidate_runner_not_registered: {
    status: 400,
    remediation: 'Register the candidate runner with `orizu runners push` and use the returned runner version ID.',
  },
  hosted_optimization_scorer_runner_not_registered: {
    status: 400,
    remediation: 'Register the scorer runner with `orizu runners push` and use the returned runner version ID.',
  },
  hosted_optimization_runner_dir_mismatch: {
    status: 400,
    remediation: 'Remove the runner directory flag to use registered bytes, or push those local bytes and use the returned version ID.',
  },
  hosted_optimization_runner_verification_auth_failed: {
    status: 401,
    remediation: 'Run `orizu login`, confirm `orizu whoami`, and retry the hosted launch.',
  },
  hosted_optimization_runner_verification_forbidden: {
    status: 403,
    remediation: 'Use credentials permitted to read the registered runner version; retrying unchanged credentials will not help.',
  },
  hosted_optimization_runner_manifest_invalid: {
    status: 400,
    remediation: 'Fix manifest.json confinement violations, push the corrected runner bytes, and use the new runner version ID.',
  },
  hosted_optimization_runner_flags_ambiguous: {
    status: 400,
    remediation: 'Pass each runner directory and runner version flag exactly once.',
  },
  hosted_optimization_runner_verification_unavailable: {
    status: 503,
    remediation: 'Retry after runner verification is available; do not re-register unchanged runner bytes.',
  },
  hosted_optimization_runner_verification_cleanup_failed: {
    status: 500,
    remediation: 'Remove the reported temporary verification directory if it remains, then retry.',
  },
  hosted_optimization_optimizer_version_not_found: {
    status: 400,
    remediation: 'Push the optimizer with `orizu optimizers push` and use the returned optimizer version ID.',
  },
  hosted_optimization_optimizer_family_missing: {
    status: 400,
    remediation: 'Re-push the optimizer with manifest.optimizer_family set to `gepa`.',
  },
  hosted_optimization_optimizer_family_unsupported: {
    status: 400,
    remediation: 'Use an optimizer version whose validated manifest.optimizer_family is `gepa`.',
  },
  hosted_optimization_unsupported_provider: {
    status: 400,
    remediation: 'Choose a supported reflection provider: anthropic or openai.',
  },
  hosted_optimization_team_not_enabled: {
    status: 403,
    remediation: 'Ask Orizu staff to enable hosted optimization for this team.',
  },
  hosted_optimization_concurrency_cap_reached: {
    status: 409,
    remediation: 'Wait for or cancel an active hosted optimization using the running-run URLs.',
  },
  hosted_optimization_budget_exceeds_ceiling: {
    status: 403,
    remediation: "Choose a named budget preset within your team's hosted optimization ceiling.",
  },
  hosted_optimization_unsupported_option: {
    status: 400,
    remediation: 'Use the official Orizu GEPA optimizer and remove options that are only supported for local optimization.',
  },
  hosted_optimization_job_spec_too_large: {
    status: 400,
    remediation: 'Shorten the objective or reflection prompt so the hosted job specification fits the control-plane limit.',
  },
} as const

export type HostedOptimizationRefusalCode = keyof typeof HOSTED_OPTIMIZATION_REFUSAL_CONTRACTS

export interface HostedOptimizationRefusalBody extends Record<string, unknown> {
  error: 'Hosted optimization launch refused.'
  code: HostedOptimizationRefusalCode
  remediation: string
  runningRunUrls?: string[]
  detail?: string
}

export function hostedOptimizationRefusalBody(
  code: HostedOptimizationRefusalCode,
  options: { runningRunUrls?: string[]; detail?: string } = {}
): HostedOptimizationRefusalBody {
  return {
    error: 'Hosted optimization launch refused.',
    code,
    remediation: HOSTED_OPTIMIZATION_REFUSAL_CONTRACTS[code].remediation,
    ...(options.runningRunUrls ? { runningRunUrls: options.runningRunUrls } : {}),
    ...(options.detail ? { detail: options.detail.slice(0, 300) } : {}),
  }
}

export function isHostedOptimizationRefusalCode(value: string): value is HostedOptimizationRefusalCode {
  return Object.hasOwn(HOSTED_OPTIMIZATION_REFUSAL_CONTRACTS, value)
}
