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
 *      commits the agent made but did not push), push the exact HEAD SHA to the
 *      session branch at bootstrap's independently validated repository locator.
 *   4. Return a typed outcome the loop records as a run event: `work_persisted`
 *      (sha + files), `work_none` (clean, nothing to push), `work_not_inspected`
 *      (safety-gated), or `work_persist_failed` (error). Harvest NEVER throws —
 *      a harvest failure must not change the run's terminal status; it is recorded
 *      and the run proceeds to terminal.
 *
 * The loop runs IN the sandbox, so git is driven with `child_process` (matching
 * `defaultRunSetupHook` / `installOpenCodePinned` in `hosted-loop.ts`). `exec` is
 * injectable so the whole thing is unit-testable with no real git; the HTTPS
 * smart-Git boundary tests independently prove the production transport.
 */

import { spawnSync } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  isValidCloudflareArtifactsGitRemote,
  parseCanonicalCredentialFreeHttpsUrl,
} from './cloudflare-artifacts-git-remote.js'

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
  /** Validated session branch that receives the exact checkpoint commit. */
  sessionBranch: string
  /** Credential-free, bootstrap-validated repository locator. */
  repositoryRemote: string
  /** Bootstrap-owned credential helper; never read back from mutable repo config. */
  credentialHelper?: string
  /** Commit attribution (AGENT_GIT_IDENTITY from hosted-runtime-assets). */
  author: { name: string; email: string }
  /** Trusted test seams; production resolves from the measured image/host lists. */
  caBundleCandidates?: readonly string[]
  caPathCandidates?: readonly string[]
  /** Injectable git runner (default: real `git` via child_process). */
  exec?: HarvestExec
  /**
   * Safety gate (review finding #1): the default exec runs REAL `git add/commit/
   * push` in `workspaceDir`. Real harvest must be affirmatively enabled — the loop
   * only enables it inside a genuine hosted sandbox (prebaked marker present). When
   * false AND no `exec` is injected, harvest is a no-op (`work_not_inspected`) so
   * an errant workspaceDir (a test, a dev run) can never commit/push a host repo. An injected
   * `exec` always wins (tests that DO drive harvest).
   */
  enabled?: boolean
}

export type HarvestOutcome =
  | { kind: 'work_persisted'; sha: string; files: string[] | null }
  | { kind: 'work_none' }
  | { kind: 'work_not_inspected' }
  | { kind: 'work_persist_failed'; error: string }

export const HOSTED_HARVEST_CA_BUNDLE_CANDIDATES = [
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/ssl/cert.pem',
] as const

export const HOSTED_HARVEST_CA_PATH_CANDIDATES = [
  '/etc/pki/ca-trust/extracted/pem/directory-hash',
  '/etc/ssl/certs',
] as const

export const HOSTED_HARVEST_TRANSPORT_POLICY = {
  environmentDenylist: [
    'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy',
    'GIT_SSL_NO_VERIFY', 'GIT_PROXY_COMMAND', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH',
    'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSL_CERT', 'GIT_SSL_KEY',
    'GIT_ASKPASS', 'GIT_ASKPASS_REQUIRE', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE',
    'GIT_TERMINAL_PROMPT',
  ],
  exactUrlHttpConfig: [
    ['proxy', ''], ['sslVerify', 'true'], ['curloptResolve', ''],
    ['followRedirects', 'false'],
  ],
  rejectedLocalHttpKeys: [
    'sslcert', 'sslkey', 'sslcertpasswordprotected', 'sslbackend',
    'pinnedpubkey', 'sslversion', 'sslcipherlist',
  ],
} as const

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function resolveHostedHarvestCaBundle(
  candidates: readonly string[] = HOSTED_HARVEST_CA_BUNDLE_CANDIDATES
): string | null {
  return candidates.find(isRegularFile) ?? null
}

function resolveHostedHarvestCaPath(
  candidates: readonly string[] = HOSTED_HARVEST_CA_PATH_CANDIDATES
): string | null {
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isDirectory()) continue
      if (readdirSync(candidate).some(entry => /^[0-9a-f]{8}\.[0-9]+$/u.test(entry))) return candidate
    } catch {
      // A missing or unreadable directory is not a trust source.
    }
  }
  return null
}

function defaultHarvestExec(workspaceDir: string): HarvestExec {
  return (args: readonly string[]): HarvestExecResult => {
    const env = { ...process.env }
    for (const name of Object.keys(env)) {
      if ((HOSTED_HARVEST_TRANSPORT_POLICY.environmentDenylist as readonly string[]).includes(name) ||
        name === 'GIT_CONFIG' || name.startsWith('GIT_CONFIG_')) delete env[name]
    }
    env.GIT_CONFIG_NOSYSTEM = '1'
    env.GIT_CONFIG_GLOBAL = '/dev/null'
    env.GIT_TERMINAL_PROMPT = '0'
    const res = spawnSync('git', [...args], { cwd: workspaceDir, encoding: 'utf8', env })
    if (res.error) {
      return { exitCode: 1, stdout: '', stderr: res.error.message }
    }
    return { exitCode: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
  }
}

function protectPinnedRemote(
  exec: HarvestExec,
  remote: string,
  caBundle: string,
  caPath: string | null,
  credentialHelper?: string
): HarvestExec {
  const httpConfig = HOSTED_HARVEST_TRANSPORT_POLICY.exactUrlHttpConfig.flatMap(
    ([key, value]) => ['-c', `http.${remote}.${key}=${value}`]
  )
  const credentialUsername = new URL(remote).hostname === 'github.com' ? 'x-access-token' : 'x'
  const credentialConfig = credentialHelper ? [
    // An empty helper resets Git's accumulated helper list, including URL-scoped entries.
    '-c', 'credential.helper=',
    '-c', `credential.helper=${credentialHelper}`,
    '-c', 'credential.useHttpPath=true',
    '-c', `credential.${remote}.useHttpPath=true`,
    '-c', `credential.username=${credentialUsername}`,
    '-c', `credential.${remote}.username=${credentialUsername}`,
    '-c', 'credential.interactive=false',
    '-c', 'core.askPass=',
  ] : ['-c', 'credential.helper=']
  return (args) => {
    const alias = `https://orizu-harvest.invalid/${randomUUID()}`
    const temporaryCaPath = caPath ? null : mkdtempSync(join(tmpdir(), 'orizu-harvest-ca-'))
    try {
      return exec([
        '-c', `url.${remote}.insteadOf=${alias}`,
        '-c', `url.${remote}.pushInsteadOf=${alias}`,
        ...httpConfig,
        '-c', `http.${remote}.sslCAInfo=${caBundle}`,
        '-c', `http.${remote}.sslCAPath=${caPath ?? temporaryCaPath}`,
        ...credentialConfig,
        ...args.map(arg => arg === remote ? alias : arg),
      ])
    } finally {
      if (temporaryCaPath) rmSync(temporaryCaPath, { recursive: true, force: true })
    }
  }
}

function detail(res: HarvestExecResult): string {
  const text = (res.stderr && res.stderr.trim()) || (res.stdout && res.stdout.trim()) || `exit ${res.exitCode}`
  return text
}

const GITHUB_PATH = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u

function isValidRepositoryRemote(remote: unknown): remote is string {
  if (isValidCloudflareArtifactsGitRemote(remote)) return true
  const parsed = parseCanonicalCredentialFreeHttpsUrl(remote)
  return parsed !== null && parsed.hostname === 'github.com' && GITHUB_PATH.test(parsed.pathname)
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/**
 * Count commits present locally but not on the private ref fetched from the
 * pinned repository. Exit-zero empty output is zero; lookup failures are unknown.
 */
function countUnpushed(exec: HarvestExec, pinnedRef: string): number | null {
  const res = exec(['rev-list', '--count', `${pinnedRef}..HEAD`])
  if (res.exitCode !== 0) return null
  const output = res.stdout.trim()
  if (output === '') return 0
  if (!/^\d+$/u.test(output)) return null
  const count = Number(output)
  return Number.isSafeInteger(count) ? count : null
}

/**
 * Persist any uncommitted or unpushed work in the workspace. Deterministic and
 * total: every path returns a `HarvestOutcome`, never throws.
 */
export function harvestWorkspace(opts: HarvestOptions): HarvestOutcome {
  // Safety gate: never touch a real repo unless explicitly enabled or given an
  // injected exec. Absent both, report that inspection was skipped.
  if (!opts.exec && !opts.enabled) {
    return { kind: 'work_not_inspected' }
  }
  if (!isValidRepositoryRemote(opts.repositoryRemote)) {
    return { kind: 'work_persist_failed', error: 'repository_locator_invalid' }
  }
  // Every invocation gets a fresh, one-shot alias. Its exact command-scoped
  // rewrite outranks repo-local prefix rules and resolves to the validated URL
  // byte-for-byte; an observer of one argv cannot redirect a later command.
  if (!opts.exec && (!opts.credentialHelper || /[\r\n\0]/u.test(opts.credentialHelper))) {
    return { kind: 'work_persist_failed', error: 'checkpoint_credential_helper_invalid' }
  }
  const caBundleCandidates = opts.caBundleCandidates ?? HOSTED_HARVEST_CA_BUNDLE_CANDIDATES
  const caBundle = resolveHostedHarvestCaBundle(caBundleCandidates)
  if (!caBundle) {
    return {
      kind: 'work_persist_failed',
      error: `hosted_harvest_ca_bundle_missing: ${caBundleCandidates.join(', ')}`,
    }
  }
  const caPath = resolveHostedHarvestCaPath(opts.caPathCandidates)
  const rawExec = opts.exec ?? defaultHarvestExec(opts.workspaceDir)
  const exec = protectPinnedRemote(
    rawExec,
    opts.repositoryRemote,
    caBundle,
    caPath,
    opts.credentialHelper
  )
  const pinnedRef = `refs/orizu/pinned/${opts.sessionBranch}`
  try {
    const rejectedKeyPattern = HOSTED_HARVEST_TRANSPORT_POLICY.rejectedLocalHttpKeys.join('|')
    const localTransportConfig = exec([
      'config', '--includes', '--show-origin', '--name-only', '--get-regexp',
      `^http\\.(.*\\.)?(${rejectedKeyPattern})$`,
    ])
    if (localTransportConfig.exitCode !== 0 && localTransportConfig.exitCode !== 1) {
      return { kind: 'work_persist_failed', error: `git config inspection failed: ${detail(localTransportConfig)}` }
    }
    if (splitLines(localTransportConfig.stdout).length > 0) {
      return { kind: 'work_persist_failed', error: 'hosted_harvest_transport_config_present' }
    }
    if (!opts.exec) {
      const effectiveSslVerify = exec([
        'config', '--get-urlmatch', 'http.sslVerify', `${opts.repositoryRemote}/`,
      ])
      if (effectiveSslVerify.exitCode !== 0 || effectiveSslVerify.stdout.trim() !== 'true') {
        return { kind: 'work_persist_failed', error: 'hosted_harvest_tls_policy_ineffective' }
      }
      const effectiveCaPath = exec(['config', '--get-urlmatch', 'http.sslCAPath', `${opts.repositoryRemote}/`])
      const resolvedCaPath = effectiveCaPath.stdout.trim()
      const expectedTemporaryPrefix = join(tmpdir(), 'orizu-harvest-ca-')
      const isExpectedCaPath = caPath ? resolvedCaPath === caPath : resolvedCaPath.startsWith(expectedTemporaryPrefix)
      if (effectiveCaPath.exitCode !== 0 || !isExpectedCaPath) {
        return { kind: 'work_persist_failed', error: 'hosted_harvest_ca_path_policy_ineffective' }
      }
    }
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
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'gpg.program=',
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

    // Never derive checkpoint truth from mutable `origin`. Refresh a private ref
    // from the independently validated repository before deciding there is no work.
    const fetchPinned = exec([
      'fetch', '--no-tags', '--force', opts.repositoryRemote,
      `+refs/heads/${opts.sessionBranch}:${pinnedRef}`,
    ])
    const hasPinnedBase = fetchPinned.exitCode === 0
    const unpushed = hasPinnedBase ? countUnpushed(exec, pinnedRef) : null
    // Unknown is not none. Preserve round-3 behavior by attempting the exact
    // pinned-repository push; omit file claims if no trustworthy base exists.
    if (!dirty && unpushed === 0) return { kind: 'work_none' }

    const headRes = exec(['rev-parse', 'HEAD'])
    const sha = headRes.exitCode === 0 ? headRes.stdout.trim() : ''
    if (!/^[a-f0-9]{40}$/.test(sha)) {
      return { kind: 'work_persist_failed', error: `git rev-parse HEAD failed: ${detail(headRes)}` }
    }

    // Files are the complete delta the exact push delivers, including any local
    // commits the agent made before the final auto-harvest commit.
    const filesRes = hasPinnedBase
      ? exec(['diff', '--name-only', `${pinnedRef}..HEAD`])
      : null
    const files = filesRes?.exitCode === 0 ? splitLines(filesRes.stdout) : null

    // --no-verify blocks hostile hooks, including Git LFS's legitimate upload
    // hook. Run the equivalent upload explicitly before publishing the pointer ref.
    const lfsVersion = exec(['lfs', 'version'])
    if (lfsVersion.exitCode === 0) {
      const lfsFiles = exec(['lfs', 'ls-files', '--name-only'])
      if (lfsFiles.exitCode !== 0) {
        return { kind: 'work_persist_failed', error: `git_lfs_inspection_failed: ${detail(lfsFiles)}` }
      }
      if (splitLines(lfsFiles.stdout).length > 0) {
        const lfsPush = exec(['lfs', 'push', opts.repositoryRemote, sha])
        if (lfsPush.exitCode !== 0) {
          return { kind: 'work_persist_failed', error: `git_lfs_push_failed: ${detail(lfsPush)}` }
        }
      }
    }

    // Push the exact object we report to the exact session destination. This
    // avoids separately deriving a local claim and a tracking-branch update.
    const push = exec([
      'push', '--no-verify', opts.repositoryRemote, `${sha}:refs/heads/${opts.sessionBranch}`,
    ])
    if (push.exitCode !== 0) {
      return { kind: 'work_persist_failed', error: `git push failed: ${detail(push)}` }
    }
    exec(['update-ref', pinnedRef, sha])

    return { kind: 'work_persisted', sha, files }
  } catch (error) {
    return { kind: 'work_persist_failed', error: error instanceof Error ? error.message : String(error) }
  }
}
