import { findProvider } from './provider-registry.js'
import { providerLookupFor } from './provider-lookup.js'
import { CREDENTIAL_ENV_PATTERN, PROVIDER_FIELD_PATTERNS, RESERVED_CREDENTIAL_ENVS } from './provider-refusals.js'
import type { CustomerProviderRow, ProviderLookup } from './provider-lookup.js'

/** Env var naming every secret-bearing environment variable injected into a hosted run. */
export const INJECTED_ENV_VARS_ENV = 'ORIZU_INJECTED_ENV_VARS'
export const PROVIDER_REGISTRY_EXTRA_ENV = 'ORIZU_PROVIDER_REGISTRY_EXTRA'
export const HOSTED_PROVIDER_FAILURE = {
  credentialMissing: 'hosted_optimization_provider_credential_missing',
  selectionMismatch: 'hosted_optimization_selection_mismatch',
}

function invalidRegistry(): never {
  throw new Error(`${PROVIDER_REGISTRY_EXTRA_ENV} is invalid`)
}

/** Untrusted env text is never included in a refusal. Packaged entries win collisions. */
export function deliveredProviderLookup(text: string | undefined): ProviderLookup {
  if (text === undefined) return providerLookupFor([])
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return invalidRegistry() }
  if (!Array.isArray(raw)) return invalidRegistry()
  const rows: CustomerProviderRow[] = []
  const ids = new Set<string>(), envs = new Set<string>()
  for (const row of raw) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return invalidRegistry()
    const { id, protocol, baseUrl, credentialEnv, authHeader, authValuePrefix } = row
    if (typeof id !== 'string' || !PROVIDER_FIELD_PATTERNS.id.test(id) || ids.has(id)
      || !['openai-chat', 'openai-responses', 'anthropic-messages'].includes(protocol)
      || typeof baseUrl !== 'string' || typeof credentialEnv !== 'string'
      || !CREDENTIAL_ENV_PATTERN.test(credentialEnv)
      || typeof authHeader !== 'string' || !PROVIDER_FIELD_PATTERNS.auth_header.test(authHeader)
      || typeof authValuePrefix !== 'string' || /[\r\n\p{Cc}]/u.test(authValuePrefix)) return invalidRegistry()
    try {
      const url = new URL(baseUrl)
      const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
      if (url.username || url.password || url.search || url.hash || !url.hostname
        || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) return invalidRegistry()
    } catch { return invalidRegistry() }
    ids.add(id)
    if (findProvider(id)) continue
    if (envs.has(credentialEnv) || credentialEnv.startsWith('ORIZU_')
      || RESERVED_CREDENTIAL_ENVS.has(credentialEnv)) return invalidRegistry()
    envs.add(credentialEnv)
    // Explicit protocol narrowing keeps this decoder type-safe without assertions.
    if (protocol !== 'openai-chat' && protocol !== 'openai-responses' && protocol !== 'anthropic-messages') return invalidRegistry()
    rows.push({ id, protocol, baseUrl, credentialEnv, authHeader, authValuePrefix })
  }
  return providerLookupFor(rows)
}

/** Select metadata explicitly: callers may hold secret-bearing resolved entries. */
export function hostedProviderEnvironment(
  entries: readonly CustomerProviderRow[], existingNames = ''
): Record<string, string> {
  // Validate before any supplied name can become a boot-environment property.
  deliveredProviderLookup(JSON.stringify(entries.map(({ id, protocol, baseUrl, credentialEnv, authHeader, authValuePrefix }) =>
    ({ id, protocol, baseUrl, credentialEnv, authHeader, authValuePrefix }))))
  const environment: Record<string, string> = {}
  const names = new Set(existingNames.split(',').map(name => name.trim()).filter(Boolean))
  const extra: CustomerProviderRow[] = []
  for (const entry of entries) {
    const { id, protocol, baseUrl, credentialEnv, authHeader, authValuePrefix } = entry
    environment[credentialEnv] = `ORIZU DUMMY NOT A CREDENTIAL:${id}:${credentialEnv}`
    names.add(credentialEnv)
    if (!findProvider(id)) extra.push({ id, protocol, baseUrl, credentialEnv, authHeader, authValuePrefix })
  }
  if (extra.length) environment[PROVIDER_REGISTRY_EXTRA_ENV] = JSON.stringify(extra)
  if (names.size) environment[INJECTED_ENV_VARS_ENV] = [...names].join(',')
  return environment
}
