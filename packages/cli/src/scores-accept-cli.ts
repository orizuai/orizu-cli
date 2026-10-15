/**
 * ALI-1175: `orizu scores accept <score-run-id>` — record a human curator's
 * explicit acceptance of an agent-reported score run as trusted evidence.
 *
 * The decision itself is enforced in the database: the
 * accept_score_run_evidence RPC records actor + timestamp, refuses the agent
 * principal, keeps the first acceptance, and only applies to succeeded
 * agent-reported rows. This module is display plumbing.
 *
 * Lives outside index.ts per the CLI index line ratchet (ALI-976): owns its
 * own argument parsing and printing via injected io.
 */

import { sanitizeTerminalText } from './json-response.js'

export interface ScoresAcceptIo {
  json: boolean
  print: (line: string) => void
  resolveProjectSlug: (projectArg: string | null) => Promise<string>
  fetcher?: (path: string, init: RequestInit) => Promise<Response>
}

function argValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag)
  if (index === -1 || index + 1 >= args.length || args[index + 1].startsWith('--')) {
    return null
  }
  return args[index + 1]
}

// Only these options consume the following token as their value. Valueless
// boolean flags (e.g. --json) must NOT swallow the next token — otherwise
// `scores accept --json <uuid>` loses the run id (Codex round 5, thread 1).
const VALUE_FLAGS = new Set(['--project'])

function firstPositional(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      if (VALUE_FLAGS.has(arg) && i + 1 < args.length && !args[i + 1].startsWith('--')) {
        i += 1
      }
      continue
    }
    return arg
  }
  return null
}

/** args = cliArgs after `scores accept` (positional score-run id + flags). */
export async function acceptScoreRunCommand(args: string[], io: ScoresAcceptIo): Promise<void> {
  const scoreRunId = firstPositional(args)
  if (!scoreRunId) {
    throw new Error('Usage: orizu scores accept <score-run-id> [--project <team/project>] [--json]')
  }

  const project = argValue(args, '--project') || await io.resolveProjectSlug(null)
  const writes = await import('./cli-write-commands.js')
  const data = await writes.sendCommandWrite({ ...writes.scoreAccept(project, scoreRunId), ...(io.fetcher ? { fetcher: io.fetcher } : {}) }, io)
  if (!data) return
  if (io.json) {
    io.print(JSON.stringify(data))
    return
  }

  const run = data.scoreRun
  if (run.alreadyAccepted) {
    io.print(
      `Score ${sanitizeTerminalText(run.id)} was already accepted at ` +
      `${sanitizeTerminalText(run.acceptedAt || 'unknown time')} — keeping the original record`
    )
    return
  }

  io.print(
    `Accepted agent-reported score ${sanitizeTerminalText(run.id)} as evidence ` +
    `(recorded ${sanitizeTerminalText(run.acceptedAt || '')})`
  )
}
