import { sanitizeHumanInlineText, sanitizeTerminalText } from './json-response.js'
import type { GlobalFlags } from './global-flags.js'
import type { SeedAgainstProduction } from './seed-against-production.js'

export interface OptimizationsPromoteIo {
  json: boolean
  origin: GlobalFlags
  print: (line: string) => void
  printErr: (line: string) => void
  resolveProjectSlug: (projectArg: string | null) => Promise<string>
  /** Stands in for `authedFetch` in tests. */
  fetcher?: (path: string, init: RequestInit) => Promise<Response>
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
  return `'${safeValue.replace(/'/g, "'\\''")}'`
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

/**
 * ORI-2128: a candidate grown from a Seed older than Production does not
 * contain the changes made since that Seed. Warn; never refuse (ORI-2132).
 */
function staleSeedWarningFor(data: Partial<SeedAgainstProduction>): string | null {
  const seed = data.runSeedVersionNumber
  const production = data.productionVersionNumber
  if (typeof seed !== 'number' || typeof production !== 'number' || seed >= production) return null
  return `Warning: this run started from v${seed}; production is v${production}. Changes made since v${seed} are not in this candidate.`
}

export async function promoteOptimizationCommand(args: string[], io: OptimizationsPromoteIo): Promise<void> {
  const runId = args.find(arg => !arg.startsWith('--') && arg !== option(args, '--candidate') && arg !== option(args, '--label') && arg !== option(args, '--project'))
  const candidateId = option(args, '--candidate')
  const label = option(args, '--label')
  if (!runId || !candidateId || (label !== null && label !== 'production')) {
    throw new Error('Usage: orizu optimizations promote <run-id> --candidate <id> [--label production] [--project <team/project>] [--json]')
  }
  const project = await io.resolveProjectSlug(option(args, '--project'))
  const writes = await import('./cli-write-commands.js')
  const data = await writes.sendCommandWrite(writes.candidatePromote(runId, project, { candidateId, label }), { json: io.json, print: io.print, ...(io.fetcher ? { fetcher: io.fetcher } : {}) })
  if (data === null) return
  const isProfilePromotion = 'profileVersionId' in data
  const replay = isProfilePromotion && data.appliedLabel !== 'production'
    ? productionPromotionReplay(runId, candidateId, project, io.origin)
    : null
  const staleSeedWarning = isProfilePromotion ? staleSeedWarningFor(data) : null
  if (io.json) {
    io.print(JSON.stringify(isProfilePromotion
      ? {
          profileVersionId: data.profileVersionId,
          versionNumber: data.versionNumber,
          appliedLabel: data.appliedLabel,
          // JSON.stringify omits these when an older server did not send them.
          runSeedVersionNumber: data.runSeedVersionNumber,
          productionVersionNumber: data.productionVersionNumber,
          components: data.components,
        }
      : { promptVersionId: data.promptVersionId }))
    if (staleSeedWarning) io.printErr(staleSeedWarning)
    if (isProfilePromotion && data.appliedLabel === undefined) {
      io.printErr(APPLIED_LABEL_VERSION_SKEW_NOTE)
      io.printErr(replay!)
    }
    return
  }
  if (isProfilePromotion) {
    if (staleSeedWarning) io.printErr(staleSeedWarning)
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
