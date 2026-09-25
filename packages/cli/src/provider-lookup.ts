import {
  findProvider,
  parseModelIdentity,
  providerHosts,
  providerIds,
  type ProviderEntry,
  type WireProtocol,
} from './provider-registry.js'

export { credentialEnvFor, requireProvider } from './provider-registry.js'

export interface CustomerProviderRow {
  readonly id: string
  readonly protocol: WireProtocol
  readonly baseUrl: string
  readonly credentialEnv: string
  readonly authHeader: string
  readonly authValuePrefix: string
}

export interface ProviderLookup {
  find(id: string | null | undefined): ProviderEntry | null
  ids(): readonly string[]
  hosts(): readonly string[]
  fromIdentity(identity: string | null | undefined): ProviderEntry | null
  protocolFor(identity: string | null | undefined): WireProtocol | null
}

function providerHost(entry: ProviderEntry): string | null {
  try {
    return new URL(entry.baseUrl).hostname || null
  } catch {
    return null
  }
}

/** Compose the built-in registry with one project's customer provider rows. */
export function providerLookupFor(rows: readonly CustomerProviderRow[]): ProviderLookup {
  const customerProviders = new Map<string, ProviderEntry>()
  for (const row of rows) {
    if (findProvider(row.id) || customerProviders.has(row.id)) continue
    customerProviders.set(row.id, { ...row, builtIn: false })
  }

  const find = (id: string | null | undefined): ProviderEntry | null => {
    if (!id) return null
    return findProvider(id) ?? customerProviders.get(id) ?? null
  }

  const fromIdentity = (identity: string | null | undefined): ProviderEntry | null =>
    find(parseModelIdentity(identity).provider)

  return {
    find,
    ids: () => [...providerIds(), ...customerProviders.keys()],
    hosts: () => [
      ...providerHosts(),
      ...[...customerProviders.values()]
        .map(providerHost)
        .filter((host): host is string => host !== null),
    ],
    fromIdentity,
    protocolFor: identity => fromIdentity(identity)?.protocol ?? null,
  }
}

/** Static-only lookup used wherever no project rows have been loaded. */
export const STATIC_PROVIDER_LOOKUP = providerLookupFor([])

/** Egress hostnames for the built-ins followed by one project's providers. */
export function projectProviderHosts(rows: readonly CustomerProviderRow[]): readonly string[] {
  return providerLookupFor(rows).hosts()
}
