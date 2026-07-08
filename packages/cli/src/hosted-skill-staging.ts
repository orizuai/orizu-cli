/**
 * Shared orizu-cli skill staging (ALI-1044 / ALI-1059).
 *
 * BOTH hosted boot paths must stage the vendored `orizu-cli` skill into the
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
 *   (2) `orizu skills path`      — the packaged vendor/skills/orizu-cli of the
 *       globally-installed CLI (the production path),
 *   (3) `$(npm root -g)/orizu/vendor/skills/orizu-cli` — belt fallback.
 * Then SYMLINK it under `<workspaceDir>/.claude/skills/orizu-cli`, falling back to
 * a copy if the symlink cannot be created. Resolved paths stay in shell vars
 * (never interpolated), so they cannot inject into the command.
 *
 * HARVEST-SAFE (ALI-1051): the script appends `/.claude/skills/` to the repo-LOCAL
 * `.git/info/exclude` so auto-harvest's `git add -A` cannot sweep the staged
 * symlink into the session branch (hosted-harvest.ts also excludes it by pathspec,
 * belt-and-braces).
 */

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
   * `<workspaceDir>/.claude/skills/orizu-cli`.
   */
  workspaceDir: string
  exec: SkillStageExec
}

export interface StageOrizuSkillResult {
  ok: boolean
  method: 'symlink' | 'copy' | null
  /** `<workspaceDir>/.claude/skills/orizu-cli`. */
  dest: string
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

/** The exact staging script — exported for tests that assert its shape. */
export function renderStageOrizuSkillScript(workspaceDir: string): string {
  const skillsDir = `${workspaceDir}/.claude/skills`
  return [
    `mkdir -p ${skillsDir}`,
    // The staged skill is bootstrap-injected RUNTIME scaffolding (a symlink to the
    // sandbox-local CLI vendor dir), NOT the agent's work. Exclude it repo-LOCALLY
    // (.git/info/exclude — invisible to the diff, never committed) so auto-harvest's
    // `git add -A` can't sweep it into the session branch and (ALI-1051) auto-apply
    // a broken symlink to the customer's main. IDEMPOTENT (ALI-1060 resume/retry):
    // only append when the line is absent, so a re-invocation never duplicates it.
    `if [ -d ${workspaceDir}/.git ] && ! grep -qxF '/.claude/skills/' ${workspaceDir}/.git/info/exclude 2>/dev/null; then printf '%s\\n' '/.claude/skills/' >> ${workspaceDir}/.git/info/exclude; fi`,
    `src="${'${ORIZU_SKILL_SOURCE_DIR:-}'}"`,
    `if [ -z "$src" ] || [ ! -d "$src" ]; then src="$(orizu skills path 2>/dev/null || true)"; fi`,
    `if [ -z "$src" ] || [ ! -d "$src" ]; then r="$(npm root -g 2>/dev/null || true)"; if [ -n "$r" ] && [ -d "$r/orizu/vendor/skills/orizu-cli" ]; then src="$r/orizu/vendor/skills/orizu-cli"; fi; fi`,
    `if [ -z "$src" ] || [ ! -d "$src" ]; then echo "NO_SOURCE"; exit 0; fi`,
    `dest="${skillsDir}/orizu-cli"`,
    `rm -rf "$dest"`,
    `if ln -s "$src" "$dest" 2>/dev/null; then echo "SYMLINK $src"; else cp -R "$src" "$dest" && echo "COPY $src"; fi`,
  ].join('\n')
}

/**
 * Stage the orizu-cli skill into `<workspaceDir>/.claude/skills/orizu-cli`.
 * Non-throwing (except via the injected exec): resolves to a structured result
 * both callers record their own way. A malformed `workspaceDir` returns a non-ok
 * result rather than throwing, so staging stays non-fatal to the boot.
 *
 * TRUSTED-DIR CONTRACT: `workspaceDir` must be a trusted, internally-constructed
 * non-traversal directory. The shell-safety guard blocks injection metacharacters
 * but deliberately does not reject `..` or a leading `-` — do not pass untrusted
 * input here. Idempotent: safe to re-invoke (e.g. ALI-1060 resume/retry) — the
 * `.git/info/exclude` line is appended only when absent.
 */
export async function stageOrizuSkill(opts: StageOrizuSkillOptions): Promise<StageOrizuSkillResult> {
  const dest = `${opts.workspaceDir}/.claude/skills/orizu-cli`
  if (!SAFE_WORKSPACE_DIR.test(opts.workspaceDir)) {
    return {
      ok: false,
      method: null,
      dest,
      exitCode: 1,
      stdout: '',
      stderr: `unsafe workspaceDir — refusing to interpolate into a shell command: ${opts.workspaceDir}`,
    }
  }
  const result = await opts.exec(renderStageOrizuSkillScript(opts.workspaceDir))
  const out = result.stdout.trim()
  const method: 'symlink' | 'copy' | null = out.startsWith('SYMLINK')
    ? 'symlink'
    : out.startsWith('COPY')
      ? 'copy'
      : null
  const ok = result.exitCode === 0 && method !== null
  return { ok, method, dest, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
}
