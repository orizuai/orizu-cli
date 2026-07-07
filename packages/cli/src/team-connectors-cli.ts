/**
 * Per-team hosted-session CONNECTOR allowlist CLI (ALI-1048, CONFIG-SURFACE half):
 *   orizu team connectors list [--team <slug>] [--json]
 *   orizu team connectors enable <connector> [--team <slug>] [--json]
 *   orizu team connectors disable <connector> [--team <slug>] [--json]
 *
 * A team explicitly approves which vault-held connectors (credentials, e.g.
 * 'braintrust') may be INJECTED into hosted agent sessions. Default-deny: a
 * connector is not available to hosted sessions until enabled here. Human ADMIN
 * or CURATOR only — the server rejects agent bearers and non-admin/curator members
 * (the definer RPC gates on is_team_admin_or_curator).
 *
 * DEFERRED (ALI-1031 pairing): this only manages the APPROVAL list. The actual
 * per-session secret injection into the sandbox env is a server-side step deferred
 * to pair with ALI-1031's provisioning (a secret cannot transit the client CLI).
 *
 * Pure command logic with an injected fetcher, mirroring egress-allowlist-cli.
 */

import { authedFetch } from './http.js'

export type CliFetcher = (path: string, init?: RequestInit) => Promise<Response>

export interface TeamConnectorsCommandIo {
  json: boolean
  print: (line: string) => void
  printErr?: (line: string) => void
  fetcher?: CliFetcher
  /** Resolve the active team slug when --team is omitted (interactive default). */
  resolveTeamSlug?: () => Promise<string | null>
}

interface HostedConnector {
  ref: string
  kind: string
  enabledForHosted: boolean
  enabledAt: string | null
  inCatalog: boolean
}

function fetcherFrom(io: TeamConnectorsCommandIo): CliFetcher {
  return io.fetcher ?? authedFetch
}

function printErr(io: TeamConnectorsCommandIo, message: string): void {
  ;(io.printErr ?? io.print)(message)
}

function argValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag)
  if (index === -1 || index + 1 >= args.length || args[index + 1].startsWith('--')) {
    return null
  }
  return args[index + 1]
}

// The first non-flag arg after the subcommand (the connector), skipping flag
// values (e.g. the value after --team).
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

async function responseMessage(response: Response): Promise<string> {
  try {
    const data = (await response.clone().json()) as Record<string, unknown>
    const error = typeof data.error === 'string' ? data.error : null
    return error || response.statusText || String(response.status)
  } catch {
    return response.statusText || String(response.status)
  }
}

async function fetchList(fetcher: CliFetcher, path: string): Promise<HostedConnector[]> {
  const response = await fetcher(path, { method: 'GET' })
  if (!response.ok) {
    throw new Error(`list failed (${response.status}): ${await responseMessage(response)}`)
  }
  const data = (await response.json()) as { connectors?: unknown }
  return Array.isArray(data.connectors) ? (data.connectors as HostedConnector[]) : []
}

function emitList(io: TeamConnectorsCommandIo, teamSlug: string, connectors: HostedConnector[]): void {
  if (io.json) {
    io.print(JSON.stringify({ teamSlug, connectors }))
    return
  }
  if (connectors.length === 0) {
    io.print(`${teamSlug}: no connectors available`)
    return
  }
  const rows = connectors.map(c => {
    const status = c.enabledForHosted ? 'yes' : 'no'
    const note = c.inCatalog ? '' : ' (not in catalog)'
    return `  ${c.ref.padEnd(24)} enabled-for-hosted: ${status}${note}`
  })
  io.print(`${teamSlug} hosted connectors:\n${rows.join('\n')}`)
}

async function resolveTeamSlug(args: string[], io: TeamConnectorsCommandIo): Promise<string | null> {
  const explicit = argValue(args, '--team')
  if (explicit) {
    return explicit
  }
  if (io.resolveTeamSlug) {
    return io.resolveTeamSlug()
  }
  return null
}

const USAGE =
  'Usage: orizu team connectors <list|enable|disable> [<connector>] [--team <slug>] [--json]'

export async function teamConnectorsCommand(args: string[], io: TeamConnectorsCommandIo): Promise<number> {
  const subcommand = args[0]
  if (subcommand !== 'list' && subcommand !== 'enable' && subcommand !== 'disable') {
    printErr(io, USAGE)
    return 1
  }
  const rest = args.slice(1)

  const teamSlug = await resolveTeamSlug(rest, io)
  if (!teamSlug) {
    printErr(io, 'A team is required. Pass --team <slug>.')
    return 1
  }
  const path = `/api/cli/teams/${encodeURIComponent(teamSlug)}/hosted-connectors`
  const fetcher = fetcherFrom(io)

  try {
    if (subcommand === 'list') {
      emitList(io, teamSlug, await fetchList(fetcher, path))
      return 0
    }

    const connector = firstPositional(rest)
    if (!connector) {
      printErr(io, `Usage: orizu team connectors ${subcommand} <connector> [--team <slug>] [--json]`)
      return 1
    }

    const response = await fetcher(path, {
      method: subcommand === 'enable' ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connector }),
    })
    if (!response.ok) {
      printErr(io, `connectors ${subcommand} failed (${response.status}): ${await responseMessage(response)}`)
      return 1
    }

    if (io.json) {
      const data = (await response.json()) as Record<string, unknown>
      io.print(JSON.stringify({ teamSlug, ...data }))
    } else {
      const verb = subcommand === 'enable' ? 'enabled for' : 'disabled for'
      io.print(`${connector}: ${verb} hosted sessions on ${teamSlug}`)
    }
    return 0
  } catch (error) {
    printErr(io, error instanceof Error ? error.message : String(error))
    return 1
  }
}
