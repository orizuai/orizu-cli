/**
 * Self-contained rehearsal for the hosted bootstrap (ALI-925), extending the
 * ALI-973 `daytona-slice-rehearsal` pattern.
 *
 * The whole `bootstrapHostedSandbox` flow runs against the local-sim provider
 * with NO Daytona and NO GitHub: a REAL bare git repo backs the session branch,
 * and a REAL HTTP broker (`hosted-broker-server.ts`) stands in for the Orizu
 * control plane (per-repo token broker + RunAPI event ingest).
 *
 * The broker runs as a SEPARATE PROCESS on purpose: local-sim's `exec` blocks on
 * `spawnSync`, and the in-sandbox credential helper it runs calls the broker over
 * the network — an in-process server could not answer while the test thread is
 * blocked. The broker journals events/tokens to files the rehearsal reads back.
 */

import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { fileURLToPath } from 'url'

import { seedLocalBareRepo, type SeededBareRepo } from './daytona-slice-rehearsal.js'
import { createLocalSimProvider, type SandboxProvider } from './sandbox-provider.js'
import type { BrokerConfig } from './hosted-broker-server.js'
import { gitHttpEnv, type GitHttpConfig } from './hosted-git-http-server.js'

/** The loopback host the git server binds; the helper is scoped to it. */
const LOOPBACK_HOST = '127.0.0.1'

function git(args: string[], cwd?: string): { stdout: string; stderr: string; status: number } {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  delete env.GIT_OBJECT_DIRECTORY
  delete env.GIT_COMMON_DIR
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env })
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status ?? 1 }
}

function gitOrThrow(args: string[], cwd?: string): string {
  const r = git(args, cwd)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || `exit ${r.status}`}`)
  return r.stdout
}

// -- Broker process control --------------------------------------------------

interface BunSpawnLike {
  spawn: (options: {
    cmd: string[]
    env?: Record<string, string | undefined>
    stdout?: 'pipe' | 'inherit' | 'ignore'
    stderr?: 'pipe' | 'inherit' | 'ignore'
  }) => { stdout: ReadableStream<Uint8Array>; kill: (signal?: number) => void }
}

function bunSpawn(): BunSpawnLike {
  const b = (globalThis as { Bun?: BunSpawnLike }).Bun
  if (!b?.spawn) throw new Error('Bun.spawn is required for the hosted-bootstrap rehearsal (run under bun test)')
  return b
}

export interface SpawnedBroker {
  apiBaseUrl: string
  port: number
  stop: () => void
}

/**
 * Env keys the broker server reads (kept here so callers do not hand-roll them).
 */
export function brokerEnv(config: BrokerConfig): Record<string, string> {
  const env: Record<string, string> = { HB_BEARER: config.bearer, HB_REPO: config.repo }
  if (config.eventsFile) env.HB_EVENTS_FILE = config.eventsFile
  if (config.tokensFile) env.HB_TOKENS_FILE = config.tokensFile
  if (config.repoTokenStatus) env.HB_REPO_TOKEN_STATUS = String(config.repoTokenStatus)
  if (config.eventsStatus) env.HB_EVENTS_STATUS = String(config.eventsStatus)
  if (config.denyWrite) env.HB_DENY_WRITE = '1'
  return env
}

/**
 * Spawn the broker server as its own process and resolve once it prints
 * `LISTENING <port>` on stdout.
 */
export async function spawnBrokerProcess(config: BrokerConfig): Promise<SpawnedBroker> {
  const brokerPath = fileURLToPath(new URL('./hosted-broker-server.ts', import.meta.url))
  const proc = bunSpawn().spawn({
    cmd: ['bun', brokerPath],
    env: { ...process.env, ...brokerEnv(config) },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const decoder = new TextDecoder()
  const reader = proc.stdout.getReader()
  let buffered = ''
  const deadline = Date.now() + 10_000
  while (Date.now() <= deadline) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) buffered += decoder.decode(value, { stream: true })
    const match = buffered.match(/LISTENING (\d+)/)
    if (match) {
      reader.releaseLock()
      const port = Number.parseInt(match[1], 10)
      return { apiBaseUrl: `http://127.0.0.1:${port}`, port, stop: () => proc.kill() }
    }
  }
  reader.releaseLock()
  proc.kill()
  throw new Error('broker server did not report a listening port in time')
}

export interface SpawnedGitHttpServer {
  baseUrl: string
  port: number
  stop: () => void
}

/**
 * Spawn the authenticated smart-HTTP git server as its own process (same
 * separate-process rationale as the broker) and resolve once it prints
 * `LISTENING <port>`. `baseUrl` is the clone URL root; append the repo segment.
 */
export async function spawnGitHttpProcess(config: GitHttpConfig): Promise<SpawnedGitHttpServer> {
  const serverPath = fileURLToPath(new URL('./hosted-git-http-server.ts', import.meta.url))
  const proc = bunSpawn().spawn({
    cmd: ['bun', serverPath],
    env: { ...process.env, ...gitHttpEnv(config) },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const decoder = new TextDecoder()
  const reader = proc.stdout.getReader()
  let buffered = ''
  const deadline = Date.now() + 10_000
  while (Date.now() <= deadline) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) buffered += decoder.decode(value, { stream: true })
    const match = buffered.match(/LISTENING (\d+)/)
    if (match) {
      reader.releaseLock()
      const port = Number.parseInt(match[1], 10)
      return { baseUrl: `http://127.0.0.1:${port}`, port, stop: () => proc.kill() }
    }
  }
  reader.releaseLock()
  proc.kill()
  throw new Error('git http server did not report a listening port in time')
}

// -- Rehearsal ---------------------------------------------------------------

export interface RecordedRehearsalEvent {
  runId: string
  eventId: string
  sequence: number
  eventType: string
  payload: unknown
}

export interface HostedBootstrapRehearsal {
  apiBaseUrl: string
  bearer: string
  workspaceId: string
  sessionId: string
  runId: string
  sessionBranch: string
  repoFullName: string
  provider: SandboxProvider
  resolveCloneUrl: (repo: string) => string
  /** VCS host the helper is scoped to (the loopback git server). */
  host: string
  /** Loopback hosts the helper may serve over plain HTTP (rehearsal only). */
  insecureHttpHosts: readonly string[]
  /** All run events the broker accepted, in arrival order. */
  events: () => RecordedRehearsalEvent[]
  /** Every token value the broker minted (for residue-sweep assertions). */
  tokensIssued: () => string[]
  /** Every Basic-auth password the git server received (proves password===token). */
  basicAuthPasswords: () => string[]
  cleanup: () => Promise<void>
}

export interface RehearsalOptions {
  bearer?: string
  keep?: boolean
  /** Seed `.orizu/setup.sh` onto the session branch (force-added past the
   *  workbench `.orizu/` gitignore) so the setup-hook step has a hook to run. */
  setupHookBody?: string
  /** Force the repo-token broker to a status (tests the 4xx credential path). */
  repoTokenStatus?: number
  /** Force the run-events ingest to a status (tests the failure path). */
  eventsStatus?: number
}

function readJsonl<T>(file: string): T[] {
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return raw
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as T)
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(line => line.length > 0)
  } catch {
    return []
  }
}

export async function createHostedBootstrapRehearsal(
  options: RehearsalOptions = {}
): Promise<HostedBootstrapRehearsal> {
  const bearer = options.bearer ?? 'pat_rehearsal_bearer_do_not_log'
  const base = mkdtempSync(join(tmpdir(), 'orizu-hosted-boot-'))
  const repo: SeededBareRepo = seedLocalBareRepo(base, {
    teamSlug: 'acme',
    projectSlug: 'support-bot',
    workspaceSlug: 'support-bot-hosted',
  })

  const workspaceId = 'ws-hosted-1'
  const sessionId = 'sess-hosted-1'
  const runId = 'run-hosted-1'
  const sessionBranch = `orizu/session-${sessionId}`

  // Cut the session branch off main on the real bare repo.
  gitOrThrow(['--git-dir', repo.gitDir, 'branch', sessionBranch, repo.defaultBranch])

  // Optionally seed a customer setup hook onto the session branch. `.orizu/` is
  // git-ignored by the workbench contract, so the hook is force-added — an open
  // question flagged in the secrets-policy doc.
  if (options.setupHookBody) {
    const work = mkdtempSync(join(base, 'hook-'))
    gitOrThrow(['clone', '--branch', sessionBranch, repo.gitDir, work])
    mkdirSync(join(work, '.orizu'), { recursive: true })
    writeFileSync(join(work, '.orizu', 'setup.sh'), options.setupHookBody)
    const ident = ['-c', 'user.email=hook@orizu.local', '-c', 'user.name=Hook']
    gitOrThrow([...ident, '-C', work, 'add', '-f', '.orizu/setup.sh'])
    gitOrThrow([...ident, '-C', work, 'commit', '-m', 'seed setup hook'])
    gitOrThrow(['-C', work, 'push', 'origin', sessionBranch])
    rmSync(work, { recursive: true, force: true })
  }

  const eventsFile = join(base, 'events.jsonl')
  const tokensFile = join(base, 'tokens.txt')
  const authLogFile = join(base, 'git-auth.jsonl')
  writeFileSync(eventsFile, '')
  writeFileSync(tokensFile, '')
  writeFileSync(authLogFile, '')

  const broker = await spawnBrokerProcess({
    bearer,
    repo: repo.repoFullName,
    eventsFile,
    tokensFile,
    repoTokenStatus: options.repoTokenStatus,
    eventsStatus: options.eventsStatus,
  })

  // Real authenticated smart-HTTP git server on loopback: this is what makes the
  // clone go git → credential helper → broker → token → Basic auth → served repo,
  // instead of a filesystem clone that bypasses the helper entirely.
  const gitServer = await spawnGitHttpProcess({ repoDir: repo.gitDir, authLogFile })
  // git includes the (non-standard) port in the credential `host` field, so the
  // helper must be scoped to `127.0.0.1:<port>`, not the bare loopback host.
  const host = `${LOOPBACK_HOST}:${gitServer.port}`
  const insecureHttpHosts = [host]
  const cloneUrl = `${gitServer.baseUrl}/${basename(repo.gitDir)}`

  const provider = createLocalSimProvider({ rootDir: join(base, 'sandboxes'), keepOnDestroy: Boolean(options.keep) })

  return {
    apiBaseUrl: broker.apiBaseUrl,
    bearer,
    workspaceId,
    sessionId,
    runId,
    sessionBranch,
    repoFullName: repo.repoFullName,
    provider,
    resolveCloneUrl: () => cloneUrl,
    host,
    insecureHttpHosts,
    events: () => readJsonl<RecordedRehearsalEvent>(eventsFile),
    tokensIssued: () => readLines(tokensFile),
    basicAuthPasswords: () =>
      readJsonl<{ user: string; pass: string }>(authLogFile).map(entry => entry.pass),
    cleanup: async () => {
      broker.stop()
      gitServer.stop()
      if (!options.keep) rmSync(base, { recursive: true, force: true })
    },
  }
}
