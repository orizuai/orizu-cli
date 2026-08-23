/**
 * The `orizu scorers` subcommand router (ALI-1554).
 *
 * The five historical branches lived inline in index.ts; folding them here
 * reclaims the headroom the CLI line ratchet (ALI-976) requires before a new
 * subcommand may be added. Behaviour is unchanged: each handler is the same
 * function index.ts already called, and an unrecognised subcommand returns
 * null so main() still falls through to printUsage().
 */
export interface ScorersCommandIo {
  list: () => Promise<void>
  register: () => Promise<void>
  detail: () => Promise<void>
  labelsSet: () => Promise<void>
  exec: () => Promise<void>
  verifyParity: (args: string[]) => Promise<number>
}

/** Returns the process exit code, or null when the subcommand is not ours. */
export async function scorersCommand(args: string[], io: ScorersCommandIo): Promise<number | null> {
  const subcommand = args[1]
  // A Map, not an object literal: `scorers constructor` must not resolve to
  // an Object.prototype member and be treated as a known subcommand.
  const handlers = new Map<string, () => Promise<void>>([
    ['list', io.list], ['register', io.register], ['detail', io.detail], ['exec', io.exec],
  ])
  const handler = subcommand === undefined ? undefined : handlers.get(subcommand)
  if (handler) {
    await handler()
    return 0
  }
  if (subcommand === 'labels' && args[2] === 'set') {
    await io.labelsSet()
    return 0
  }
  if (subcommand === 'verify-parity') {
    return io.verifyParity(args.slice(2))
  }
  return null
}
