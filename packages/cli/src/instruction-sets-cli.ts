import { authedFetch } from './http.js'

export interface InstructionSetsCommandIo {
  json: boolean
  print: (line: string) => void
  resolveProjectSlug: (provided: string | null) => Promise<string>
}

function positionalArgs(args: string[]): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!
    if (value.startsWith('--')) {
      if (argValue(args, value) !== null) index += 1
      continue
    }
    values.push(value)
  }
  return values
}

function argValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag)
  return index === -1 || !args[index + 1] || args[index + 1]!.startsWith('--')
    ? null
    : args[index + 1]!
}

async function responsePayload(response: Response, action: string): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    throw new Error(`${action} failed (${response.status}): ${typeof payload.error === 'string' ? payload.error : response.statusText}`)
  }
  return payload
}

export async function instructionSetsCommand(args: string[], io: InstructionSetsCommandIo): Promise<number> {
  const [subcommand, reference] = positionalArgs(args)
  const project = await io.resolveProjectSlug(argValue(args, '--project'))
  const status = argValue(args, '--status') || 'active'
  if (subcommand !== 'list' && subcommand !== 'show') throw new Error('Usage: instruction-sets list|show --project <team/project> [--status active|archived|all] [--json]')
  if (subcommand === 'show' && (!reference || reference.startsWith('--'))) throw new Error('Instruction set name is required')
  if (status !== 'active' && status !== 'archived' && status !== 'all') throw new Error('--status must be active, archived, or all')

  const query = `project=${encodeURIComponent(project)}&status=${encodeURIComponent(status)}`
  const path = subcommand === 'list'
    ? `/api/cli/instruction-sets?${query}`
    : `/api/cli/instruction-sets/${encodeURIComponent(reference!)}?${query}`
  const payload = await responsePayload(await authedFetch(path, { method: 'GET' }), `Instruction sets ${subcommand}`)
  if (io.json) {
    io.print(JSON.stringify(payload))
    return 0
  }
  if (subcommand === 'list') {
    const sets = Array.isArray(payload.instructionSets) ? payload.instructionSets : []
    for (const item of sets) {
      const set = item as { name?: string; shape?: string[]; status?: string }
      io.print(`${set.name || 'unnamed'}${set.status === 'archived' ? ' [archived]' : ''}${set.shape ? ` (${set.shape.join(', ')})` : ''}`)
    }
    return 0
  }
  const set = payload.instructionSet as { name?: string; shape?: string[]; status?: string; default?: { versionNumber?: number } | null; profiles?: Array<{ modelConfigIdentity?: string | null; production?: { versionNumber?: number } | null; latestVersionNumber?: number | null }> } | undefined
  io.print(`${set?.name || reference}${set?.status === 'archived' ? ' [archived]' : ''}: ${set?.shape?.join(', ') || ''}`)
  if (set?.default) io.print(`Default: v${set.default.versionNumber ?? '?'}`)
  for (const profile of set?.profiles || []) {
    io.print(`${profile.modelConfigIdentity || 'unspecified'}: production ${profile.production ? `v${profile.production.versionNumber}` : '—'}, latest ${profile.latestVersionNumber ?? '—'}`)
  }
  return 0
}
