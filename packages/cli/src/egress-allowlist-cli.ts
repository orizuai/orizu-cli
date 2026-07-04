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

async function fetchCurrent(fetcher: CliFetcher, path: string): Promise<string[]> {
  const response = await fetcher(path, { method: 'GET' })
  if (!response.ok) {
    throw new Error(`show failed (${response.status}): ${await responseMessage(response)}`)
  }
  const data = (await response.json()) as { extraDomains?: unknown }
  return Array.isArray(data.extraDomains) ? data.extraDomains.filter((d): d is string => typeof d === 'string') : []
}

function emit(io: EgressAllowlistCommandIo, teamSlug: string, domains: string[]): void {
  if (io.json) {
    io.print(JSON.stringify({ teamSlug, extraDomains: domains }))
    return
  }
  io.print(
    domains.length === 0
      ? `${teamSlug}: no additive egress domains (base allowlist only)`
      : `${teamSlug} additive egress domains:\n  ${domains.join('\n  ')}`
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
      const set = new Set(current)
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
    const data = (await response.json()) as { extraDomains?: unknown }
    const stored = Array.isArray(data.extraDomains)
      ? data.extraDomains.filter((d): d is string => typeof d === 'string')
      : next
    emit(io, teamSlug, stored)
    return 0
  } catch (error) {
    printErr(io, error instanceof Error ? error.message : String(error))
    return 1
  }
}
