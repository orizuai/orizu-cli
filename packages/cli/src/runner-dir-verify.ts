import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, isAbsolute, join, normalize } from 'path'

import {
  archiveArtifactEntries,
  expandHomePath,
  readArtifactEntries,
  shouldExcludeArtifactPath,
} from './artifact-archive.js'
import { authedFetch } from './http.js'

/**
 * ALI-1159 (ADR-007): ad-hoc `--runner-dir` bytes may only execute when they
 * ARE a registered runner version. Runs that execute local runner bytes stamp
 * a registered `runner_version_id` into every result record; before this
 * guard, nothing tied those bytes to that version — a run could produce live
 * Orizu records from runner bytes that were never registered or committed
 * anywhere (the GEPA-adapter loss on orizu-workbench-demo). The check is the
 * same deterministic-zip content sha the push paths record: identical
 * directory bytes hash to the registered version's `content_sha256`.
 *
 * Lives outside index.ts per the CLI line ratchet (ALI-976).
 */

/** Test seam; defaults to the authenticated CLI fetcher. */
export interface VerifyRunnerDirInput {
  runnerVersionId: string
  dir: string
  /** The CLI flag the dir arrived on (for the error message). */
  flag: string
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>
}

/**
 * The deterministic zip EXCLUDES two kinds of entries the runtime can still
 * reach, so a hash-matching dir could execute unregistered inputs while its
 * records claim the registered version:
 *   - `.env`/`.env.*` files (secrets must never ship — runners get
 *     configuration at exec time);
 *   - SYMLINKS — collectArtifactFiles keeps only real files
 *     (`Dirent.isFile()`), so `runner.js -> /tmp/unregistered.js` is absent
 *     from the hash while execution follows it; a materialized registered
 *     version would not contain the link at all (codex round 3 on #1447).
 *     The refusal happens before spawn, so there is no hash-then-swap
 *     TOCTOU window to reason about.
 * Both are refused outright. The remaining exclusions (.git, __pycache__,
 * .DS_Store, .pytest_cache, .orizu) are caches/metadata a runner has no
 * business reading and stay ignorable (their subtrees are not scanned).
 */
interface RunnerDirScan {
  envFiles: string[]
  symlinks: string[]
}

function scanRunnerDir(dir: string, relativeDir = ''): RunnerDirScan {
  const absoluteDir = relativeDir ? join(dir, relativeDir) : dir
  const result: RunnerDirScan = { envFiles: [], symlinks: [] }
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) {
      result.symlinks.push(relativePath)
      continue
    }
    if (entry.isFile()) {
      if (entry.name === '.env' || entry.name.startsWith('.env.')) {
        result.envFiles.push(relativePath)
      }
      continue
    }
    if (entry.isDirectory() && !shouldExcludeArtifactPath(relativePath)) {
      const nested = scanRunnerDir(dir, relativePath)
      result.envFiles.push(...nested.envFiles)
      result.symlinks.push(...nested.symlinks)
    }
  }
  return result
}

export interface VerifiedRunnerSnapshot {
  /**
   * Temp directory holding EXACTLY the verified file set, materialized from
   * the same in-memory bytes the hash covered (codex round 4 on #1447):
   * execution from here is immune to post-hash mutation of the original dir,
   * and hash-excluded entries (.env, .git, .orizu, caches, symlinks) simply
   * do not exist at runtime.
   */
  snapshotDir: string
  cleanup: () => void
}

export async function verifyRunnerDirRegistered(input: VerifyRunnerDirInput): Promise<VerifiedRunnerSnapshot> {
  const fetcher = input.fetcher ?? authedFetch
  // Resolve the SAME path the archive hash and the runner execution resolve
  // (codex round 3: the literal `~/...` was scanned and ENOENT'd).
  const dir = expandHomePath(input.dir)

  const { envFiles, symlinks } = scanRunnerDir(dir)
  if (symlinks.length > 0) {
    throw new Error(
      `Runner directory ${dir} contains symlinks (${symlinks.join(', ')}) — symlinks are excluded ` +
      'from the registered content hash but execution would follow them, so the run could execute ' +
      'unregistered bytes under a registered runner_version_id (ADR-007). Replace them with real ' +
      'files (a materialized registered version contains no symlinks).'
    )
  }
  if (envFiles.length > 0) {
    throw new Error(
      `Runner directory ${dir} contains env files (${envFiles.join(', ')}) that are excluded ` +
      'from the registered content hash but would be read at runtime — the run would execute ' +
      'unregistered inputs under a registered runner_version_id (ADR-007). Remove them and pass ' +
      'configuration at exec time instead.'
    )
  }

  // Read the entry set ONCE: these exact bytes are hashed AND (on success)
  // materialized as the execution snapshot, so verify-vs-execute cannot
  // diverge.
  const entries = readArtifactEntries(dir)
  const { contentSha256: localSha } = archiveArtifactEntries(entries)

  const response = await fetcher(`/api/cli/runner-versions/${encodeURIComponent(input.runnerVersionId)}`)
  if (response.status === 404) {
    throw new Error(
      `Runner version ${input.runnerVersionId} is not registered (or is not visible to you), ` +
      `so ${input.flag} bytes cannot be attributed to it. Register the directory first with ` +
      '`orizu runners push` and re-run against the returned version id.'
    )
  }
  if (!response.ok) {
    // Bounded echo: an HTML error page or proxy body should not flood the
    // terminal (claude-review on #1447).
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`Failed to fetch runner version ${input.runnerVersionId} (HTTP ${response.status}): ${detail}`)
  }

  const data = await response.json() as { contentSha256?: string | null }
  const registeredSha = typeof data.contentSha256 === 'string' ? data.contentSha256 : null
  if (!registeredSha) {
    throw new Error(
      `Runner version ${input.runnerVersionId} has no recorded content sha, so ${input.flag} bytes ` +
      'cannot be verified against it. Drop the flag to execute the registered bytes.'
    )
  }

  if (registeredSha.toLowerCase() !== localSha.toLowerCase()) {
    throw new Error(
      `Local runner bytes at ${dir} are not registered runner version ${input.runnerVersionId} ` +
      `(content sha ${localSha} != ${registeredSha}). Runs may only execute registered runner bytes ` +
      '(ADR-007): register the directory first with `orizu runners push` ' +
      '(use --session <session-id> inside a workspace session) and re-run against the new version, ' +
      `or drop ${input.flag} to execute the registered bytes.`
    )
  }

  const snapshotDir = mkdtempSync(join(tmpdir(), 'orizu-verified-runner-'))
  try {
    for (const entry of entries) {
      const target = join(snapshotDir, entry.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, entry.data)
      if (entry.mode !== undefined) {
        // chmod (not writeFileSync's mode option, which the umask masks):
        // an executable `./run.sh` runner must keep its +x in the snapshot
        // (codex round 7). The mode is NOT part of the content hash.
        chmodSync(target, entry.mode & 0o777)
      }
    }
    // Codex round-6 P1: an absolute or `..`-escaping command entry in the
    // (verified) manifest would execute bytes OUTSIDE the snapshot — the
    // registered hash covers the manifest text, not what an out-of-snapshot
    // path resolves to at spawn time. Validate against the snapshot's own
    // manifest bytes before anything can execute.
    assertSnapshotManifestConfined(snapshotDir, input.flag)
  } catch (error) {
    rmSync(snapshotDir, { recursive: true, force: true })
    throw error
  }

  return {
    snapshotDir,
    cleanup: () => rmSync(snapshotDir, { recursive: true, force: true }),
  }
}

/**
 * Known loader/preload-style interpreter options that make their NEXT argv
 * token executable (codex round 7 / claude-review on #1447). A DENYLIST
 * heuristic by nature — option-space is open-ended — kept for targeted
 * diagnostics on the separated form; the generic per-token/per-segment
 * confinement checks are what actually hold the line.
 */
const LOADER_STYLE_OPTIONS = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader',
  '--experimental-preload', '-X', '-m', '--preload',
])

/**
 * The runner contract executes `manifest.json`'s `command` with cwd at the
 * artifact root. Every command entry must stay INSIDE the snapshot: absolute
 * entries and `..` escapes are refused (a bare program name like `node` is
 * PATH-resolved — interpreters are environment, not artifact bytes). Missing
 * or malformed manifests are refused here too, so no snapshot can outlive a
 * runner that could never execute.
 */
function assertSnapshotManifestConfined(snapshotDir: string, flag: string): void {
  const manifestPath = join(snapshotDir, 'manifest.json')
  let raw: string
  try {
    raw = readFileSync(manifestPath, 'utf8')
  } catch {
    throw new Error(`Verified runner bytes for ${flag} do not contain a manifest.json at the artifact root.`)
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(raw)
  } catch {
    throw new Error(`Verified runner manifest.json for ${flag} is not valid JSON.`)
  }
  const command = (manifest as { command?: unknown } | null)?.command
  if (!Array.isArray(command)) {
    return
  }
  for (let index = 0; index < command.length; index += 1) {
    const entry = command[index]
    if (typeof entry !== 'string') {
      continue
    }
    // DENYLIST HEURISTIC (documented as such — interpreter option-space is
    // open-ended, so this cannot be exhaustive; the PRIMARY defense is the
    // snapshot + relative-command posture, this is diagnostics-grade depth):
    // a known loader-style option whose SEPARATED next token is absolute or
    // escaping gets a targeted refusal naming the option. The generic
    // whole-token check below refuses the same next token anyway.
    if (LOADER_STYLE_OPTIONS.has(entry)) {
      const next = command[index + 1]
      if (typeof next === 'string' && (isAbsolute(next) || normalize(next).startsWith('..'))) {
        throw new Error(
          `Runner manifest loader option ${JSON.stringify(entry)} points at ${JSON.stringify(next)} — an ` +
          'absolute or snapshot-escaping path would load bytes outside the verified snapshot (ADR-007). ' +
          'Use snapshot-relative paths in manifest.json.'
        )
      }
    }
    // Check the whole token AND every option-attached value segment (codex
    // round 7: `--require=/tmp/evil.js` passed the whole-token check while
    // node still loaded the external file). Splitting on `=` covers the
    // option form; `,`/`:` cover common list-valued options. Over-rejecting
    // an exotic-but-legit value is the safe side — runners receive
    // configuration at exec time, not baked into command argv.
    const pieces = [entry, ...entry.split(/[=,:]/)]
    for (const piece of pieces) {
      if (!piece) {
        continue
      }
      if (isAbsolute(piece)) {
        throw new Error(
          `Runner manifest command entry ${JSON.stringify(entry)} carries an absolute path — it would ` +
          'execute or load bytes outside the verified snapshot (ADR-007). Use PATH-resolved program ' +
          'names and snapshot-relative paths in manifest.json.'
        )
      }
      const normalized = normalize(piece)
      if (normalized === '..' || normalized.startsWith(`..${'/'}`) || normalized.startsWith('..\\')) {
        throw new Error(
          `Runner manifest command entry ${JSON.stringify(entry)} escapes the verified snapshot via '..' ` +
          '(ADR-007). Use snapshot-relative paths in manifest.json.'
        )
      }
    }
  }
}

/** The run-gepa (version-id, runner-dir) flag pairs the wrapper must verify. */
const GEPA_RUNNER_FLAG_PAIRS = [
  { versionFlag: '--runner-version-id', dirFlag: '--candidate-runner-dir' },
  { versionFlag: '--scorer-runner-version-id', dirFlag: '--scorer-runner-dir' },
] as const

function flagOccurrences(args: string[], flag: string): number {
  return args.filter(arg => arg === flag || arg.startsWith(`${flag}=`)).length
}

/** Extract a flag value accepting BOTH argparse forms: `--flag value` and
 * `--flag=value` (codex P1 on #1447 — the equals form bypassed `getArg`). */
export function extractFlagValue(args: string[], flag: string): string | null {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const value = args[index + 1]
      return typeof value === 'string' && value.trim() ? value : null
    }
    if (args[index].startsWith(`${flag}=`)) {
      const value = args[index].slice(flag.length + 1)
      return value.trim() ? value : null
    }
  }
  return null
}

/**
/** Replace the single occurrence of a dir flag's VALUE (either argparse form)
 * with the verified snapshot path. Duplicates were refused before this runs. */
function rewriteFlagValue(args: string[], flag: string, newValue: string): string[] {
  const rewritten = [...args]
  for (let index = 0; index < rewritten.length; index += 1) {
    if (rewritten[index] === flag) {
      rewritten[index + 1] = newValue
      return rewritten
    }
    if (rewritten[index].startsWith(`${flag}=`)) {
      rewritten[index] = `${flag}=${newValue}`
      return rewritten
    }
  }
  return rewritten
}

export interface GepaVerifiedArgs {
  /** The forwarded argv with each runner-dir flag REWRITTEN to its verified
   * snapshot path — Python executes the hashed bytes, not the mutable dir. */
  args: string[]
  /** The snapshot dirs, for the ORIZU_VERIFIED_RUNNER_DIRS handshake. */
  verifiedDirs: string[]
  cleanup: () => void
}

/**
 * Verify the run-gepa wrapper's two ad-hoc runner dirs (candidate + scorer)
 * against the FORWARDED argv before the Python optimizer is spawned —
 * scanning the same tokens Python will parse, in both argparse forms, so no
 * spelling of the flags can slip past verification. FAIL-CLOSED: if either
 * half of a pair is present but the pair is incomplete, the wrapper refuses
 * here rather than forwarding an unverified pair to argparse. A pair that is
 * entirely absent is left to the Python CLI's required-argument validation —
 * it cannot execute without both. On success each dir flag is REWRITTEN to
 * the verified snapshot (codex round 4): the optimizer runs the exact hashed
 * bytes, immune to post-hash mutation of the original dirs.
 */
export async function verifyGepaRunnerDirsFromArgs(
  args: string[],
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>
): Promise<GepaVerifiedArgs> {
  let rewritten = [...args]
  const verifiedDirs: string[] = []
  const cleanups: Array<() => void> = []
  const cleanup = () => {
    for (const dispose of cleanups) dispose()
  }

  try {
    for (const pair of GEPA_RUNNER_FLAG_PAIRS) {
      // Duplicate flags are refused outright (codex round 3, P1): argparse
      // honors the LAST occurrence, so verifying any single occurrence can
      // diverge from what Python executes. Refusing beats replicating argparse
      // resolution — duplicates have no legitimate use here, and last-wins is
      // exactly the shape an override attack takes.
      for (const flag of [pair.dirFlag, pair.versionFlag]) {
        if (flagOccurrences(args, flag) > 1) {
          throw new Error(
            `Duplicate ${flag}: pass each runner flag exactly once — the Python optimizer honors the ` +
            'last occurrence, which could execute a different runner dir than the one verified (ADR-007).'
          )
        }
      }
      const anyPresent = flagOccurrences(args, pair.dirFlag) > 0 || flagOccurrences(args, pair.versionFlag) > 0
      if (!anyPresent) {
        continue
      }
      const dir = extractFlagValue(args, pair.dirFlag)
      const runnerVersionId = extractFlagValue(args, pair.versionFlag)
      if (!dir || !runnerVersionId) {
        throw new Error(
          `${pair.dirFlag} and ${pair.versionFlag} must both be provided so the runner bytes can be ` +
          'verified against the registered version (ADR-007) — refusing to launch with an unverified runner dir.'
        )
      }
      const verified = await verifyRunnerDirRegistered({
        runnerVersionId,
        dir,
        flag: pair.dirFlag,
        fetcher,
      })
      cleanups.push(verified.cleanup)
      verifiedDirs.push(verified.snapshotDir)
      rewritten = rewriteFlagValue(rewritten, pair.dirFlag, verified.snapshotDir)
    }
  } catch (error) {
    cleanup()
    throw error
  }

  return { args: rewritten, verifiedDirs, cleanup }
}
