import { findProvider } from './provider-registry.js'
import type { WireProtocol } from './provider-registry.js'

/** Secret-bearing control-plane data. Never persist, log or send to sandbox env. */
export interface ResolvedHostedProviderCredential {
  readonly id: string
  readonly protocol: WireProtocol
  readonly baseUrl: string
  readonly host: string
  readonly credentialEnv: string
  readonly authHeader: string
  readonly authValuePrefix: string
  readonly secret: string
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Decode either Vault RPC rows (built-ins omit metadata) or complete wire rows.
 * Failure is atomic: malformed stored custody must never activate fallback. */
export function decodeHostedProviderCredentials(value: unknown): ResolvedHostedProviderCredential[] | null {
  if (!Array.isArray(value)) return null
  const entries: ResolvedHostedProviderCredential[] = []
  const ids = new Set<string>()
  for (const row of value) {
    if (!record(row) || typeof row.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(row.id) || ids.has(row.id) ||
        typeof row.secret !== 'string' || !row.secret.trim() || /\s|\p{Cc}/u.test(row.secret)) return null
    const metadata = findProvider(row.id) ?? row
    const { protocol, baseUrl, credentialEnv, authHeader, authValuePrefix } = metadata
    if ((protocol !== 'anthropic-messages' && protocol !== 'openai-responses' && protocol !== 'openai-chat') ||
        typeof baseUrl !== 'string' || typeof credentialEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(credentialEnv) ||
        typeof authHeader !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(authHeader) ||
        typeof authValuePrefix !== 'string' || /[\r\n\p{Cc}]/u.test(authValuePrefix)) return null
    let host: string
    try { host = new URL(baseUrl).hostname } catch { return null }
    if (!host || (row.host !== undefined && row.host !== host)) return null
    ids.add(row.id)
    entries.push({ id: row.id, protocol, baseUrl, host, credentialEnv, authHeader, authValuePrefix, secret: row.secret })
  }
  return entries
}
