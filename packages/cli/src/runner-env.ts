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

const CREDENTIAL_ENV_NAME = /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i

export function runnerForwardedSecretValues(
  environment: NodeJS.ProcessEnv = process.env
): string[] {
  const values: string[] = []
  for (const key of RUNNER_ENV_ALLOWLIST) {
    if (!CREDENTIAL_ENV_NAME.test(key)) continue
    const value = environment[key]
    if (value !== undefined && value.length >= 8) values.push(value)
  }
  return values
}
