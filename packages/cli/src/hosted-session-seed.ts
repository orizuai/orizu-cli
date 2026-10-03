/**
 * Fills an empty hosted session copy from its team copy (ORI-2118).
 *
 * Artifacts forks of a team copy whose history has a few file-adding commits
 * cannot be cloned or pushed to (measured 2026-10-03, binding and REST). The
 * broker therefore creates the session copy EMPTY, and the sandbox boot fills
 * it here before its first clone: a bare clone of the team copy's `main`, then
 * a push of that `main` into the session copy. A Worker cannot run git, so
 * this is the first place in session start that can.
 *
 * It fills a copy only when the copy has no branches at all, which is what a
 * freshly created copy looks like. A retried or resumed boot finds `main` and
 * does nothing, so it never overwrites the agent's work, and a working
 * repository whose content lives on another branch is never touched. The
 * push is never forced; if another boot filled the copy first, that is fine.
 * Credentials come only through the `-c` settings the caller passes (the
 * boot's credential helper), never in a URL or argument.
 */

export const SESSION_COPY_SEED_FAILURE = 'session copy could not be filled from the team copy'

interface SeedExecResult {
  status: number
  stdout: string
  stderr: string
}
type SeedExec = (cmd: string, args: string[], opts?: { cwd?: string }) => SeedExecResult

export interface SeedSessionCopyInput {
  exec: SeedExec
  sessionRemote: string
  /** `git -c` settings that authenticate to the session copy. */
  sessionGitConfig: string[]
  /** Called only when the copy is empty: the team copy and its `-c` settings. */
  resolveTeam: () => Promise<{ remote: string; gitConfig: string[] }>
  /** A path owned only by this seed operation; cleared before and after use. */
  scratchDir: string
}

function withConfig(config: string[]): string[] {
  return config.flatMap(setting => ['-c', setting])
}

function failure(step: string, result: SeedExecResult): Error {
  const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim()
  return new Error(`${SESSION_COPY_SEED_FAILURE}: ${step}: ${detail}`)
}

/** Whether the session copy has any branch. Measured on Artifacts: an empty
 *  repository answers `ls-remote` with exit 0 and no output. Any non-zero
 *  exit is an error, never "empty". */
function sessionHasBranches(input: SeedSessionCopyInput): boolean {
  const listed = input.exec('git', [...withConfig(input.sessionGitConfig), 'ls-remote', '--heads', input.sessionRemote])
  if (listed.status !== 0) throw failure('reading the session copy', listed)
  return listed.stdout.trim().length > 0
}

export async function seedSessionCopy(input: SeedSessionCopyInput): Promise<{ seeded: boolean }> {
  if (sessionHasBranches(input)) return { seeded: false }
  const team = await input.resolveTeam()
  try {
    // A sandbox shutdown can interrupt clone before finally runs. This path
    // belongs only to seeding; never clear the surrounding session directory.
    const cleared = input.exec('rm', ['-rf', '--', input.scratchDir])
    if (cleared.status !== 0) throw failure('clearing the seed scratch', cleared)
    const fetched = input.exec('git', [...withConfig(team.gitConfig), 'clone', '--quiet', '--bare', '--single-branch', '--branch', 'main', team.remote, input.scratchDir])
    if (fetched.status !== 0) throw failure('reading the team copy', fetched)
    const pushed = input.exec('git', ['-C', input.scratchDir, ...withConfig(input.sessionGitConfig), 'push', '--quiet', input.sessionRemote, 'refs/heads/main:refs/heads/main'])
    if (pushed.status !== 0) {
      // Another boot of the same session may have filled it first.
      if (sessionHasBranches(input)) return { seeded: false }
      throw failure('pushing into the session copy', pushed)
    }
    return { seeded: true }
  } finally {
    input.exec('rm', ['-rf', '--', input.scratchDir])
  }
}
