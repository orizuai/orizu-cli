import { STATIC_PROVIDER_LOOKUP, type ProviderLookup } from './provider-lookup.js'

/** Process essentials are not provider data. Keep this module Node-free. */
const RUNNER_PROCESS_ENV_NAMES = [
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
  // Hosted-sandbox TLS interception and corporate TLS-inspecting proxies both
  // deliver trust through these vars; stripping them breaks hosted and enterprise-local runs.
  'AWS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'GRPC_DEFAULT_SSL_ROOTS_FILE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_SYSTEM_CA',
  'PIP_CERT',
  'REQUESTS_CA_BUNDLE',
  'SSL_CERT_FILE',
]

export function runnerEnvAllowlist(providers: ProviderLookup = STATIC_PROVIDER_LOOKUP): ReadonlySet<string> {
  const names = new Set(RUNNER_PROCESS_ENV_NAMES)
  for (const id of providers.ids()) {
    const provider = providers.find(id)
    if (provider) names.add(provider.credentialEnv)
  }
  return names
}

export const RUNNER_ENV_ALLOWLIST = runnerEnvAllowlist()
