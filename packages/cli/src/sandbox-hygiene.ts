/**
 * Provider-neutral sandbox token-hygiene sweep (ALI-973 / ALI-1050).
 *
 * Extracted out of `daytona-slice.ts` so the hygiene helper carries NO Daytona
 * coupling: it works against any `SandboxProvider`/`SandboxSession` (ADR-003
 * seam) and is imported by the shipped hosted-bootstrap path (`hosted-bootstrap
 * .ts`) as well as the founder-only Daytona slice. Keeping it here means the
 * shipped code never transitively reaches the optional `@daytonaio/sdk`.
 */

import type { SandboxSession } from './sandbox-provider.js'

export interface HygieneFinding {
  location: string
  marker: string
}

export interface HygieneProbe {
  location: string
  /** Shell command whose stdout is scanned for tokens + markers. */
  command: string
}

/**
 * The list of places a short-lived git token can leak inside a sandbox after a
 * transient clone+push. List-driven so it is trivial to extend. `${repo}` is
 * substituted with the repo path. Ordered from the repo-local stores outward to
 * global config, the credential cache, the reflog, shell history, and the live
 * process listing / argv — the exact surfaces the Daytona-support question names.
 */
export function tokenLeakProbes(repoPath: string): HygieneProbe[] {
  const R = repoPath
  return [
    { location: `${R}/.git/config`, command: `cat ${R}/.git/config 2>/dev/null || true` },
    { location: `${R}/.git/logs (reflog)`, command: `find ${R}/.git/logs -type f -exec cat {} + 2>/dev/null || true` },
    { location: '~/.git-credentials', command: 'cat "$HOME/.git-credentials" 2>/dev/null || true' },
    { location: '~/.gitconfig (global)', command: 'cat "$HOME/.gitconfig" 2>/dev/null || true' },
    { location: 'git credential cache/store', command: 'cat "$HOME/.cache/git/credential/"* "${XDG_CACHE_HOME:-$HOME/.cache}/git/credential/"* 2>/dev/null || true' },
    { location: 'shell history', command: 'cat "$HOME/.bash_history" "$HOME/.zsh_history" 2>/dev/null || true' },
    { location: 'process listing / argv', command: 'ps -eo args 2>/dev/null || ps aux 2>/dev/null || true' },
    { location: 'process env', command: 'env' },
  ]
}

/**
 * Grep the sandbox filesystem + process table for token values and the
 * `x-access-token` marker across every known leak surface (see `tokenLeakProbes`).
 * Returns every finding; an empty array means the transient operations left no
 * residue. This is the load-bearing check the whole slice exists to make.
 *
 * NOTE (local-sim): the reflog/config/credential-store/history probes run
 * meaningfully in local-sim, but `ps`/argv coverage is only decisive on the live
 * Daytona run (local-sim runs the git clone via a child process on the host, not
 * inside an isolated PID namespace). The WS-F memo marks that probe live-only.
 */
export async function sweepForTokenResidue(
  session: SandboxSession,
  opts: { tokens: string[]; repoPath: string; markers?: string[]; probes?: HygieneProbe[] }
): Promise<HygieneFinding[]> {
  const markers = opts.markers ?? ['x-access-token']
  const tokens = opts.tokens.filter(token => token.length > 0)
  const probes = opts.probes ?? tokenLeakProbes(opts.repoPath)

  const findings: HygieneFinding[] = []
  for (const probe of probes) {
    const { stdout } = await session.exec(probe.command)
    for (const token of tokens) {
      if (stdout.includes(token)) {
        findings.push({ location: probe.location, marker: 'token-value' })
      }
    }
    for (const marker of markers) {
      if (stdout.includes(marker)) {
        findings.push({ location: probe.location, marker })
      }
    }
  }
  return findings
}
