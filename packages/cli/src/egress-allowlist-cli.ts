/**
 * Per-team ADDITIVE egress allowlist CLI (ALI-1006 / G5):
 *   orizu team egress-allowlist <team>                 # show extra domains
 *   orizu team egress-allowlist <team> --add <domain>
 *   orizu team egress-allowlist <team> --remove <domain>
 *   orizu team egress-allowlist <team> --set a.com,b.com
 *   orizu team egress-allowlist <team> --clear
 *
 * The BASE allowlist (Orizu API + model provider + git host) is code-owned and
 * NOT shown/managed here — this surface only widens a team's egress with domains
 * a customer workflow needs. Human ADMIN only: the server rejects agent bearers
 * and non-admins (the definer RPC gates on is_team_admin). The arguments and
 * output live here; the requests run on Effect in egress-allowlist-workflow.ts
 * (ORI-2764), loaded only when this command runs.
 */

/** Mirrors MAX_TEAM_EGRESS_DOMAINS in the shared read-side validator
 *  (workers/session-coordinator/src/egress-domains.ts). The coordinator only
 *  applies the first this-many UNIQUE valid domains at policy compose; the
 *  CLI is a standalone package and cannot import the worker module, so the
 *  cap constant is duplicated here (kept in sync via that file's tests). */
const MAX_ADDITIVE_EGRESS_DOMAINS = 100

export type CliFetcher = (path: string, init?: RequestInit) => Promise<Response>

export interface EgressAllowlistCommandIo {
  json: boolean
  print: (line: string) => void
  printErr?: (line: string) => void
  /** Stands in for `authedFetch` in tests. */
  fetcher?: CliFetcher
}

function argValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag)
  if (index === -1 || index + 1 >= args.length || args[index + 1].startsWith('--')) {
    return null
  }
  return args[index + 1]
}

function firstPositional(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      if (argValue(args, arg) !== null) i += 1
      continue
    }
    return arg
  }
  return null
}

function printErr(io: EgressAllowlistCommandIo, message: string): void {
  ;(io.printErr ?? io.print)(message)
}

export function splitDomains(value: string): string[] {
  return value
    .split(',')
    .map(d => d.trim())
    .filter(d => d.length > 0)
}

export interface CurrentAllowlist {
  domains: string[]
  /** ALI-1174: legacy entries the server flags as failing the tightened
   *  validator — stored, shown by GET, but silently dropped by the
   *  coordinator at policy compose. Surfaced so "configured" never silently
   *  means "inert". */
  invalid: string[]
  /** Valid entries beyond the 100-domain cap — equally inert at compose. */
  capped: string[]
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((d): d is string => typeof d === 'string') : []
}

/**
 * Re-derive the "beyond the 100-domain cap" entries from a stored set the
 * SAME way the GET route does (positional over UNIQUE VALID domains): the
 * coordinator applies only the first MAX_ADDITIVE_EGRESS_DOMAINS valid
 * domains, so every valid entry past that index is configured-but-inert.
 * Stored entries are already canonical + deduped by the write RPC, and the
 * invalid (grandfathered) ones — flagged by the server — are not "valid"
 * and so never consume a cap slot. Used for the PUT response, where a
 * shrink-by-one on an oversized legacy row leaves the returned set still
 * over-cap and the server does not send cappedDomains back.
 */
export function deriveCapped(stored: readonly string[], invalid: readonly string[]): string[] {
  const invalidSet = new Set(invalid)
  const capped: string[] = []
  let validCount = 0
  for (const d of stored) {
    if (invalidSet.has(d)) continue
    validCount += 1
    if (validCount > MAX_ADDITIVE_EGRESS_DOMAINS) capped.push(d)
  }
  return capped
}

export function emit(io: EgressAllowlistCommandIo, teamSlug: string, current: CurrentAllowlist): void {
  if (io.json) {
    io.print(
      JSON.stringify({
        teamSlug,
        extraDomains: current.domains,
        invalidDomains: current.invalid,
        cappedDomains: current.capped,
      })
    )
    return
  }
  const invalid = new Set(current.invalid)
  const capped = new Set(current.capped)
  const lines = current.domains.map((d) => {
    // Round 4 (P3): re-adding a non-grandfathered invalid entry is
    // guaranteed to fail the write RPC's tightened validator (grandfathering
    // is retention-only — see set_team_egress_allowlist), so "remove and
    // re-add" was actively misleading. The only viable remediation is
    // removal.
    if (invalid.has(d)) return `${d} (invalid — will not take effect; remove it (this value is no longer valid and cannot be re-added))`
    if (capped.has(d)) return `${d} (beyond the 100-domain cap — will not take effect)`
    return d
  })
  io.print(
    lines.length === 0
      ? `${teamSlug}: no additive egress domains (base allowlist only)`
      : `${teamSlug} additive egress domains:\n  ${lines.join('\n  ')}`
  )
}

export async function egressAllowlistCommand(args: string[], io: EgressAllowlistCommandIo): Promise<number> {
  const teamSlug = firstPositional(args)
  if (!teamSlug) {
    printErr(io, 'Usage: orizu team egress-allowlist <team> [--add <domain>|--remove <domain>|--set a.com,b.com|--clear] [--json]')
    return 1
  }
  const { runEgressAllowlist } = await import('./egress-allowlist-workflow.js')
  return await runEgressAllowlist({
    teamSlug,
    path: `/api/cli/teams/${encodeURIComponent(teamSlug)}/egress-allowlist`,
    setValue: argValue(args, '--set'),
    addValue: argValue(args, '--add'),
    removeValue: argValue(args, '--remove'),
    clear: args.includes('--clear'),
  }, io)
}
