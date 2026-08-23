import { extractErrorMessage } from './error-response.js'
import { sanitizeTerminalText } from './json-response.js'

export interface OptimizationsPromoteIo {
  json: boolean
  print: (line: string) => void
  resolveProjectSlug: (projectArg: string | null) => Promise<string>
  fetcher: (path: string, init?: RequestInit) => Promise<Response>
}

function option(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name)
  return index === -1 || !args[index + 1] || args[index + 1].startsWith('--') ? null : args[index + 1]
}

export async function promoteOptimizationCommand(args: string[], io: OptimizationsPromoteIo): Promise<void> {
  const runId = args.find(arg => !arg.startsWith('--') && arg !== option(args, '--candidate') && arg !== option(args, '--label') && arg !== option(args, '--project'))
  const candidateId = option(args, '--candidate')
  const label = option(args, '--label')
  if (!runId || !candidateId || (label !== null && label !== 'production')) {
    throw new Error('Usage: orizu optimizations promote <run-id> --candidate <id> [--label production] [--project <team/project>] [--json]')
  }
  const project = await io.resolveProjectSlug(option(args, '--project'))
  const response = await io.fetcher(`/api/cli/optimization-runs/${encodeURIComponent(runId)}/promote?project=${encodeURIComponent(project)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidateId, label }),
  })
  if (!response.ok) throw new Error(`Failed to promote optimization candidate: ${await extractErrorMessage(response)}`)
  const data = await response.json() as { promptVersionId?: string; profileVersionId?: string; components?: Array<{ key: string; status: string }> }
  if (io.json) {
    io.print(JSON.stringify(data.profileVersionId
      ? { profileVersionId: data.profileVersionId, components: data.components ?? [] }
      : { promptVersionId: data.promptVersionId }))
    return
  }
  if (data.profileVersionId) {
    io.print(`Promoted profile version ${sanitizeTerminalText(data.profileVersionId)}`)
    for (const component of data.components ?? []) io.print(`${sanitizeTerminalText(component.key)}: ${sanitizeTerminalText(component.status)}`)
    return
  }
  io.print(`Promoted prompt version ${sanitizeTerminalText(data.promptVersionId ?? '')}`)
}
