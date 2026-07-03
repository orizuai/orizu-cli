/**
 * Promotion manifests CLI (ALI-907): list | show | approve | reject | apply.
 * Pure command logic with an injected fetcher and project resolver; the entry
 * point owns argument parsing and human/JSON output. apply is idempotent on the
 * server — re-applying returns the stored outcome.
 */

import { authedFetch } from './http.js'

export type CliFetcher = (path: string, init?: RequestInit) => Promise<Response>

export interface ManifestsCommandIo {
  json: boolean
  print: (line: string) => void
  fetcher?: CliFetcher
  resolveProjectSlug?: (arg: string | null) => Promise<string>
}

const MANIFEST_ACTIONS = new Set(['approve', 'reject', 'apply'])

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

async function requireOk(response: Response, action: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new Error(`${action} failed (${response.status}): ${await responseMessage(response)}`)
  }
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

function fetcherFrom(io: ManifestsCommandIo): CliFetcher {
  return io.fetcher ?? authedFetch
}

function argValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag)
  if (index === -1 || index + 1 >= args.length || args[index + 1].startsWith('--')) {
    return null
  }
  return args[index + 1]
}

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

async function requireProjectSlug(io: ManifestsCommandIo, args: string[]): Promise<string> {
  if (!io.resolveProjectSlug) {
    throw new Error('Project resolver unavailable')
  }
  return io.resolveProjectSlug(argValue(args, '--project'))
}

function emit(io: ManifestsCommandIo, payload: Record<string, unknown>, human: string) {
  io.print(io.json ? JSON.stringify(payload) : human)
}

function manifestLine(manifest: Record<string, unknown>): string {
  const id = typeof manifest.id === 'string' ? manifest.id : '(unknown)'
  const status = typeof manifest.status === 'string' ? manifest.status : '(unknown)'
  const actionType = typeof manifest.actionType === 'string' ? manifest.actionType : '(unknown)'
  return `${id}  ${status}  ${actionType}`
}

export async function manifestsCommand(args: string[], io: ManifestsCommandIo): Promise<number> {
  const positional = positionalArgs(args)
  const subcommand = positional[0]

  if (subcommand === 'list') {
    const projectSlug = await requireProjectSlug(io, args)
    const status = argValue(args, '--status')
    const query = status
      ? `?project=${encodeURIComponent(projectSlug)}&status=${encodeURIComponent(status)}`
      : `?project=${encodeURIComponent(projectSlug)}`
    const response = await fetcherFrom(io)(`/api/cli/promotion-manifests${query}`)
    const data = await requireOk(response, 'Manifest list')
    const manifests = Array.isArray(data.manifests) ? (data.manifests as Record<string, unknown>[]) : []
    emit(io, { manifests }, ['promotion manifests', ...manifests.map(manifestLine)].join('\n'))
    return 0
  }

  if (subcommand === 'show') {
    const id = positional[1]
    if (!id) {
      throw new Error('Usage: orizu manifests show <id> [--json]')
    }
    const response = await fetcherFrom(io)(`/api/cli/promotion-manifests/${encodeURIComponent(id)}`)
    const data = await requireOk(response, 'Manifest show')
    const manifest = (data.manifest ?? {}) as Record<string, unknown>
    emit(io, { manifest }, manifestLine(manifest))
    return 0
  }

  if (subcommand && MANIFEST_ACTIONS.has(subcommand)) {
    const id = positional[1]
    if (!id) {
      throw new Error(`Usage: orizu manifests ${subcommand} <id> [--json]`)
    }
    const response = await fetcherFrom(io)(`/api/cli/promotion-manifests/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: subcommand }),
    })
    const data = await requireOk(response, `Manifest ${subcommand}`)
    const manifest = (data.manifest ?? {}) as Record<string, unknown>
    emit(io, { manifest }, manifestLine(manifest))
    return 0
  }

  io.print('Usage: orizu manifests <list|show|approve|reject|apply> ... [--json]')
  return 1
}
