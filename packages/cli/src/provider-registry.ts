/**
 * THE provider registry (ORI-2031). One list of providers for the CLI, the
 * Next server, the session-coordinator Worker and — via the generated JSON
 * next to each Python package — the GEPA transport.
 *
 * HARD CONSTRAINTS (do not relax without re-running the §7 gates):
 *   * ZERO imports. Three tsconfigs type-check this file (CLI NodeNext, root
 *     bundler, Worker bundler + workers-types) and wrangler bundles it into
 *     workerd.
 *   * No `process`, Node or Worker API use. Pure data + pure functions only.
 *   * It physically lives in `packages/cli/src` because `packages/cli` builds
 *     with `tsc -p` under `rootDir: "src"` and publishes a standalone tarball
 *     that cannot reach a sibling directory. Servers import the
 *     `apps/web/lib/provider-registry.ts` facade; the Worker imports it relatively.
 *     See `apps/web/lib/hosted-runtime/README.md` §"Relocation mechanism".
 *
 * A provider is a named connection (one wire protocol, one base URL, one
 * credential), never a vendor: two providers may point at the same company and
 * a gateway is just a provider. See CONTEXT.md.
 */

/** The request/response format a provider speaks. A property of the provider,
 *  never of the model. */
export type WireProtocol = 'openai-responses' | 'openai-chat' | 'anthropic-messages'

export interface ProviderEntry {
  readonly id: string
  readonly protocol: WireProtocol
  /** Everything up to AND INCLUDING the provider's own version segment; the
   *  protocol's request path (`/v1/messages`, `/responses`,
   *  `/chat/completions`) is appended verbatim, which is why the join looks
   *  asymmetric between `api.anthropic.com` and `api.openai.com/v1`. The
   *  Python `provider_endpoint` docstring says the same (ORI-2032). */
  readonly baseUrl: string
  readonly credentialEnv: string
  readonly authHeader: string
  /** '' for `x-api-key`; 'Bearer ' for `Authorization`. Needed to reproduce
   *  today's header bytes exactly (the coordinator emits `Bearer ${key}` for
   *  OpenAI only). */
  readonly authValuePrefix: string
  readonly builtIn: boolean
}

/**
 * Authored ALPHABETICALLY: `providerIds()` order is customer-visible in the
 * hosted refusal strings, and 'anthropic, openai' must stay a byte-identical
 * prefix of the list.
 *
 * Base URLs and headers are anchored on measured facts, not documentation:
 * `api.anthropic.com/v1/messages` (with `x-api-key`) and
 * `api.openai.com/v1/responses` (with `Authorization: Bearer`) are what
 * `packages/orizu-gepa-python/src/orizu_gepa/reflection.py` already sends to,
 * and both hosts are pinned by the existing egress tests. `openrouter.ai/api/v1`
 * is OpenRouter's documented chat-completions base.
 */
export const PROVIDER_REGISTRY = {
  anthropic: { id: 'anthropic', protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', credentialEnv: 'ANTHROPIC_API_KEY', authHeader: 'x-api-key', authValuePrefix: '', builtIn: true },
  openai: { id: 'openai', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', credentialEnv: 'OPENAI_API_KEY', authHeader: 'Authorization', authValuePrefix: 'Bearer ', builtIn: true },
  openrouter: { id: 'openrouter', protocol: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1', credentialEnv: 'OPENROUTER_API_KEY', authHeader: 'Authorization', authValuePrefix: 'Bearer ', builtIn: true },
} as const satisfies Record<string, ProviderEntry>

/** Ids of every registered provider, in authored (alphabetical) order. */
export function providerIds(): readonly string[] {
  return Object.keys(PROVIDER_REGISTRY)
}

/** Exact id match. No case folding, no prefix matching, no inherited keys. */
export function findProvider(id: string | null | undefined): ProviderEntry | null {
  if (!id || !Object.hasOwn(PROVIDER_REGISTRY, id)) return null
  return (PROVIDER_REGISTRY as Record<string, ProviderEntry>)[id]
}

/**
 * Split a model config identity into its provider segment and the opaque model
 * id. Splits on the FIRST slash and keeps everything after it, so
 * `openrouter/anthropic/claude-x` keeps its vendor segment. No slash means no
 * provider segment. `'anthropic/'` yields an empty model id (several call sites
 * pass that literal as their default).
 */
export function parseModelIdentity(identity: string | null | undefined): {
  provider: string | null
  modelId: string
} {
  const value = identity ?? ''
  const slash = value.indexOf('/')
  if (slash === -1) return { provider: null, modelId: value }
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) }
}

/** A built-in provider that code requires to exist. Fails at module load with
 *  the missing id instead of letting a non-null assertion become undefined. */
export function requireProvider(id: string): ProviderEntry {
  const provider = findProvider(id)
  if (!provider) {
    throw new Error(`Provider registry is missing required provider "${id}"`)
  }
  return provider
}

/** The registered provider a model identity names, or null. */
export function providerFromIdentity(identity: string | null | undefined): ProviderEntry | null {
  return findProvider(parseModelIdentity(identity).provider)
}

/** The wire protocol a model identity's provider speaks, or null. */
export function protocolForIdentity(identity: string | null | undefined): WireProtocol | null {
  return providerFromIdentity(identity)?.protocol ?? null
}

/** The bare hostname of a provider's base URL — what an egress allowlist and a
 *  firewall rewrite rule are keyed by. */
export function providerHost(id: string | null | undefined): string | null {
  const entry = findProvider(id)
  if (!entry) return null
  try {
    return new URL(entry.baseUrl).hostname || null
  } catch {
    return null
  }
}

/** Hosts of every registered provider, in `providerIds()` order. */
export function providerHosts(): readonly string[] {
  return providerIds().map(id => providerHost(id)).filter((host): host is string => host !== null)
}

/** The credential env-var name convention customers are told to follow.
 *
 *  NOT INJECTIVE: every run of non-alphanumerics collapses to one `_`, so
 *  `my-proxy`, `my.proxy` and `my proxy` all map to `MY_PROXY_API_KEY`. Safe
 *  for the built-ins (three fixed, distinct ids), but customer-supplied ids
 *  (ORI-2033) must be validated to `^[a-z][a-z0-9-]{0,63}$` AND checked unique AFTER
 *  mapping before this helper is trusted with them — otherwise two providers
 *  silently share one credential env var, which is provider A reading
 *  provider B's key. */
export function defaultCredentialEnv(id: string): string {
  return `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/** The env var holding a provider's key: declared for a built-in, conventional
 *  for anything else. */
export function credentialEnvFor(id: string): string {
  return findProvider(id)?.credentialEnv ?? defaultCredentialEnv(id)
}

/** The exact auth header bytes a provider expects, or null when unregistered. */
export function providerAuthHeaders(id: string | null | undefined, key: string): Record<string, string> | null {
  const entry = findProvider(id)
  if (!entry) return null
  return { [entry.authHeader]: `${entry.authValuePrefix}${key}` }
}

/** Hosted reflection-setting keys each protocol accepts, beyond the shared
 *  `top_p`. `openai-chat` accepts `reasoning` like Responses does; the request
 *  field names it maps to are ORI-2032's problem, not admission's. */
export function providerSettingKeys(protocol: WireProtocol): readonly string[] {
  if (protocol === 'anthropic-messages') return ['thinking', 'output_config']
  return ['reasoning']
}

/**
 * Whether a wire protocol makes an output-token cap mandatory.
 *
 * Anthropic Messages requires `max_tokens`; both OpenAI protocols treat the
 * cap as optional. An UNRESOLVED protocol (`null`, an unregistered provider,
 * an unqualified identity) requires it, so a run Orizu cannot classify keeps
 * failing closed exactly as the `openai/` prefix rule did.
 *
 * A protocol fact, not a provider property, so it needs no registry field.
 * The Python copy is `protocol_requires_output_cap` in
 * `packages/orizu-gepa-python/src/orizu_gepa/reflection.py`; matching tests
 * pin both sides (ORI-2032 §10 ruling 3).
 */
export function protocolRequiresOutputCap(protocol: WireProtocol | null): boolean {
  return protocol !== 'openai-responses' && protocol !== 'openai-chat'
}

/** `['a','b']` → `'a or b'`; three or more take the Oxford comma. The
 *  two-element form must stay byte-identical to the string customers see
 *  today. */
export function formatProviderList(ids: readonly string[]): string {
  if (ids.length === 0) return ''
  if (ids.length === 1) return ids[0]
  if (ids.length === 2) return `${ids[0]} or ${ids[1]}`
  return `${ids.slice(0, -1).join(', ')}, or ${ids[ids.length - 1]}`
}
