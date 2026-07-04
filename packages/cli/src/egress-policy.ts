/**
 * G5 — sandbox egress policy builder (ALI-1006, per the hosted-agent threat
 * model T1). Owns the ALLOWLIST CONTENT the `SandboxProvider` seam plumbs to the
 * sandbox firewall at create (`packages/cli/src/vercel-sandbox-provider.ts` →
 * Vercel `networkPolicy`). The Vercel adapter is a pass-through; this file is
 * where "default-deny with a per-team allowlist (Orizu API, model providers, git
 * host); blocked attempts logged" is actually decided.
 *
 * The policy is DEFAULT-DENY: the record form `{ allow: { host: rules } }` denies
 * everything NOT explicitly listed, so the correctness invariant is simply that
 * we NEVER emit a `"*"` allow entry (which would re-open the sandbox). The
 * model-key credential broker (G3 / `buildModelKeyBrokerPolicy`) is COMPOSED onto
 * the model host's rule here so brokering + allowlisting are ONE coherent policy,
 * not two policies that could disagree.
 *
 * SNI matching (verified against @vercel/sandbox@1.10.2 `NetworkPolicy`): an
 * allow entry matches the exact SNI host; a LEADING-wildcard entry (`*.orizu.ai`)
 * matches any single-or-multi-label subdomain but NOT the apex — so a host that
 * must serve BOTH apex and subdomains is listed twice (`orizu.ai` +
 * `*.orizu.ai`). Domains are hostnames only — never a protocol, path, or port.
 *
 * The BASE allowlist (Orizu API + model provider + git host) is CODE-OWNED and
 * non-negotiable: `buildEgressPolicy` always includes it and per-team config can
 * only ADD to it, never remove a base host. See
 * docs/requirements/hosted-customer-workbench/sandbox-egress-policy.md for the
 * rationale per host and the honest statement of what Vercel enforces (firewall,
 * SNI-level) vs. what we generate (blocked-attempt evidence via the canary).
 */

import type { SandboxEgressPolicy, SandboxEgressRule } from './sandbox-provider.js'

/** Default model-provider endpoint (Anthropic) the broker injects a key for. */
export const ANTHROPIC_API_HOST = 'api.anthropic.com'
/** Anthropic authenticates with `x-api-key` (not a Bearer Authorization). */
export const ANTHROPIC_API_KEY_HEADER = 'x-api-key'

/** GitHub git-over-HTTPS SNIs. `git clone`/`git push` over the smart HTTP
 *  protocol connect to `github.com`; `codeload.github.com` serves repository
 *  archive/tarball fetches (release assets, `pip`/`go` github-archive installs).
 *  Both are allowed so the agent's git work AND any archive fetch its workflow
 *  triggers succeed — everything else on github's infra stays denied. */
export const GIT_HOST_DOMAINS = ['github.com', 'codeload.github.com'] as const

/** Default host the startup canary probes to PROVE the policy is live (a known
 *  non-allowlisted host: reaching it means egress is NOT enforced). */
export const DEFAULT_EGRESS_CANARY_HOST = 'example.com'

/** Default Orizu control-plane base when none is configured. */
const DEFAULT_ORIZU_BASE_URL = 'https://orizu.ai'

/**
 * Resolve the Orizu control-plane host from a base URL and CONSERVATIVELY
 * wildcard its registrable base domain so the policy survives the API moving to
 * a subdomain (e.g. `api.orizu.ai`) without re-opening egress. Returns the apex
 * PLUS a leading-wildcard for its subdomains: `orizu.ai` + `*.orizu.ai`. A
 * loopback/localhost base (rehearsal) yields just the bare host (no wildcard —
 * there is nothing to broaden and the firewall does not enforce it anyway).
 */
export function orizuEgressDomains(baseUrl: string | undefined): string[] {
  const raw = (baseUrl ?? process.env.ORIZU_BASE_URL ?? DEFAULT_ORIZU_BASE_URL).trim()
  let host: string
  try {
    host = new URL(raw).hostname.toLowerCase()
  } catch {
    // Not a URL — treat the value as a bare host (strip any stray path/port).
    host = raw.replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0].toLowerCase()
  }
  if (!host) return [DEFAULT_ORIZU_BASE_URL.replace('https://', '')]
  // Loopback / single-label hosts: no base-domain to wildcard.
  if (host === 'localhost' || host === '127.0.0.1' || !host.includes('.')) {
    return [host]
  }
  const labels = host.split('.')
  // Registrable base = last two labels (orizu.ai from api.orizu.ai). Good enough
  // for our single first-party domain; a multi-part TLD would over-broaden, but
  // the base host is always our own domain so this is a controlled input.
  const baseDomain = labels.slice(-2).join('.')
  const domains = new Set<string>([baseDomain, `*.${baseDomain}`])
  // Also allow the exact configured host if it is a deeper subdomain than the
  // wildcard's single-level match would guarantee (belt-and-braces).
  domains.add(host)
  return [...domains]
}

/**
 * Normalize a per-team extra domain to a bare hostname (or leading-wildcard).
 * Strips protocol/path/port, lowercases, and validates the SNI shape. Returns
 * null for anything that is not a plausible hostname so a bad config entry is
 * dropped rather than silently widening the policy in an unexpected way.
 */
export function normalizeEgressDomain(input: string): string | null {
  let value = input.trim().toLowerCase()
  if (!value) return null
  value = value.replace(/^[a-z]+:\/\//i, '') // strip scheme
  value = value.split('/')[0] // strip path
  value = value.split(':')[0] // strip port
  if (!value) return null
  // A leading `*.` wildcard is allowed; validate the remainder as a hostname.
  const hostPart = value.startsWith('*.') ? value.slice(2) : value
  // Labels: alphanumeric + hyphen, dot-separated, at least one dot (reject bare
  // single labels and anything with illegal characters, spaces, or `*` mid-host).
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(hostPart)) {
    return null
  }
  return value
}

export interface EgressModelKeyBroker {
  /** The raw model API key. It lives ONLY in the policy the host sends to the
   *  firewall control plane; it never enters the sandbox env/disk/run events. */
  apiKey: string
  /** Domain to inject the key for (default api.anthropic.com). */
  host?: string
  /** Header the endpoint authenticates with (default x-api-key). */
  headerName?: string
}

export interface BuildEgressPolicyOptions {
  /** Orizu control-plane base URL (default env ORIZU_BASE_URL / orizu.ai). */
  orizuBaseUrl?: string
  /** Additional model-provider hosts to allow WITHOUT a key transform. The broker
   *  host (below) is added automatically; list only extra providers here. */
  modelHosts?: readonly string[]
  /** Compose the G3 model-key broker transform onto its host's allow rule, so
   *  brokering and the allowlist are one policy. */
  modelKeyBroker?: EgressModelKeyBroker
  /** Per-team ADDITIVE domains (a customer's own API a workflow needs). Base
   *  hosts can never be removed; these only widen. Invalid entries are dropped. */
  extraDomains?: readonly string[]
}

/**
 * Compute the ordered list of BASE (code-owned, non-removable) allow domains for
 * an Orizu base URL: the Orizu control-plane host(s), the model provider host,
 * and the git host(s). Exported so tests and the policy doc assert the exact set.
 */
export function baseEgressDomains(opts: { orizuBaseUrl?: string; modelHost?: string; modelHosts?: readonly string[] } = {}): string[] {
  const domains = new Set<string>()
  for (const d of orizuEgressDomains(opts.orizuBaseUrl)) domains.add(d)
  domains.add(opts.modelHost ?? ANTHROPIC_API_HOST)
  for (const d of opts.modelHosts ?? []) {
    const n = normalizeEgressDomain(d)
    if (n) domains.add(n)
  }
  for (const d of GIT_HOST_DOMAINS) domains.add(d)
  return [...domains]
}

/**
 * Build a DEFAULT-DENY Vercel network policy whose allowlist is exactly the base
 * hosts (Orizu API + model provider + git) plus any valid per-team extra domains,
 * with the model-key broker transform COMPOSED onto the model host's rule.
 *
 * Correctness invariants (unit-tested):
 *   - record form → default-deny (no `"*"` key is EVER emitted);
 *   - every base host is present;
 *   - the broker transform sits on the model host's rule (one coherent policy);
 *   - base hosts survive regardless of `extraDomains` (cannot be removed).
 */
export function buildEgressPolicy(opts: BuildEgressPolicyOptions = {}): SandboxEgressPolicy {
  const brokerHost = opts.modelKeyBroker?.host ?? ANTHROPIC_API_HOST
  const base = baseEgressDomains({
    orizuBaseUrl: opts.orizuBaseUrl,
    modelHost: brokerHost,
    modelHosts: opts.modelHosts,
  })

  const allow: Record<string, SandboxEgressRule[]> = {}
  for (const domain of base) allow[domain] = []

  // Additive per-team domains: normalized + de-duped; NEVER able to unset a base
  // host (base was inserted first; a repeat just re-sets the same empty rule).
  for (const raw of opts.extraDomains ?? []) {
    const domain = normalizeEgressDomain(raw)
    if (domain) allow[domain] = allow[domain] ?? []
  }

  // Compose the broker transform onto the model host's rule (G3 + G5 as one
  // policy). The raw key stays host-side in this object; it is never written into
  // the sandbox — OpenCode is given a non-secret dummy key and the proxy overrides
  // the real header on matching egress.
  if (opts.modelKeyBroker) {
    const headerName = opts.modelKeyBroker.headerName ?? ANTHROPIC_API_KEY_HEADER
    allow[brokerHost] = [{ transform: [{ headers: { [headerName]: opts.modelKeyBroker.apiKey } }] }]
  }

  return { allow }
}
