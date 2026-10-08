/**
 * The Orizu skill links a hosted session stages into the workspace (ORI-2521)
 * and the one step that keeps them out of every save (ORI-2442).
 *
 * Boot links the CLI's own copy of the skill into each folder an agent reads
 * skills from (measured 2026-10-06: Claude Code reads `.claude/skills`;
 * opencode reads `.claude/skills` and `.agents/skills`; pi reads
 * `.agents/skills`). The links point at a sandbox-local path, so a commit that
 * holds one ships a dangling link to the team.
 *
 * A skills folder can itself be a link (a repo may point `.claude/skills` at
 * `.codex/skills`), so the staged link may land somewhere other than the path
 * boot asked for. Staging therefore writes the repo-relative path where each
 * link really landed to `<git dir>/orizu/staged-skill-links`, and the save
 * steps read that file instead of working the paths out again.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/** Folders the skill is linked into, in staging order. */
export const ORIZU_SKILL_LINK_FOLDERS = ['.claude/skills', '.agents/skills'] as const

/** Under the git dir; never part of the work tree, so never committed. */
export const STAGED_SKILL_LINKS_FILE = 'orizu/staged-skill-links'

interface SkillLinkGitResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Runs git in the workspace. Auto-save and `session finish --push` adapt their own runners. */
export type SkillLinkGit = (args: readonly string[]) => SkillLinkGitResult

export type UnstageSkillLinksResult =
  | { ok: true; unstaged: string[] }
  | { ok: false; error: string }

// Every place the staging script finds the skill ends in this folder: the
// canonical /opt/orizu/cli copy, `orizu skills path`, and the global npm package.
const VENDORED_SKILL_SUFFIX = '/vendor/skills/orizu'

function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.split('/').includes('..')
}

function readRecordedLinks(git: SkillLinkGit): string[] {
  const gitDir = git(['rev-parse', '--absolute-git-dir'])
  const dir = gitDir.stdout.trim()
  if (gitDir.exitCode !== 0 || !dir.startsWith('/')) return []
  const file = join(dir, STAGED_SKILL_LINKS_FILE)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').map(line => line.trim()).filter(isSafeRelativePath)
}

const DEFAULT_LINK_PATHS: readonly string[] = ORIZU_SKILL_LINK_FOLDERS.map(folder => `${folder}/orizu`)

/**
 * Staged links that are ours. Staging always links to an absolute path, so a
 * staged link counts when it points somewhere absolute and either sits at a
 * recorded path or is newly added at a default path, or when it points at a
 * vendored Orizu skill. A person's own relative link, or a real skill folder
 * put where a staged link was, is never taken out.
 */
function stagedOrizuSkillLinks(git: SkillLinkGit, recorded: ReadonlySet<string>): string[] | { error: string } {
  const diff = git(['diff', '--cached', '--raw', '-z', '--no-renames'])
  if (diff.exitCode !== 0) return { error: `git diff --cached failed: ${diff.stderr.trim() || `exit ${diff.exitCode}`}` }
  const fields = diff.stdout.split('\0')
  const found: string[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, newMode, , newSha, change] = fields[i].split(' ')
    const path = fields[i + 1]
    if (newMode !== '120000' || !newSha) continue
    const target = git(['cat-file', '-p', newSha]).stdout
    if (!target.startsWith('/')) continue
    const isVendored = target.replace(/\/+$/u, '').endsWith(VENDORED_SKILL_SUFFIX)
    if (isVendored || recorded.has(path) || (change === 'A' && DEFAULT_LINK_PATHS.includes(path))) found.push(path)
  }
  return found
}

/**
 * Run after `git add`: unstage every staged Orizu skill link so the commit
 * holds the agent's work only. `reset` puts each path back to its committed
 * state, so a team's own tracked files are never deleted.
 */
export function unstageOrizuSkillLinks(git: SkillLinkGit): UnstageSkillLinksResult {
  const paths = stagedOrizuSkillLinks(git, new Set(readRecordedLinks(git)))
  if ('error' in paths) return { ok: false, error: paths.error }
  if (paths.length === 0) return { ok: true, unstaged: [] }
  // Literal pathspecs: a link's name must never act as a pattern.
  const reset = git(['--literal-pathspecs', 'reset', '-q', '--', ...paths])
  if (reset.exitCode !== 0) {
    return { ok: false, error: `git reset of the Orizu skill links failed: ${reset.stderr.trim() || `exit ${reset.exitCode}`}` }
  }
  return { ok: true, unstaged: paths }
}

/** True when the index holds changes to commit. NUL-separated, so no filename is trimmed away. */
export function hasStagedChanges(git: SkillLinkGit): boolean | { error: string } {
  const staged = git(['diff', '--cached', '--name-only', '-z'])
  if (staged.exitCode !== 0) return { error: `git diff --cached failed: ${staged.stderr.trim() || `exit ${staged.exitCode}`}` }
  return staged.stdout.length > 0
}

/** Shown when `git status` is dirty but `git add` staged nothing, e.g. work inside a submodule. */
export const NOTHING_STAGED_ERROR = 'git status shows changes, but nothing could be staged (for example, work inside a submodule)'
