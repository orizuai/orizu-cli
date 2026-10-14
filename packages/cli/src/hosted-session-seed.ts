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
 * Team seeds leave populated copies alone. A selected session source is
 * cloned even for a populated destination: its saved main must be an ancestor
 * of destination main before boot may proceed. This preserves replacement
 * commits while refusing a retry that contains only team files. Pushes are
 * never forced. A lost push reply is accepted only after history readback.
 * Credentials come only through the `-c` settings the caller passes (the
 * boot's credential helper), never in a URL or argument.
 */

import { existsSync, readdirSync, renameSync } from 'fs'
import { join } from 'path'

export const SESSION_COPY_SEED_FAILURE = 'session copy could not be filled from the team copy'

interface SeedExecResult {
  status: number
  stdout: string
  stderr: string
}
type SeedExec = (cmd: string, args: string[], opts?: { cwd?: string }) => SeedExecResult

export interface SeedSessionCopyInput {
  exec: SeedExec
  seedOrigin?: 'team' | 'session'
  sessionRemote: string
  /** `git -c` settings that authenticate to the session copy. */
  sessionGitConfig: string[]
  /** Server-selected origin and credentials; selected session origins must
   * also be resolved on populated retries. The legacy name serves team boots. */
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

function verifySourceSeedHistory(input: SeedSessionCopyInput): void {
  const fetched = input.exec('git', ['-C', input.scratchDir, ...withConfig(input.sessionGitConfig), 'fetch', '--quiet', input.sessionRemote, 'refs/heads/main:refs/seed/destination'])
  if (fetched.status !== 0) throw failure('reading destination saved history', fetched)
  const ancestry = input.exec('git', ['-C', input.scratchDir, 'merge-base', '--is-ancestor', 'refs/heads/main', 'refs/seed/destination'])
  if (ancestry.status !== 0) throw new Error('destination does not contain the selected session saved history')
}

export async function seedSessionCopy(input: SeedSessionCopyInput): Promise<{ seeded: boolean }> {
  const hasBranches = sessionHasBranches(input)
  if (hasBranches && input.seedOrigin !== 'session') return { seeded: false }
  const origin = await input.resolveTeam()
  try {
    // A sandbox shutdown can interrupt clone before finally runs. This path
    // belongs only to seeding; never clear the surrounding session directory.
    const cleared = input.exec('rm', ['-rf', '--', input.scratchDir])
    if (cleared.status !== 0) throw failure('clearing the seed scratch', cleared)
    const fetched = input.exec('git', [...withConfig(origin.gitConfig), 'clone', '--quiet', '--bare', '--single-branch', '--branch', 'main', origin.remote, input.scratchDir])
    if (fetched.status !== 0) throw failure(input.seedOrigin === 'session' ? 'reading selected saved files' : 'reading the team copy', fetched)
    if (hasBranches) {
      verifySourceSeedHistory(input)
      return { seeded: false }
    }
    const pushed = input.exec('git', ['-C', input.scratchDir, ...withConfig(input.sessionGitConfig), 'push', '--quiet', input.sessionRemote, 'refs/heads/main:refs/heads/main'])
    if (input.seedOrigin === 'session') {
      verifySourceSeedHistory(input)
      return { seeded: pushed.status === 0 }
    }
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

type SeedExecAsync = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<SeedExecResult>

export interface CloneTeamIntoWorkTreeInput {
  exec: SeedExec
  /** Runs a command without blocking, so the check, the clone and the push
   *  can overlap with each other and with the rest of the boot. */
  execAsync: SeedExecAsync
  sessionRemote: string
  sessionGitConfig: string[]
  resolveTeam: () => Promise<{ remote: string; gitConfig: string[] }>
  /** A path owned only by this clone; cleared before and after use. */
  scratchDir: string
  /** The boot's working folder: absent or empty. */
  workTree: string
  /** Moves one entry into the working folder (default: renameSync). */
  rename?: (from: string, to: string) => void
}

export type CloneTeamIntoWorkTreeResult =
  | { cloned: false }
  /** `filled` settles once the background push into the session copy ends:
   *  true when the copy now has main. It never rejects. */
  | { cloned: true; filled: Promise<boolean> }

/**
 * ORI-2512: a team boot of an empty session copy makes its working folder
 * from ONE clone of the team copy, with the session copy as its push remote,
 * and fills the session copy by pushing in the background. The session copy
 * is checked at the same time as the clone; a copy that already has branches
 * belongs to an earlier boot of this session, so the clone is dropped and the
 * caller clones the session copy as usual. The clone keeps the whole history:
 * an empty copy refuses a push from a shallow clone.
 */
export async function cloneTeamIntoWorkTree(input: CloneTeamIntoWorkTreeInput): Promise<CloneTeamIntoWorkTreeResult> {
  const clear = () => input.exec('rm', ['-rf', '--', input.scratchDir])
  const listing = input.execAsync('git', [...withConfig(input.sessionGitConfig), 'ls-remote', '--heads', input.sessionRemote])
  const cloning = (async () => {
    const origin = await input.resolveTeam()
    const cleared = clear()
    if (cleared.status !== 0) throw failure('clearing the seed scratch', cleared)
    return input.execAsync('git', [...withConfig(origin.gitConfig), 'clone', '--quiet', '--single-branch', '--branch', 'main', origin.remote, input.scratchDir])
  })()
  const settled = cloning.then(() => undefined, () => undefined)
  let listed: SeedExecResult
  try {
    listed = await listing
  } catch (error) {
    await settled
    clear()
    throw error
  }
  // A copy with saved work: answer now. The unneeded clone ends on its own
  // and its scratch is cleared then.
  if (listed.status === 0 && listed.stdout.trim().length > 0) {
    void settled.then(clear)
    return { cloned: false }
  }
  try {
    const fetched = await cloning
    if (listed.status !== 0) throw failure('reading the session copy', listed)
    if (fetched.status !== 0) throw failure('reading the team copy', fetched)
    const pointed = input.exec('git', ['-C', input.scratchDir, 'remote', 'set-url', 'origin', input.sessionRemote])
    if (pointed.status !== 0) throw failure('pointing the working folder at the session copy', pointed)
    // ORI-2512: an existing folder (the runtime image may ship it empty, and
    // the boot may have started OpenCode in it) is filled in place, never
    // replaced: a process already started there would be left in a deleted
    // folder. A missing folder becomes the clone.
    if (existsSync(input.workTree)) {
      if (readdirSync(input.workTree).length > 0) throw failure('making the working folder', { status: 1, stdout: '', stderr: `${input.workTree} is not empty` })
      try {
        // `.git` last: a fill that stops partway leaves no repository, which
        // the next boot refuses, rather than one missing files that a save
        // would push as deleted.
        const entries = readdirSync(input.scratchDir).sort((a, b) => Number(a === '.git') - Number(b === '.git'))
        const rename = input.rename ?? renameSync
        for (const entry of entries) rename(join(input.scratchDir, entry), join(input.workTree, entry))
      } catch (error) {
        throw failure('making the working folder', { status: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) })
      }
    } else {
      const moved = input.exec('mv', ['--', input.scratchDir, input.workTree])
      if (moved.status !== 0) throw failure('making the working folder', moved)
    }
  } finally {
    clear()
  }
  const filled = input.execAsync('git', ['-C', input.workTree, ...withConfig(input.sessionGitConfig), 'push', '--quiet', 'origin', 'refs/heads/main:refs/heads/main'])
    .then(async pushed => {
      if (pushed.status === 0) return true
      // Another boot, or the agent's own first save, may have filled it first.
      const listed = await input.execAsync('git', [...withConfig(input.sessionGitConfig), 'ls-remote', '--heads', input.sessionRemote])
      return listed.status === 0 && listed.stdout.trim().length > 0
    })
    .catch(() => false)
  return { cloned: true, filled }
}
