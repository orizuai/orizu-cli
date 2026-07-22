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
 * and non-admins (the definer RPC gates on is_team_admin). Pure command logic
 * with an injected fetcher.
 */

import { authedFetch } from './http.js'

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
  fetcher?: CliFetcher
}

function fetcherFrom(io: EgressAllowlistCommandIo): CliFetcher {
  return io.fetcher ?? authedFetch
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

async function responseMessage(response: Response): Promise<string> {
  try {
    const data = (await response.clone().json()) as Record<string, unknown>
    const error = typeof data.error === 'string' ? data.error : null
    return error || response.statusText || String(response.status)
  } catch {
    return response.statusText || String(response.status)
  }
}

function splitDomains(value: string): string[] {
  return value
    .split(',')
    .map(d => d.trim())
    .filter(d => d.length > 0)
}

interface CurrentAllowlist {
  domains: string[]
  /** ALI-1174: legacy entries the server flags as failing the tightened
   *  validator — stored, shown by GET, but silently dropped by the
   *  coordinator at policy compose. Surfaced so "configured" never silently
   *  means "inert". */
  invalid: string[]
  /** Valid entries beyond the 100-domain cap — equally inert at compose. */
  capped: string[]
}

function stringArray(value: unknown): string[] {
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
function deriveCapped(stored: readonly string[], invalid: readonly string[]): string[] {
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

async function fetchCurrent(fetcher: CliFetcher, path: string): Promise<CurrentAllowlist> {
  const response = await fetcher(path, { method: 'GET' })
  if (!response.ok) {
    throw new Error(`show failed (${response.status}): ${await responseMessage(response)}`)
  }
  const data = (await response.json()) as { extraDomains?: unknown; invalidDomains?: unknown; cappedDomains?: unknown }
  return {
    domains: stringArray(data.extraDomains),
    invalid: stringArray(data.invalidDomains),
    capped: stringArray(data.cappedDomains),
  }
}

function emit(io: EgressAllowlistCommandIo, teamSlug: string, current: CurrentAllowlist): void {
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
  const path = `/api/cli/teams/${encodeURIComponent(teamSlug)}/egress-allowlist`
  const fetcher = fetcherFrom(io)

  const setValue = argValue(args, '--set')
  const addValue = argValue(args, '--add')
  const removeValue = argValue(args, '--remove')
  const clear = args.includes('--clear')
  const isMutation = setValue !== null || addValue !== null || removeValue !== null || clear

  try {
    if (!isMutation) {
      emit(io, teamSlug, await fetchCurrent(fetcher, path))
      return 0
    }

    // Compute the next set. --set/--clear replace; --add/--remove mutate current.
    let next: string[]
    if (setValue !== null) {
      next = splitDomains(setValue)
    } else if (clear) {
      next = []
    } else {
      const current = await fetchCurrent(fetcher, path)
      const set = new Set(current.domains)
      if (addValue) for (const d of splitDomains(addValue)) set.add(d)
      if (removeValue) for (const d of splitDomains(removeValue)) set.delete(d)
      next = [...set]
    }

    const response = await fetcher(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domains: next }),
    })
    if (!response.ok) {
      printErr(io, `egress-allowlist update failed (${response.status}): ${await responseMessage(response)}`)
      return 1
    }
    const data = (await response.json()) as { extraDomains?: unknown; invalidDomains?: unknown }
    const stored = Array.isArray(data.extraDomains) ? stringArray(data.extraDomains) : next
    const invalid = stringArray(data.invalidDomains)
    // Grandfathered retention: a successful PUT may still STORE legacy
    // invalid entries the admin retained — the server flags them and we show
    // it. Round 5 (P2): a >100-entry legacy row can only shrink one entry per
    // PUT (the write RPC's GREATEST(100, stored-1) bound), so the returned
    // set can still be OVER the cap. Re-derive the cap annotations from the
    // returned set — same positional logic GET uses — instead of assuming
    // the RPC left it at/under 100.
    emit(io, teamSlug, { domains: stored, invalid, capped: deriveCapped(stored, invalid) })
    return 0
  } catch (error) {
    printErr(io, error instanceof Error ? error.message : String(error))
    return 1
  }
}
