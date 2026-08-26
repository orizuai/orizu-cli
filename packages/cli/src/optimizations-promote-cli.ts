import { extractErrorMessage } from './error-response.js'
import { sanitizeHumanInlineText, sanitizeTerminalText } from './json-response.js'
import type { GlobalFlags } from './global-flags.js'

export interface OptimizationsPromoteIo {
  json: boolean
  origin: GlobalFlags
  print: (line: string) => void
  printErr: (line: string) => void
  resolveProjectSlug: (projectArg: string | null) => Promise<string>
  fetcher: (path: string, init?: RequestInit) => Promise<Response>
}

function option(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name)
  return index === -1 || !args[index + 1] || args[index + 1].startsWith('--') ? null : args[index + 1]
}

function shellArgument(value: string): string {
  if (/^[A-Za-z0-9._/:@-]+$/.test(value)) return value
  if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(value)) {
    let escaped = ''
    for (const character of value) {
      if (character === '\\') escaped += '\\\\'
      else if (character === "'") escaped += "\\'"
      else if (character === '\n') escaped += '\\n'
      else if (character === '\r') escaped += '\\r'
      else if (character === '\t') escaped += '\\t'
      else {
        const codePoint = character.codePointAt(0)!
        if (codePoint <= 0x1f || codePoint === 0x7f) {
          escaped += `\\x${codePoint.toString(16).padStart(2, '0')}`
        } else if ((codePoint >= 0x80 && codePoint <= 0x9f) || codePoint === 0x2028 || codePoint === 0x2029) {
          for (const byte of new TextEncoder().encode(character)) {
            escaped += `\\x${byte.toString(16).padStart(2, '0')}`
          }
        } else {
          escaped += character
        }
      }
    }
    return `$'${escaped}'`
  }
  const safeValue = sanitizeTerminalText(value)
  return `'${safeValue.replace(/'/g, `'\\''`)}'`
}

function inlineTerminalText(value: string): string {
  return sanitizeHumanInlineText(sanitizeTerminalText, value)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

const APPLIED_LABEL_VERSION_SKEW_NOTE = 'Server response predates the appliedLabel discriminator; printing the production-promotion follow-up as a fail-safe.'

function productionPromotionReplay(
  runId: string,
  candidateId: string,
  project: string,
  origin: GlobalFlags
): string {
  const originArguments = origin.local
    ? ' --local'
    : origin.server
      ? ` --server ${shellArgument(origin.server)}`
      : ''
  return `Promote this profile with: orizu${originArguments} optimizations promote ${shellArgument(runId)} --candidate ${shellArgument(candidateId)} --label production --project ${shellArgument(project)}`
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
  const data = await response.json() as
    | { promptVersionId: string }
    | {
      profileVersionId: string
      versionNumber: number
      appliedLabel?: string | null
      components: Array<{ key: string; status: string }>
    }
  const isProfilePromotion = 'profileVersionId' in data
  const replay = isProfilePromotion && data.appliedLabel !== 'production'
    ? productionPromotionReplay(runId, candidateId, project, io.origin)
    : null
  if (io.json) {
    io.print(JSON.stringify(isProfilePromotion
      ? {
          profileVersionId: data.profileVersionId,
          versionNumber: data.versionNumber,
          appliedLabel: data.appliedLabel,
          components: data.components,
        }
      : { promptVersionId: data.promptVersionId }))
    if (isProfilePromotion && data.appliedLabel === undefined) {
      io.printErr(APPLIED_LABEL_VERSION_SKEW_NOTE)
      io.printErr(replay!)
    }
    return
  }
  if (isProfilePromotion) {
    io.print(`Promoted profile version ${sanitizeTerminalText(data.profileVersionId)}`)
    if (data.appliedLabel === undefined) {
      io.printErr(APPLIED_LABEL_VERSION_SKEW_NOTE)
    }
    if (replay) io.print(replay)
    for (const component of data.components) io.print(`${inlineTerminalText(component.key)}: ${inlineTerminalText(component.status)}`)
    return
  }
  io.print(`Promoted prompt version ${sanitizeTerminalText(data.promptVersionId)}`)
}
