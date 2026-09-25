import { deliveredProviderLookup, PROVIDER_REGISTRY_EXTRA_ENV } from './hosted-environment.js'
import { CREDENTIAL_ENV_PATTERN, RESERVED_CREDENTIAL_ENVS } from './provider-refusals.js'
import { RUNNER_ENV_ALLOWLIST, runnerEnvAllowlist } from './runner-env-allowlist.js'

export { RUNNER_ENV_ALLOWLIST } from './runner-env-allowlist.js'

const CREDENTIAL_ENV_NAME = /(?:^|_)(?:API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD)(?:_|$)/i

export function isCredentialEnvName(name: string): boolean {
  return CREDENTIAL_ENV_NAME.test(name)
}

/** EXTRA is delivered by hosted bootstrap; local runs have only built-ins (ORI-2101). */
export function effectiveRunnerEnvAllowlist(environment: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return runnerEnvAllowlist(deliveredProviderLookup(environment[PROVIDER_REGISTRY_EXTRA_ENV]))
}

let hasReportedStrippedCredentials = false

export function reportStrippedRunnerCredentials(allowlist: ReadonlySet<string>): void {
  if (hasReportedStrippedCredentials) return
  const names = Object.keys(process.env)
    .filter(name => CREDENTIAL_ENV_PATTERN.test(name) && !name.startsWith('ORIZU_')
      && !RESERVED_CREDENTIAL_ENVS.has(name) && !allowlist.has(name))
    .sort()
  if (!names.length) return
  hasReportedStrippedCredentials = true
  process.stderr.write(`Stripped runner credentials: ${names.join(', ')}\n`)
}

// Historical redaction targets, not permission to forward credentials to runners.
const LEGACY_REDACTION_ONLY_ENV_NAMES = ['GEMINI_API_KEY', 'GOOGLE_API_KEY']

function runnerRedactionEnvNames(environment: NodeJS.ProcessEnv): ReadonlySet<string> {
  let forwardedNames: ReadonlySet<string>
  try {
    forwardedNames = effectiveRunnerEnvAllowlist(environment)
  } catch (error) {
    if (!(error instanceof Error) || error.message !== `${PROVIDER_REGISTRY_EXTRA_ENV} is invalid`) throw error
    // Invalid delivery must not suppress the best-effort last-error record.
    // Forwarding still calls effectiveRunnerEnvAllowlist directly and refuses.
    forwardedNames = RUNNER_ENV_ALLOWLIST
  }
  return new Set([...forwardedNames, ...LEGACY_REDACTION_ONLY_ENV_NAMES])
}

export function runnerForwardedSecretValues(
  environment: NodeJS.ProcessEnv = process.env,
  allowlist: ReadonlySet<string> = runnerRedactionEnvNames(environment)
): string[] {
  const values: string[] = []
  for (const key of allowlist) {
    if (!isCredentialEnvName(key)) continue
    const value = environment[key]
    if (value !== undefined && value.length >= 8) values.push(value)
  }
  return values
}
