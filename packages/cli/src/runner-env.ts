export const RUNNER_ENV_ALLOWLIST = new Set([
  'PATH',
  'SystemRoot',
  'WINDIR',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'PYTHONPATH',
  'NODE_PATH',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
])

const CREDENTIAL_ENV_NAME = /(?:^|_)(?:API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD)(?:_|$)/i

export function isCredentialEnvName(name: string): boolean {
  return CREDENTIAL_ENV_NAME.test(name)
}

export function runnerForwardedSecretValues(
  environment: NodeJS.ProcessEnv = process.env,
  allowlist: ReadonlySet<string> = RUNNER_ENV_ALLOWLIST
): string[] {
  const values: string[] = []
  for (const key of allowlist) {
    if (!isCredentialEnvName(key)) continue
    const value = environment[key]
    if (value !== undefined && value.length >= 8) values.push(value)
  }
  return values
}
