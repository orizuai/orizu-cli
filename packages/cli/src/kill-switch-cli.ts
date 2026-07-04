/**
 * Per-team agent kill switch CLI (ALI-1007 / G6):
 *   orizu team kill-agents <team> [--reason <text>]
 *   orizu team release-agents <team>
 *
 * `kill-agents` ENGAGES the switch — ends every active session of the team and
 * revokes its agent tokens "in seconds"; `release-agents` re-enables minting
 * (killed sessions stay ended). Human ADMIN only: the server rejects agent
 * bearers and non-admins. Pure command logic with an injected fetcher so the
 * entry point owns argument parsing and human/JSON output.
 */

import { authedFetch } from './http.js'

export type CliFetcher = (path: string, init?: RequestInit) => Promise<Response>

export interface KillSwitchCommandIo {
  json: boolean
  print: (line: string) => void
  printErr?: (line: string) => void
  fetcher?: CliFetcher
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

function fetcherFrom(io: KillSwitchCommandIo): CliFetcher {
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
      if (argValue(args, arg) !== null) {
        i += 1
      }
      continue
    }
    return arg
  }
  return null
}

function emit(io: KillSwitchCommandIo, payload: Record<string, unknown>, human: string): void {
  io.print(io.json ? JSON.stringify(payload) : human)
}

function printErr(io: KillSwitchCommandIo, message: string): void {
  ;(io.printErr ?? io.print)(message)
}

export async function killSwitchCommand(args: string[], io: KillSwitchCommandIo): Promise<number> {
  const subcommand = args[0]

  if (subcommand !== 'kill-agents' && subcommand !== 'release-agents') {
    printErr(io, 'Usage: orizu team <kill-agents|release-agents> <team> [--reason <text>] [--json]')
    return 1
  }

  const teamSlug = firstPositional(args.slice(1))
  if (!teamSlug) {
    printErr(io, `Usage: orizu team ${subcommand} <team>${subcommand === 'kill-agents' ? ' [--reason <text>]' : ''} [--json]`)
    return 1
  }

  const path = `/api/cli/teams/${encodeURIComponent(teamSlug)}/agent-kill-switch`

  if (subcommand === 'kill-agents') {
    const reason = argValue(args, '--reason')
    const response = await fetcherFrom(io)(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reason ? { reason } : {}),
    })
    if (!response.ok) {
      printErr(io, `kill-agents failed (${response.status}): ${await responseMessage(response)}`)
      return 1
    }
    const data = (await response.json()) as Record<string, unknown>
    emit(
      io,
      data,
      `agent kill switch ENGAGED for ${teamSlug} ` +
        `(${data.sessionsEnded ?? 0} sessions ended, ${data.tokensRevoked ?? 0} tokens revoked)`
    )
    return 0
  }

  const response = await fetcherFrom(io)(path, { method: 'DELETE' })
  if (!response.ok) {
    printErr(io, `release-agents failed (${response.status}): ${await responseMessage(response)}`)
    return 1
  }
  const data = (await response.json()) as Record<string, unknown>
  emit(io, data, `agent kill switch RELEASED for ${teamSlug} (killed sessions stay ended)`)
  return 0
}
