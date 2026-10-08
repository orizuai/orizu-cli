/**
 * Shared orizu skill staging (ALI-1044 / ALI-1059).
 *
 * BOTH hosted boot paths must stage the vendored `orizu` skill into the
 * cloned workspace so the agent discovers the Orizu workflows: the OPERATOR path
 * (hosted-bootstrap.ts) and the DO path (hosted-boot.ts). Before ALI-1059 only the
 * operator path did — the DO path (the default; `--operator` is deprecated) booted
 * an authenticated CLI that never found the skill. This module is the ONE
 * implementation of the resolution chain and the `.git/info/exclude` append; each
 * path adapts its own exec seam and records the outcome its own way (a run-event
 * sink vs. a boot log).
 *
 * Resolution chain (unchanged from the original operator-path block), preferring:
 *   (1) $ORIZU_SKILL_SOURCE_DIR  — explicit override (also honored by the CLI's
 *       skill-installer; the local-sim rehearsal sets it),
 *   (2) `orizu skills path`      — the packaged vendor/skills/orizu of the
 *       globally-installed CLI (the production path),
 *   (3) `/opt/orizu/cli/vendor/skills/orizu` — the canonical copy the
 *       published-package bake installs (ORI-2375: in a prebaked sandbox the
 *       sandbox user's npm prefix never holds the sudo-installed package),
 *   (4) `$(npm root -g)/orizu/vendor/skills/orizu` — for the non-prebaked
 *       bootstrap, which installs orizu globally and has no /opt/orizu/cli.
 * Then SYMLINK it into each folder in ORIZU_SKILL_LINK_FOLDERS (ORI-2521:
 * `.claude/skills/orizu` for Claude Code and opencode, `.agents/skills/orizu`
 * for opencode, pi and Codex), falling back to a copy if a symlink cannot be
 * created. Resolved paths stay in shell vars (never interpolated), so they
 * cannot inject into the command.
 *
 * SAVE-SAFE (ALI-1051, ORI-2442): a skills folder may itself be a link, so the
 * script resolves each folder's real location first. It appends the exact
 * repo-relative path of each staged link to the repo-LOCAL `.git/info/exclude`
 * (so the agent's own `git add -A` skips it) and records it in
 * `.git/orizu/staged-skill-links`, which auto-save and `session finish --push`
 * read to unstage the links (orizu-skill-links.ts).
 */

import { ORIZU_SKILL_LINK_FOLDERS, STAGED_SKILL_LINKS_FILE } from './orizu-skill-links.js'

export interface SkillStageExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Runs a POSIX shell command string, returning its exit code + captured output.
 * The operator path adapts `SandboxSession.exec`; the DO path adapts its
 * `BootExec` via `sh -c`. Kept as an injected seam so both callers — and tests —
 * share one script and one output parser.
 */
export type SkillStageExec = (command: string) => Promise<SkillStageExecResult>

export interface StageOrizuSkillOptions {
  /**
   * Directory the session branch is cloned into (ABSOLUTE on the DO path,
   * sandbox-root RELATIVE on the operator path). The skill is staged under
   * each of ORIZU_SKILL_LINK_FOLDERS.
   */
  workspaceDir: string
  exec: SkillStageExec
}

type SkillLinkStageMethod = 'symlink' | 'copy' | 'preserved' | 'same_folder'

interface StagedSkillLink {
  /** The link's real path, after resolving a linked skills folder. */
  dest: string
  method: SkillLinkStageMethod | null
}

export interface StageOrizuSkillResult {
  /** Every folder was staged, preserved, or is the same real folder as an earlier one. */
  ok: boolean
  /** The `.claude/skills` link's method; kept for the boot logs. */
  method: SkillLinkStageMethod | null
  /** `<workspaceDir>/.claude/skills/orizu`. */
  dest: string
  links: StagedSkillLink[]
  exitCode: number
  stdout: string
  stderr: string
}

// `workspaceDir` is interpolated into a shell command, so refuse anything a shell
// could treat specially — the same allow-list hosted-bootstrap.ts asserts up front.
// NOTE: this admits `..` traversal and a leading `-`; it is a shell-injection guard,
// NOT a path-authorization check. Callers MUST pass a trusted, internally-constructed
// non-traversal directory (both do: `<root>/repo` on the DO path, `repo` on the
// operator path) — never an untrusted or user-supplied value.
const SAFE_WORKSPACE_DIR = /^[A-Za-z0-9._/:@-]+$/

const CANONICAL_SKILL_DIR = '/opt/orizu/cli/vendor/skills/orizu'

const STATUS_METHODS: Record<string, SkillLinkStageMethod> = {
  SYMLINK: 'symlink',
  COPY: 'copy',
  PRESERVED_TRACKED: 'preserved',
  SAME_FOLDER: 'same_folder',
}

/** The exact staging script — exported for tests that assert its shape and run it
 *  (`canonicalSkillDir` lets a test lay the canonical copy out under a temp root).
 *
 *  For each folder in ORIZU_SKILL_LINK_FOLDERS it prints one line:
 *    SYMLINK <dest> <src> | COPY <dest> <src>   — staged
 *    PRESERVED_TRACKED <dest>                  — the team tracks a valid skill there; left alone
 *    PRESERVED_INVALID <dest>                  — the team tracks something there without SKILL.md
 *    SAME_FOLDER <dest>                        — this folder is the same real folder as an earlier one
 *    UNRESOLVED <dest>                         — the folder could not be created
 *    OUTSIDE_REPO <dest>                       — the folder is a link out of the repo; skipped
 *    INSIDE_GIT_DIR <dest>                     — the folder is a link into the git directory; skipped
 *  or a single NO_SOURCE when no copy of the skill was found. */
export function renderStageOrizuSkillScript(workspaceDir: string, canonicalSkillDir = CANONICAL_SKILL_DIR): string {
  return [
    `ws='${workspaceDir}'`,
    `mkdir -p "$ws"`,
    `root="$(cd "$ws" && pwd -P)" || exit 1`,
    // Paths live in the git dir, never in the work tree. Both files are
    // repo-local: `.git/info/exclude` hides each link from the agent's own
    // `git add -A`, and the staged-links list tells the save steps where each
    // link really landed (ORI-2442).
    `gitdir="$(git -C "$ws" rev-parse --absolute-git-dir 2>/dev/null || true)"`,
    `gitdir_p=''`,
    `if [ -n "$gitdir" ]; then mkdir -p "$gitdir/info" "$(dirname "$gitdir/${STAGED_SKILL_LINKS_FILE}")"; gitdir_p="$(cd "$gitdir" && pwd -P)"; fi`,
    // Sessions staged by an older CLI ignore the whole folder, which hides a
    // team's new skills from saves; this script ignores exact link paths instead.
    `if [ -n "$gitdir" ] && grep -qxF '/.claude/skills/' "$gitdir/info/exclude" 2>/dev/null; then grep -vxF '/.claude/skills/' "$gitdir/info/exclude" > "$gitdir/info/exclude.orizu-tmp"; mv "$gitdir/info/exclude.orizu-tmp" "$gitdir/info/exclude"; fi`,
    `src="${'${ORIZU_SKILL_SOURCE_DIR:-}'}"`,
    `if [ -z "$src" ] || [ ! -d "$src" ]; then src="$(orizu skills path 2>/dev/null || true)"; fi`,
    `if [ -z "$src" ] || [ ! -d "$src" ]; then src='${canonicalSkillDir}'; fi`,
    `if [ -z "$src" ] || [ ! -d "$src" ]; then r="$(npm root -g 2>/dev/null || true)"; if [ -n "$r" ] && [ -d "$r/orizu/vendor/skills/orizu" ]; then src="$r/orizu/vendor/skills/orizu"; fi; fi`,
    `if [ -z "$src" ] || [ ! -d "$src" ]; then src=''; fi`,
    `seen=' '`,
    `nosource=''`,
    `stage_one() {`,
    `  mkdir -p "$ws/$1" 2>/dev/null`,
    // Resolve the folder's REAL location: when it is itself a link, the skill
    // link lands at the link's target (ORI-2442).
    `  phys="$(cd "$ws/$1" 2>/dev/null && pwd -P)" || { echo "UNRESOLVED $ws/$1/orizu"; return; }`,
    `  dest="$phys/orizu"`,
    `  case "$seen" in *" $phys "*) echo "SAME_FOLDER $dest"; return;; esac`,
    `  seen="$seen$phys "`,
    // Never write outside the repo: a folder linked elsewhere is skipped, so
    // the `rm -rf` below cannot reach another directory.
    `  case "$phys" in "$root"/*) rel="\${phys#"$root"/}/orizu";; *) echo "OUTSIDE_REPO $dest"; return;; esac`,
    `  if [ -n "$gitdir_p" ]; then case "$phys" in "$gitdir_p"|"$gitdir_p"/*) echo "INSIDE_GIT_DIR $dest"; return;; esac; fi`,
    `  if [ -n "$gitdir" ] && git -C "$ws" ls-files -- "$rel" "$rel/**" | grep -q .; then if [ -f "$dest/SKILL.md" ]; then echo "PRESERVED_TRACKED $dest"; else echo "PRESERVED_INVALID $dest"; fi; return; fi`,
    // IDEMPOTENT (ALI-1060 resume/retry): each line is appended only when absent.
    `  if [ -n "$gitdir" ]; then`,
    // Escape ignore-pattern characters so the line matches this exact path.
    `    pat="/$(printf '%s' "$rel" | sed 's/[][*?\\\\]/\\\\&/g')"`,
    `    grep -qxF "$pat" "$gitdir/info/exclude" 2>/dev/null || printf '%s\\n' "$pat" >> "$gitdir/info/exclude"`,
    `    grep -qxF "$rel" "$gitdir/${STAGED_SKILL_LINKS_FILE}" 2>/dev/null || printf '%s\\n' "$rel" >> "$gitdir/${STAGED_SKILL_LINKS_FILE}"`,
    `  fi`,
    `  if [ -z "$src" ]; then nosource=1; return; fi`,
    `  rm -rf "$dest"`,
    `  if ln -s "$src" "$dest" 2>/dev/null; then echo "SYMLINK $dest $src"; else cp -R "$src" "$dest" && echo "COPY $dest $src"; fi`,
    `}`,
    ...ORIZU_SKILL_LINK_FOLDERS.map(folder => `stage_one '${folder}'`),
    `if [ -n "$nosource" ]; then echo "NO_SOURCE"; fi`,
    `exit 0`,
  ].join('\n')
}

/**
 * Stage the orizu skill into each of ORIZU_SKILL_LINK_FOLDERS under `workspaceDir`.
 * Non-throwing (except via the injected exec): resolves to a structured result
 * both callers record their own way. A malformed `workspaceDir` returns a non-ok
 * result rather than throwing, so staging stays non-fatal to the boot.
 *
 * TRUSTED-DIR CONTRACT: `workspaceDir` must be a trusted, internally-constructed
 * non-traversal directory. The shell-safety guard blocks injection metacharacters
 * but deliberately does not reject `..` or a leading `-` — do not pass untrusted
 * input here. Idempotent: safe to re-invoke (e.g. ALI-1060 resume/retry) — the
 * `.git/info/exclude` and staged-links lines are appended only when absent.
 */
export async function stageOrizuSkill(opts: StageOrizuSkillOptions): Promise<StageOrizuSkillResult> {
  const dest = `${opts.workspaceDir}/.claude/skills/orizu`
  if (!SAFE_WORKSPACE_DIR.test(opts.workspaceDir)) {
    return {
      ok: false,
      method: null,
      dest,
      links: [],
      exitCode: 1,
      stdout: '',
      stderr: `unsafe workspaceDir — refusing to interpolate into a shell command: ${opts.workspaceDir}`,
    }
  }
  const result = await opts.exec(renderStageOrizuSkillScript(opts.workspaceDir))
  const lines = result.stdout.split('\n').map(line => line.trim()).filter(Boolean)
  const links = lines.flatMap((line): StagedSkillLink[] => {
    const [status, linkDest] = line.split(' ')
    if (!linkDest) return []
    const method = STATUS_METHODS[status] ?? null
    return [{ dest: linkDest, method }]
  })
  const ok = result.exitCode === 0
    && !lines.includes('NO_SOURCE')
    && links.length === ORIZU_SKILL_LINK_FOLDERS.length
    && links.every(link => link.method !== null)
  return {
    ok,
    method: links[0]?.method ?? null,
    dest,
    links,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}
