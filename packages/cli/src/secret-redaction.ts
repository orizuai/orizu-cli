/**
 * Secret redaction for hosted-sandbox bootstrap (G3 / ALI-1004).
 *
 * The bootstrap orchestrator records lifecycle events to the RunAPI and may
 * capture hook / install output. None of that may ever carry the Orizu bearer,
 * a minted repo token, or any token-shaped value. `redactSecrets` scrubs a
 * value two ways:
 *
 *   1. exact-match on caller-supplied secrets (the bearer, any token the
 *      orchestrator itself minted) — these are known verbatim, so replace them
 *      wherever they appear, even mid-string;
 *   2. shape-match on the well-known credential prefixes GitHub and Orizu emit
 *      (ghs_/ghp_/gho_/ghu_/ghr_/github_pat_ installation+PAT tokens, Orizu's own
 *      `orizu_pat_`/`orizu_agent_` tokens, and a generic `Bearer <blob>` header)
 *      — a defense-in-depth net for tokens the orchestrator never held a copy of
 *      (e.g. a token echoed by a customer setup hook).
 *
 * The function is pure and recursive over JSON-ish structures so an entire
 * event payload can be passed through before it is sent to the RunAPI.
 */

export const REDACTION_PLACEHOLDER = '[redacted]'

// Token SHAPES, not values. Ordered longest-prefix-first so `github_pat_` wins
// over a hypothetical shorter alias. Each matches the prefix plus its base62/_-
// body. `Bearer <token>` is caught separately so an Authorization header value
// is scrubbed even when the token body is short.
const TOKEN_SHAPE_PATTERNS: readonly RegExp[] = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[posur]_[A-Za-z0-9_]{20,}/g,
  // Orizu-issued credentials: `orizu_pat_` (personal access tokens, see
  // lib/personal-access-tokens.ts — prefix + base64url body) and the future
  // `orizu_agent_` session-token prefix. base64url alphabet is [A-Za-z0-9_-].
  /\borizu_(agent|pat)_[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Redact a scalar string: exact secrets first, then token shapes.
 */
function redactString(input: string, secrets: readonly string[]): string {
  let out = input
  for (const secret of secrets) {
    if (secret.length === 0) continue
    out = out.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTION_PLACEHOLDER)
  }
  for (const pattern of TOKEN_SHAPE_PATTERNS) {
    out = out.replace(pattern, match =>
      match.toLowerCase().startsWith('bearer') ? `Bearer ${REDACTION_PLACEHOLDER}` : REDACTION_PLACEHOLDER
    )
  }
  return out
}

export interface RedactOptions {
  /** Verbatim secret values to strip wherever they appear (bearer, tokens). */
  secrets?: readonly string[]
}

/**
 * Deep-redact a JSON-ish value. Strings are scrubbed; arrays/objects are walked;
 * everything else is returned as-is. Object KEYS are never treated as secrets
 * (a key literally named after a token is not the token), but their VALUES are.
 */
export function redactSecrets<T>(value: T, options: RedactOptions = {}): T {
  const secrets = (options.secrets ?? []).filter(s => typeof s === 'string' && s.length > 0)
  return redactValue(value, secrets) as T
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    return redactString(value, secrets)
  }
  if (Array.isArray(value)) {
    return value.map(item => redactValue(item, secrets))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(inner, secrets)
    }
    return out
  }
  return value
}

/**
 * True when a string still contains any of the supplied secrets or a
 * token-shaped substring — the assertion tests use it to prove an event payload
 * left the orchestrator clean.
 */
export function containsSecret(input: string, secrets: readonly string[]): boolean {
  for (const secret of secrets) {
    if (secret.length > 0 && input.includes(secret)) return true
  }
  return TOKEN_SHAPE_PATTERNS.some(pattern => {
    pattern.lastIndex = 0
    return pattern.test(input)
  })
}
