/**
 * Auto-harvest (ALI-1036) — deterministic, loop-side durability.
 *
 * At the END of a hosted run (BOTH the success and failure paths — a failed
 * run's partial work is still valuable), the in-sandbox loop calls
 * `harvestWorkspace` to make sure nothing the agent produced is lost:
 *
 *   1. `git status --porcelain` (plumbing) decides if the clone is dirty. Ignored
 *      files never appear in porcelain output, so a checkpoint is skipped when the
 *      only changes are ignored files.
 *   2. If dirty: `git add -A` then `git commit` attributed to the agent identity
 *      (AGENT_GIT_IDENTITY) with message `checkpoint: run <runId> auto-harvest`.
 *   3. If there is anything unpushed (a fresh checkpoint OR pre-existing local
 *      commits the agent made but did not push), `git push` to the session branch
 *      (the repo-local credential helper configured by bootstrap authorizes it).
 *   4. Return a typed outcome the loop records as a run event: `work_persisted`
 *      (sha + files), `work_none` (clean, nothing to push), or `work_persist_failed`
 *      (error). Harvest NEVER throws — a harvest failure must not change the run's
 *      terminal status; it is recorded and the run proceeds to terminal.
 *
 * The loop runs IN the sandbox, so git is driven with `child_process` (matching
 * `defaultRunSetupHook` / `installOpenCodePinned` in `hosted-loop.ts`). `exec` is
 * injectable so the whole thing is unit-testable with no real git.
 */

import { spawnSync } from 'child_process'

export interface HarvestExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Injectable git runner. Defaults to a `spawnSync` git in the workspace dir. */
export type HarvestExec = (args: readonly string[]) => HarvestExecResult

export interface HarvestOptions {
  /** Directory of the cloned session-branch workspace (the loop's cwd for git). */
  workspaceDir: string
  runId: string
  /** Commit attribution (AGENT_GIT_IDENTITY from hosted-runtime-assets). */
  author: { name: string; email: string }
  /** Injectable git runner (default: real `git` via child_process). */
  exec?: HarvestExec
  /**
   * Safety gate (review finding #1): the default exec runs REAL `git add/commit/
   * push` in `workspaceDir`. Real harvest must be affirmatively enabled — the loop
   * only enables it inside a genuine hosted sandbox (prebaked marker present). When
   * false AND no `exec` is injected, harvest is a no-op (`work_none`) so an errant
   * workspaceDir (a test, a dev run) can never commit/push a host repo. An injected
   * `exec` always wins (tests that DO drive harvest).
   */
  enabled?: boolean
}

export type HarvestOutcome =
  | { kind: 'work_persisted'; sha: string; files: string[] }
  | { kind: 'work_none' }
  | { kind: 'work_persist_failed'; error: string }

function defaultHarvestExec(workspaceDir: string): HarvestExec {
  return (args: readonly string[]): HarvestExecResult => {
    const res = spawnSync('git', args as string[], { cwd: workspaceDir, encoding: 'utf8' })
    if (res.error) {
      return { exitCode: 1, stdout: '', stderr: res.error.message }
    }
    return { exitCode: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
  }
}

function detail(res: HarvestExecResult): string {
  const text = (res.stderr && res.stderr.trim()) || (res.stdout && res.stdout.trim()) || `exit ${res.exitCode}`
  return text
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/**
 * Count commits present locally but not on the upstream tracking branch. Returns
 * 0 when there is no upstream (`@{u}` unresolvable) — with no upstream a push
 * could not land anyway, so "nothing to push" is the safe reading.
 */
function countUnpushed(exec: HarvestExec): number {
  const res = exec(['rev-list', '--count', '@{u}..HEAD'])
  if (res.exitCode !== 0) return 0
  const n = Number.parseInt(res.stdout.trim(), 10)
  return Number.isFinite(n) ? n : 0
}

/**
 * Persist any uncommitted or unpushed work in the workspace. Deterministic and
 * total: every path returns a `HarvestOutcome`, never throws.
 */
export function harvestWorkspace(opts: HarvestOptions): HarvestOutcome {
  // Safety gate: never touch a real repo unless explicitly enabled or given an
  // injected exec. Absent both, report nothing-to-do rather than run host git.
  if (!opts.exec && !opts.enabled) {
    return { kind: 'work_none' }
  }
  const exec = opts.exec ?? defaultHarvestExec(opts.workspaceDir)
  try {
    // Never harvest bootstrap-injected runtime scaffolding (ALI-1051): the
    // .claude/skills symlink is a sandbox-local pointer, not the agent's work.
    // Bootstrap also excludes it via .git/info/exclude; this pathspec is the
    // belt-and-braces for any sandbox where that didn't run.
    const excludeScaffold = [':(exclude).claude/skills/**', ':(exclude).claude/skills']
    const status = exec(['status', '--porcelain', '--', '.', ...excludeScaffold])
    if (status.exitCode !== 0) {
      return { kind: 'work_persist_failed', error: `git status failed: ${detail(status)}` }
    }
    const dirty = status.stdout.trim().length > 0

    if (dirty) {
      const add = exec(['add', '-A', '--', '.', ...excludeScaffold])
      if (add.exitCode !== 0) {
        return { kind: 'work_persist_failed', error: `git add failed: ${detail(add)}` }
      }
      const commit = exec([
        '-c',
        `user.name=${opts.author.name}`,
        '-c',
        `user.email=${opts.author.email}`,
        'commit',
        '--author',
        `${opts.author.name} <${opts.author.email}>`,
        '-m',
        `checkpoint: run ${opts.runId} auto-harvest`,
      ])
      if (commit.exitCode !== 0) {
        return { kind: 'work_persist_failed', error: `git commit failed: ${detail(commit)}` }
      }
    }

    // Nothing to push when the tree was clean AND there are no local-only commits.
    const unpushed = countUnpushed(exec)
    if (!dirty && unpushed <= 0) {
      return { kind: 'work_none' }
    }

    const headRes = exec(['rev-parse', 'HEAD'])
    const sha = headRes.exitCode === 0 ? headRes.stdout.trim() : ''

    // Files: the checkpoint commit's tree when we just committed, else everything
    // spanned by the unpushed commits.
    const filesRes = dirty
      ? exec(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])
      : exec(['diff', '--name-only', '@{u}..HEAD'])
    const files = filesRes.exitCode === 0 ? splitLines(filesRes.stdout) : []

    const push = exec(['push'])
    if (push.exitCode !== 0) {
      return { kind: 'work_persist_failed', error: `git push failed: ${detail(push)}` }
    }

    return { kind: 'work_persisted', sha, files }
  } catch (error) {
    return { kind: 'work_persist_failed', error: error instanceof Error ? error.message : String(error) }
  }
}
