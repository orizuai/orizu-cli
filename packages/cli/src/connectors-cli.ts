/**
 * Connector readiness CLI (ALI-903). Thin, read-only consumer of the
 * project-scoped `/api/cli/connectors` endpoint. Pure command logic with an
 * injected fetcher and project resolver; the entry point owns argument parsing
 * and human/JSON output. Secret material is never printed (the endpoint already
 * redacts config and surfaces credentials only as a boolean).
 */

import { authedFetch } from './http.js'

export type CliFetcher = (path: string, init?: RequestInit) => Promise<Response>

export interface ConnectorReadiness {
  type: string
  status: string
  hasCredentials: boolean
  updatedAt: string | null
  config: Record<string, unknown>
}

export interface ConnectorsResult {
  connectors: ConnectorReadiness[]
}

export interface FetchConnectorsOptions {
  fetcher?: CliFetcher
  projectSlug: string
}

export interface ConnectorsCommandIo {
  json: boolean
  print: (line: string) => void
  fetcher?: CliFetcher
  resolveProjectSlug?: (arg: string | null) => Promise<string>
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const data = (await response.clone().json()) as Record<string, unknown>
    const error = typeof data.error === 'string' ? data.error : null
    const message = typeof data.message === 'string' ? data.message : null
    return error || message || response.statusText || String(response.status)
  } catch {
    return response.statusText || String(response.status)
  }
}

export async function fetchConnectors(opts: FetchConnectorsOptions): Promise<ConnectorsResult> {
  const fetcher = opts.fetcher ?? authedFetch
  const response = await fetcher(`/api/cli/connectors?project=${encodeURIComponent(opts.projectSlug)}`)
  if (!response.ok) {
    throw new Error(`Connector status failed (${response.status}): ${await responseMessage(response)}`)
  }
  const data = (await response.json()) as ConnectorsResult
  return { connectors: Array.isArray(data.connectors) ? data.connectors : [] }
}

function argValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag)
  if (index === -1 || index + 1 >= args.length || args[index + 1].startsWith('--')) {
    return null
  }
  return args[index + 1]
}

// Positional tokens only: skips flags AND their values, so
// `orizu connectors --project team/slug` never misreads the value.
function positionalArgs(args: string[]): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      if (argValue(args, arg) !== null) {
        i += 1
      }
      continue
    }
    values.push(arg)
  }
  return values
}

function formatConnector(connector: ConnectorReadiness): string {
  const creds = connector.hasCredentials ? 'credentials:yes' : 'credentials:no'
  return `${connector.type}  ${connector.status}  ${creds}`
}

export async function connectorsCommand(args: string[], io: ConnectorsCommandIo): Promise<number> {
  const subcommand = positionalArgs(args)[0]
  if (subcommand && subcommand !== 'status') {
    io.print('Usage: orizu connectors [status] [--project <team/project>] [--json]')
    return 1
  }

  const resolveProjectSlug = io.resolveProjectSlug
  if (!resolveProjectSlug) {
    throw new Error('Project resolver unavailable')
  }
  const projectSlug = await resolveProjectSlug(argValue(args, '--project'))
  const result = await fetchConnectors({ fetcher: io.fetcher, projectSlug })

  if (io.json) {
    io.print(JSON.stringify(result))
    return 0
  }

  if (result.connectors.length === 0) {
    io.print('No connectors known for this project.')
    return 0
  }
  for (const connector of result.connectors) {
    io.print(formatConnector(connector))
  }
  return 0
}
