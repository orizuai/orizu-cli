import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, type ReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import {
  buildHardenedGitEnvironment,
  type RecoveryCredentialHelperInvocation,
} from './git-recovery-environment.js'
import {
  assertRecoveryRefName,
  assertSafeRecoveryPath,
  assertSha1ObjectId,
  canonicalizeRepositoryRecoveryManifest,
  REPOSITORY_BACKUP_ADMISSION_ENVELOPE_VERSION,
  type FrozenRepositoryDatabasePin,
  type GitObjectType,
  type RepositoryBackupAdmissionEnvelopeVersion,
  type RepositoryRecoveryManifest,
  type RepositoryRecoveryObject,
  type RepositoryRecoveryRef,
  type RepositoryRefBindingMode,
  parseRepositoryRecoveryManifestBytes,
  serializeRepositoryRecoveryManifest,
  sha256Hex,
} from './repository-recovery-manifest.js'

export interface RepositoryBackupLimits {
  maxRefs: number
  maxObjects: number
  maxObjectBytes: number
  maxSingleObjectBytes: number
  maxCommits: number
  maxTreeEntries: number
  maxDatabasePins: number
  maxQuarantineBytes: number
  maxManifestBytes: number
  maxBundleBytes: number
  maxGitOutputBytes: number
  maxGitInputBytes: number
  /**
   * Hard memory ceiling requested for the complete isolated job, not merely
   * the Node.js heap or one Git child.
   */
  maxMemoryBytes: number
  /**
   * Hard task ceiling requested for the complete job process tree. Production
   * boundaries count threads as tasks so Git cannot bypass it with workers.
   */
  maxProcessCount: number
  commandTimeoutMs: number
  overallTimeoutMs: number
}

export const MAX_REPOSITORY_BACKUP_MEMORY_BYTES =
  8 * 1024 * 1024 * 1024
export const MAX_REPOSITORY_BACKUP_PROCESS_COUNT = 64

export const DEFAULT_REPOSITORY_BACKUP_LIMITS: Readonly<RepositoryBackupLimits> =
  Object.freeze({
    maxRefs: 20_000,
    maxObjects: 1_000_000,
    maxObjectBytes: 10 * 1024 * 1024 * 1024,
    maxSingleObjectBytes: 128 * 1024 * 1024,
    maxCommits: 250_000,
    maxTreeEntries: 2_000_000,
    maxDatabasePins: 100_000,
    maxQuarantineBytes: 12 * 1024 * 1024 * 1024,
    maxManifestBytes: 256 * 1024 * 1024,
    maxBundleBytes: 2 * 1024 * 1024 * 1024,
    maxGitOutputBytes: 128 * 1024 * 1024,
    maxGitInputBytes: 64 * 1024 * 1024,
    maxMemoryBytes: 4 * 1024 * 1024 * 1024,
    maxProcessCount: 32,
    commandTimeoutMs: 2 * 60 * 1000,
    overallTimeoutMs: 15 * 60 * 1000,
  })

export interface RepositoryRefAdvertisement {
  headTarget: string | null
  headObjectId: string | null
  refs: RepositoryRecoveryRef[]
  peeledRefs: RepositoryRecoveryRef[]
}

export interface CloudflareArtifactsRepositoryTarget {
  accountId: string
  namespace: string
  repository: string
}

export interface RepositoryBackupExecutionBoundaryRequest {
  /**
   * The hard quota that must apply to the complete job filesystem, including
   * source quarantine, bundle, manifest, and independent restore quarantine.
   */
  quotaBytes: number
  /**
   * Hard total-memory ceiling for the job and all descendants. This must be
   * independently enforced by the execution platform, not by a heap flag.
   */
  maxMemoryBytes: number
  /**
   * Hard process/thread-task ceiling for the job and all descendants.
   */
  maxProcessCount: number
  purpose: 'create-and-verify' | 'verify-existing'
  /**
   * Hard wall for the complete filesystem-scoped operation. Production
   * boundaries must terminate the job process and all descendants when this
   * expires; an in-process AbortSignal alone is not an isolation boundary.
   */
  timeoutMs: number
}

export interface RepositoryBackupExecutionFilesystem {
  /** Empty, absolute filesystem root dedicated to exactly this job. */
  rootPath: string
  quotaBytes: number
  maxMemoryBytes: number
  maxProcessCount: number
  isolation: 'per-job'
  /**
   * `hard` means the execution platform enforces quota independently of this
   * process (for example, a sandbox volume/filesystem quota). The test-only
   * mode is accepted only for explicit local fixtures.
   */
  quotaEnforcement: 'hard' | 'test-only-unenforced'
  /**
   * These attest that the boundary applied the requested limits to the whole
   * job process tree before invoking the operation.
   */
  memoryEnforcement: 'hard' | 'test-only-unenforced'
  processCountEnforcement: 'hard' | 'test-only-unenforced'
}

/**
 * Production execution boundary. Implementations must provision a new,
 * isolated filesystem with the exact requested hard quota, invoke `operation`
 * exactly once, wait for it to settle, then destroy the filesystem. Merely
 * pointing at a shared host temp directory does not satisfy this contract.
 */
export interface RepositoryBackupExecutionBoundary {
  withJobFilesystem<T>(
    request: RepositoryBackupExecutionBoundaryRequest,
    operation: (
      filesystem: RepositoryBackupExecutionFilesystem
    ) => Promise<T>
  ): Promise<T>
}

export interface PathBackedRepositoryBackupArtifact {
  /**
   * Valid only for the duration of consumeVerifiedArtifacts. Callers should
   * stream it and must not retain the path after the callback resolves.
   */
  path: string
  byteCount: number
  sha256: string
  openStream(): ReadStream
}

export interface VerifiedRepositoryBackupArtifacts {
  manifest: PathBackedRepositoryBackupArtifact
  bundle: PathBackedRepositoryBackupArtifact
}

export interface RepositoryBackupDeadline {
  /**
   * Aborts at the same absolute deadline as the complete backup operation.
   * Streaming implementations must pass this signal to every provider read,
   * upload, and checksum/readback request.
   */
  signal: AbortSignal
  deadlineMs: number
}

export interface RepositoryBackupArtifactDestinations {
  /**
   * Create both files without following links and finish all writes before
   * returning. Production implementations stream downloads into these paths.
   */
  manifestPath: string
  bundlePath: string
}

export interface CreateVerifiedRepositoryBackupInput<
  TArtifactResult = unknown,
> {
  /**
   * Immutable admission policy frozen by the backup job. A new limit set
   * receives a new version; an existing version is never reinterpreted.
   */
  admissionEnvelopeVersion: RepositoryBackupAdmissionEnvelopeVersion
  /**
   * Secret-free remote locator. Production authentication is supplied only by
   * the trusted backup worker's command-scoped exact-path helper below.
   */
  remoteUrl: string
  /**
   * Exact provider identity frozen by the backup job. Every production remote
   * is reconstructed from this tuple and compared byte-for-byte before Git is
   * spawned, so an attacker-controlled locator cannot redirect the
   * operation-scoped credential helper to another origin or repository.
   */
  cloudflareArtifactsTarget?: CloudflareArtifactsRepositoryTarget
  /**
   * Test-only/local-rehearsal escape hatch. Production callers accept HTTPS
   * only. `file://` is never inferred from an ambient Git config.
   */
  allowLocalRemote?: boolean
  /**
   * Optional trusted executable invocation; arguments may identify an opaque
   * operation but must never contain a token/password. The helper obtains a
   * one-use credential when Git asks and store/erase remain no-ops.
   */
  credentialHelper?: RecoveryCredentialHelperInvocation
  requiredRef: string
  /**
   * Exact is required for immutable publication/bootstrap/recovery refs.
   * Reachability keeps a frozen historical merge/scheduled commit executable
   * after its provenance branch advances.
   */
  requiredRefBindingMode?: RepositoryRefBindingMode
  requiredCommitSha: string
  databasePins: readonly FrozenRepositoryDatabasePin[]
  limits?: Partial<RepositoryBackupLimits>
  executionBoundary: RepositoryBackupExecutionBoundary
  /**
   * Runs only after source-side and independent restore verification. Stream
   * both path-backed artifacts to durable storage before returning; the
   * execution boundary destroys every path after this callback settles.
   */
  consumeVerifiedArtifacts: (
    artifacts: VerifiedRepositoryBackupArtifacts,
    deadline: RepositoryBackupDeadline
  ) => Promise<TArtifactResult>
}

export interface VerifiedRepositoryBackup<TArtifactResult = unknown> {
  manifest: RepositoryRecoveryManifest
  /**
   * Plaintext artifact hashes. Storage code must verify the uploaded
   * FULL_OBJECT checksum and separately record exact object version, KMS key,
   * and retention evidence. Neither value is a ciphertext hash.
   */
  manifestSha256: string
  bundleSha256: string
  manifestByteCount: number
  bundleByteCount: number
  artifactResult: TArtifactResult
  advertisementBefore: RepositoryRefAdvertisement
  advertisementAfter: RepositoryRefAdvertisement
}

export interface VerifyRepositoryBackupBundleInput {
  /**
   * Exact version frozen by the backup attempt. It must match the persisted
   * manifest before any restored evidence is accepted.
   */
  admissionEnvelopeVersion: RepositoryBackupAdmissionEnvelopeVersion
  limits?: Partial<RepositoryBackupLimits> | RepositoryBackupLimits
  executionBoundary: RepositoryBackupExecutionBoundary
  /**
   * Stream existing artifacts into the exact fresh paths supplied by the
   * verifier. This avoids accepting or copying a multi-gigabyte Buffer.
   */
  stageArtifacts: (
    destinations: RepositoryBackupArtifactDestinations,
    deadline: RepositoryBackupDeadline
  ) => Promise<void>
}

export interface RepositoryBackupVerificationReceipt {
  refsVerified: number
  objectsVerified: number
  databasePinsVerified: number
}

interface GitCommandResult {
  exitCode: number
  stdout: Buffer
  stderr: Buffer
  timedOut: boolean
  outputExceeded: boolean
  filesystemBudgetExceeded: boolean
  filesystemMonitorFailed: boolean
}

interface GitContext {
  repoDir: string
  env: NodeJS.ProcessEnv
  limits: RepositoryBackupLimits
  deadlineMs: number
}

interface ParsedTreeEntry {
  mode: string
  type: string
  objectId: string
  path: string
}

interface GitFilesystemBudget {
  path: string
  maxBytes: number
}

const EMPTY_SHA1 = '0'.repeat(40)
const SAFE_LOCAL_CONFIG_KEYS = new Set([
  'core.bare',
  'core.filemode',
  'core.ignorecase',
  'core.logallrefupdates',
  'core.precomposeunicode',
  'core.repositoryformatversion',
])

const DANGEROUS_PATH_NAMES = new Set([
  '.git',
  '.git-credentials',
  '.gitconfig',
  '.gitmodules',
  '.lfsconfig',
])
const CLOUDFLARE_ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/
const CLOUDFLARE_ARTIFACTS_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/

class RepositoryQuarantineBudgetExceededError extends Error {}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function decodeUtf8Strict(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${label} is not valid UTF-8`)
  }
}

function resolveLimits(
  admissionEnvelopeVersion: number,
  overrides: Partial<RepositoryBackupLimits> | undefined
): RepositoryBackupLimits {
  if (
    admissionEnvelopeVersion !==
    REPOSITORY_BACKUP_ADMISSION_ENVELOPE_VERSION
  ) {
    throw new Error(
      'repository backup admission envelope version is unsupported'
    )
  }
  const limits: RepositoryBackupLimits = {
    ...DEFAULT_REPOSITORY_BACKUP_LIMITS,
  }
  if (overrides !== undefined) {
    for (const [name, value] of Object.entries(overrides)) {
      if (
        !Object.prototype.hasOwnProperty.call(
          DEFAULT_REPOSITORY_BACKUP_LIMITS,
          name
        )
      ) {
        throw new Error(`repository backup limit ${name} is unsupported`)
      }
      const envelopeMaximum =
        DEFAULT_REPOSITORY_BACKUP_LIMITS[
          name as keyof RepositoryBackupLimits
        ]
      if (
        typeof value !== 'number' ||
        value > envelopeMaximum
      ) {
        throw new Error(
          `repository backup limit ${name} exceeds admission envelope version ${admissionEnvelopeVersion}`
        )
      }
      limits[name as keyof RepositoryBackupLimits] = value
    }
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`repository backup limit ${name} must be a positive safe integer`)
    }
  }
  if (limits.commandTimeoutMs > limits.overallTimeoutMs) {
    throw new Error('Git command timeout cannot exceed the overall backup timeout')
  }
  if (limits.maxMemoryBytes > MAX_REPOSITORY_BACKUP_MEMORY_BYTES) {
    throw new Error(
      `repository backup memory limit cannot exceed ${MAX_REPOSITORY_BACKUP_MEMORY_BYTES} bytes`
    )
  }
  if (limits.maxProcessCount > MAX_REPOSITORY_BACKUP_PROCESS_COUNT) {
    throw new Error(
      `repository backup process-count limit cannot exceed ${MAX_REPOSITORY_BACKUP_PROCESS_COUNT}`
    )
  }
  return Object.freeze(limits)
}

function executionFilesystemQuotaBytes(
  limits: RepositoryBackupLimits
): number {
  const quotaBytes =
    limits.maxQuarantineBytes +
    limits.maxBundleBytes +
    limits.maxManifestBytes
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0) {
    throw new Error(
      'repository backup execution filesystem quota exceeds the safe integer range'
    )
  }
  return quotaBytes
}

async function assertExecutionFilesystem(
  filesystem: RepositoryBackupExecutionFilesystem,
  request: RepositoryBackupExecutionBoundaryRequest,
  allowUnenforcedTestBoundary: boolean
): Promise<void> {
  if (
    filesystem === null ||
    typeof filesystem !== 'object' ||
    filesystem.isolation !== 'per-job' ||
    filesystem.quotaBytes !== request.quotaBytes ||
    filesystem.maxMemoryBytes !== request.maxMemoryBytes ||
    filesystem.maxProcessCount !== request.maxProcessCount ||
    !Number.isSafeInteger(filesystem.quotaBytes) ||
    !Number.isSafeInteger(filesystem.maxMemoryBytes) ||
    !Number.isSafeInteger(filesystem.maxProcessCount) ||
    !isAbsolute(filesystem.rootPath) ||
    filesystem.rootPath.includes('\u0000') ||
    /[\r\n]/.test(filesystem.rootPath)
  ) {
    throw new Error(
      'repository backup execution boundary returned an invalid per-job filesystem'
    )
  }
  const enforcementModes = [
    filesystem.quotaEnforcement,
    filesystem.memoryEnforcement,
    filesystem.processCountEnforcement,
  ]
  if (enforcementModes.some(mode =>
    mode !== 'hard' &&
    !(mode === 'test-only-unenforced' && allowUnenforcedTestBoundary)
  )) {
    throw new Error(
      'repository backup production execution requires hard filesystem, memory, and process-count limits'
    )
  }

  const metadata = await lstat(filesystem.rootPath)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(
      'repository backup execution root must be an isolated directory'
    )
  }
  if ((await realpath(filesystem.rootPath)) !== filesystem.rootPath) {
    throw new Error(
      'repository backup execution root must not traverse symbolic links'
    )
  }
  if ((await readdir(filesystem.rootPath)).length !== 0) {
    throw new Error(
      'repository backup execution root must be empty and dedicated to one job'
    )
  }
}

async function withExecutionFilesystem<T>(input: {
  boundary: RepositoryBackupExecutionBoundary
  limits: RepositoryBackupLimits
  purpose: RepositoryBackupExecutionBoundaryRequest['purpose']
  allowUnenforcedTestBoundary: boolean
  operation: (
    filesystem: RepositoryBackupExecutionFilesystem
  ) => Promise<T>
}): Promise<T> {
  if (
    input.boundary === null ||
    typeof input.boundary !== 'object' ||
    typeof input.boundary.withJobFilesystem !== 'function'
  ) {
    throw new Error(
      'repository backup requires an explicit execution boundary'
    )
  }
  const request = Object.freeze({
    quotaBytes: executionFilesystemQuotaBytes(input.limits),
    maxMemoryBytes: input.limits.maxMemoryBytes,
    maxProcessCount: input.limits.maxProcessCount,
    purpose: input.purpose,
    timeoutMs: input.limits.overallTimeoutMs,
  })
  let invocationCount = 0
  const result = await input.boundary.withJobFilesystem(
    request,
    async filesystem => {
      invocationCount += 1
      if (invocationCount !== 1) {
        throw new Error(
          'repository backup execution boundary invoked the job more than once'
        )
      }
      await assertExecutionFilesystem(
        filesystem,
        request,
        input.allowUnenforcedTestBoundary
      )
      return input.operation(filesystem)
    }
  )
  if (invocationCount !== 1) {
    throw new Error(
      'repository backup execution boundary did not invoke the job exactly once'
    )
  }
  return result
}

function assertWithinDeadline(deadlineMs: number): void {
  if (Date.now() >= deadlineMs) {
    throw new Error('repository backup exceeded its overall timeout')
  }
}

async function withinOverallDeadline<T>(
  deadlineMs: number,
  operation: string,
  callback: (deadline: RepositoryBackupDeadline) => Promise<T>
): Promise<T> {
  assertWithinDeadline(deadlineMs)
  const controller = new AbortController()
  const timeoutError = new Error(
    `${operation} exceeded the repository backup overall timeout`
  )
  const timeoutMs = Math.max(1, deadlineMs - Date.now())
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutSentinel = Symbol('repository-backup-timeout')
  const timedOut = new Promise<typeof timeoutSentinel>(resolve => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError)
      resolve(timeoutSentinel)
    }, timeoutMs)
  })
  const operationPromise = Promise.resolve().then(() =>
    callback(
      Object.freeze({
        signal: controller.signal,
        deadlineMs,
      })
    )
  )

  try {
    const result = await Promise.race([operationPromise, timedOut])
    if (result !== timeoutSentinel) return result

    // Never let boundary cleanup race a still-running provider callback. A
    // compliant callback observes the signal and settles; if it does not, the
    // independently enforced process-tree wall on the production execution
    // boundary terminates the whole job instead of letting this frame return.
    try {
      await operationPromise
    } catch {
      // The stable timeout is the externally visible failure. Provider errors
      // after abort must not leak secrets or replace that classification.
    }
    throw timeoutError
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    if (!controller.signal.aborted) {
      controller.abort(
        new Error('repository backup callback lifetime ended')
      )
    }
  }
}

function remainingCommandTimeout(context: GitContext): number {
  assertWithinDeadline(context.deadlineMs)
  return Math.max(
    1,
    Math.min(context.limits.commandTimeoutMs, context.deadlineMs - Date.now())
  )
}

function commandLabel(args: readonly string[]): string {
  return args.slice(0, 3).join(' ')
}

function runGitProcess(input: {
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  stdin?: Buffer
  timeoutMs: number
  maxOutputBytes: number
  filesystemBudget?: GitFilesystemBudget
}): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const useProcessGroup = process.platform !== 'win32'
    const child = spawn('git', input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: useProcessGroup,
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let outputBytes = 0
    let timedOut = false
    let outputExceeded = false
    let filesystemBudgetExceeded = false
    let filesystemMonitorFailed = false
    let settled = false
    let killRequested = false
    const monitorController = new AbortController()
    let monitorDone: Promise<void> = Promise.resolve()

    const kill = () => {
      if (killRequested || child.killed) return
      killRequested = true
      if (useProcessGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
          return
        } catch {
          // The process may have crossed the close boundary. Fall through to
          // the direct child kill, which is harmless when it already exited.
        }
      }
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, input.timeoutMs)

    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > input.maxOutputBytes) {
        outputExceeded = true
        kill()
        return
      }
      target.push(Buffer.from(chunk))
    }
    child.stdout.on('data', chunk => collect(stdoutChunks, chunk))
    child.stderr.on('data', chunk => collect(stderrChunks, chunk))
    const stopMonitor = async (): Promise<void> => {
      monitorController.abort()
      await monitorDone
    }
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void stopMonitor().then(
        () => reject(error),
        () => reject(error)
      )
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void stopMonitor().then(() => {
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
          timedOut,
          outputExceeded,
          filesystemBudgetExceeded,
          filesystemMonitorFailed,
        })
      })
    })

    child.stdin.on('error', () => {
      // EPIPE is reflected in the command's exit status. Never surface stdin
      // bytes (which can contain a large ref inventory) in an error.
    })
    child.stdin.end(input.stdin)

    if (input.filesystemBudget !== undefined) {
      const waitForNextCheck = (): Promise<void> =>
        new Promise(resolveWait => {
          if (monitorController.signal.aborted) {
            resolveWait()
            return
          }
          const onAbort = () => {
            clearTimeout(interval)
            resolveWait()
          }
          const interval = setTimeout(() => {
            monitorController.signal.removeEventListener('abort', onAbort)
            resolveWait()
          }, 10)
          monitorController.signal.addEventListener('abort', onAbort, {
            once: true,
          })
        })

      monitorDone = (async () => {
        while (!monitorController.signal.aborted) {
          try {
            await directoryBytes(input.filesystemBudget!.path, {
              total: 0,
              max: input.filesystemBudget!.maxBytes,
              deadlineMs: Number.MAX_SAFE_INTEGER,
            })
          } catch (error) {
            if (error instanceof RepositoryQuarantineBudgetExceededError) {
              filesystemBudgetExceeded = true
            } else {
              filesystemMonitorFailed = true
            }
            kill()
            return
          }
          await waitForNextCheck()
        }
      })()
    }
  })
}

async function gitResult(
  context: GitContext,
  args: string[],
  options: {
    acceptedExitCodes?: readonly number[]
    stdin?: Buffer
    operation?: string
    monitorQuarantine?: boolean
  } = {}
): Promise<GitCommandResult> {
  const inputBytes = options.stdin?.length ?? 0
  if (inputBytes > context.limits.maxGitInputBytes) {
    throw new Error(
      `${options.operation ?? commandLabel(args)} exceeds the Git input byte budget`
    )
  }

  const result = await runGitProcess({
    args,
    cwd: context.repoDir,
    env: context.env,
    stdin: options.stdin,
    timeoutMs: remainingCommandTimeout(context),
    maxOutputBytes: context.limits.maxGitOutputBytes,
    ...(options.monitorQuarantine === true
      ? {
          filesystemBudget: {
            path: context.repoDir,
            maxBytes: context.limits.maxQuarantineBytes,
          },
        }
      : {}),
  })
  if (result.filesystemBudgetExceeded) {
    throw new Error('repository quarantine byte budget exceeded during Git transfer')
  }
  if (result.filesystemMonitorFailed) {
    throw new Error('repository quarantine filesystem monitor failed closed')
  }
  if (result.timedOut) {
    throw new Error(`${options.operation ?? commandLabel(args)} exceeded its hard timeout`)
  }
  if (result.outputExceeded) {
    throw new Error(`${options.operation ?? commandLabel(args)} exceeded its output byte budget`)
  }
  const acceptedExitCodes = options.acceptedExitCodes ?? [0]
  if (!acceptedExitCodes.includes(result.exitCode)) {
    // Git processes consume untrusted repository/remote data and may invoke a
    // credential helper. Never surface stderr: a malicious remote or helper
    // can echo a bearer in an otherwise ordinary failure.
    throw new Error(`${options.operation ?? commandLabel(args)} failed`)
  }
  assertWithinDeadline(context.deadlineMs)
  return result
}

async function git(
  context: GitContext,
  args: string[],
  options: {
    stdin?: Buffer
    operation?: string
    monitorQuarantine?: boolean
  } = {}
): Promise<Buffer> {
  return (await gitResult(context, args, options)).stdout
}

function assertCloudflareArtifactsTarget(
  value: CloudflareArtifactsRepositoryTarget | undefined
): asserts value is CloudflareArtifactsRepositoryTarget {
  if (
    value === undefined ||
    value === null ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(',') !== 'accountId,namespace,repository' ||
    !CLOUDFLARE_ACCOUNT_ID_PATTERN.test(value.accountId) ||
    !CLOUDFLARE_ARTIFACTS_NAME_PATTERN.test(value.namespace) ||
    !CLOUDFLARE_ARTIFACTS_NAME_PATTERN.test(value.repository)
  ) {
    throw new Error(
      'repository backup requires an exact Cloudflare Artifacts target'
    )
  }
}

function snapshotCloudflareArtifactsTarget(
  value: CloudflareArtifactsRepositoryTarget | undefined
): CloudflareArtifactsRepositoryTarget | undefined {
  if (value === undefined) return undefined
  if (
    value === null ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(',') !==
      'accountId,namespace,repository'
  ) {
    throw new Error(
      'repository backup requires an exact Cloudflare Artifacts target'
    )
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const name of ['accountId', 'namespace', 'repository'] as const) {
    const descriptor = descriptors[name]
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value') ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new Error(
        'repository backup requires an immutable Cloudflare Artifacts target'
      )
    }
  }
  const snapshot = Object.freeze({
    accountId: descriptors.accountId.value as string,
    namespace: descriptors.namespace.value as string,
    repository: descriptors.repository.value as string,
  })
  assertCloudflareArtifactsTarget(snapshot)
  return snapshot
}

function validateRemoteUrl(
  remoteUrl: string,
  allowLocalRemote: boolean,
  cloudflareArtifactsTarget: CloudflareArtifactsRepositoryTarget | undefined
): 'file' | 'https' {
  if (
    typeof remoteUrl !== 'string' ||
    remoteUrl.length === 0 ||
    remoteUrl.length > 4_096 ||
    /[\u0000-\u0020\u007f]/.test(remoteUrl)
  ) {
    throw new Error('repository backup remote must be a bounded HTTPS URL')
  }

  let parsed: URL
  try {
    parsed = new URL(remoteUrl)
  } catch {
    throw new Error('repository backup remote must be an HTTPS URL')
  }

  if (parsed.username || parsed.password) {
    throw new Error('repository backup remote URL must not contain credentials')
  }
  if (parsed.search || parsed.hash) {
    throw new Error('repository backup remote URL must not contain a query or fragment')
  }

  if (parsed.protocol === 'https:') {
    assertCloudflareArtifactsTarget(cloudflareArtifactsTarget)
    const expectedRemote =
      `https://${cloudflareArtifactsTarget.accountId}.artifacts.cloudflare.net` +
      `/git/${cloudflareArtifactsTarget.namespace}/` +
      `${cloudflareArtifactsTarget.repository}.git`
    if (
      parsed.port ||
      parsed.hostname !==
        `${cloudflareArtifactsTarget.accountId}.artifacts.cloudflare.net` ||
      parsed.pathname !==
        `/git/${cloudflareArtifactsTarget.namespace}/` +
          `${cloudflareArtifactsTarget.repository}.git` ||
      remoteUrl !== expectedRemote
    ) {
      throw new Error(
        'repository backup remote is not the exact Cloudflare Artifacts repository'
      )
    }
    return 'https'
  }

  if (parsed.protocol === 'file:' && allowLocalRemote) {
    if (cloudflareArtifactsTarget !== undefined) {
      throw new Error(
        'local recovery fixtures must not claim a Cloudflare Artifacts target'
      )
    }
    if (
      (parsed.hostname && parsed.hostname !== 'localhost') ||
      !isAbsolute(decodeURIComponent(parsed.pathname))
    ) {
      throw new Error('local recovery fixture URL must identify an absolute local path')
    }
    return 'file'
  }

  throw new Error('repository backup remote must use HTTPS')
}

function parseAdvertisement(
  bytes: Buffer,
  limits: RepositoryBackupLimits
): RepositoryRefAdvertisement {
  const text = decodeUtf8Strict(bytes, 'remote ref advertisement')
  if (text.includes('\u0000')) {
    throw new Error('remote ref advertisement contains a NUL byte')
  }

  let headTarget: string | null = null
  let headObjectId: string | null = null
  const refs = new Map<string, string>()
  const peeledRefs = new Map<string, string>()
  const lines = text.split('\n').filter(line => line.length > 0)

  for (const line of lines) {
    const tab = line.indexOf('\t')
    if (tab <= 0 || line.indexOf('\t', tab + 1) !== -1) {
      throw new Error('remote ref advertisement contains a malformed line')
    }
    const value = line.slice(0, tab)
    const name = line.slice(tab + 1)

    if (value.startsWith('ref: ')) {
      if (name !== 'HEAD' || headTarget !== null) {
        throw new Error('remote ref advertisement contains an unexpected symbolic ref')
      }
      const target = value.slice('ref: '.length)
      assertRecoveryRefName(target, 'advertised HEAD target')
      headTarget = target
      continue
    }

    assertSha1ObjectId(value, `advertised object ID for ${name}`)
    if (name === 'HEAD') {
      if (headObjectId !== null) {
        throw new Error('remote ref advertisement contains duplicate HEAD values')
      }
      headObjectId = value
      continue
    }
    if (name.endsWith('^{}')) {
      const base = name.slice(0, -3)
      assertRecoveryRefName(base, 'advertised peeled ref')
      if (peeledRefs.has(base)) {
        throw new Error(`remote ref advertisement contains duplicate peeled ref ${base}`)
      }
      peeledRefs.set(base, value)
      if (refs.size + peeledRefs.size > limits.maxRefs) {
        throw new Error('remote ref advertisement exceeds the ref budget')
      }
      continue
    }

    assertRecoveryRefName(name, 'advertised ref')
    if (refs.has(name)) {
      throw new Error(`remote ref advertisement contains duplicate ref ${name}`)
    }
    refs.set(name, value)
    if (refs.size + peeledRefs.size > limits.maxRefs) {
      throw new Error('remote ref advertisement exceeds the ref budget')
    }
  }

  if (headTarget !== null) {
    const targetObjectId = refs.get(headTarget)
    if (!targetObjectId || headObjectId !== targetObjectId) {
      throw new Error('advertised HEAD does not match its exact symbolic target')
    }
  }
  if (refs.size > 0 && headObjectId === null) {
    throw new Error('non-empty remote repository does not advertise a valid HEAD')
  }
  for (const base of peeledRefs.keys()) {
    if (!refs.has(base)) {
      throw new Error(`peeled advertisement has no exact base ref: ${base}`)
    }
  }

  return {
    headTarget,
    headObjectId,
    refs: [...refs.entries()]
      .map(([name, objectId]) => ({ name, objectId }))
      .sort((left, right) => compareStrings(left.name, right.name)),
    peeledRefs: [...peeledRefs.entries()]
      .map(([name, objectId]) => ({ name, objectId }))
      .sort((left, right) => compareStrings(left.name, right.name)),
  }
}

function advertisementJson(advertisement: RepositoryRefAdvertisement): string {
  return JSON.stringify(advertisement)
}

export function assertStableRepositoryRefAdvertisement(
  before: RepositoryRefAdvertisement,
  after: RepositoryRefAdvertisement
): void {
  if (advertisementJson(before) !== advertisementJson(after)) {
    throw new Error('remote ref advertisement changed during backup; refusing unstable evidence')
  }
}

async function advertisedRefs(
  context: GitContext,
  remoteUrl: string
): Promise<RepositoryRefAdvertisement> {
  const bytes = await git(
    context,
    ['ls-remote', '--symref', '--', remoteUrl],
    { operation: 'full remote ref advertisement' }
  )
  return parseAdvertisement(bytes, context.limits)
}

function refMap(refs: readonly RepositoryRecoveryRef[]): Map<string, string> {
  return new Map(refs.map(ref => [ref.name, ref.objectId]))
}

function assertRequiredTarget(
  advertisement: RepositoryRefAdvertisement,
  requiredRef: string,
  requiredRefBindingMode: RepositoryRefBindingMode,
  requiredCommitSha: string
): void {
  const advertised = refMap(advertisement.refs).get(requiredRef)
  if (advertised === undefined) {
    throw new Error('required provenance ref is absent')
  }
  if (
    requiredRefBindingMode === 'exact' &&
    advertised !== requiredCommitSha
  ) {
    throw new Error('required ref does not resolve to the exact required commit SHA')
  }
}

async function assertCommitIsAncestorOfRef(
  context: GitContext,
  commitSha: string,
  refObjectId: string,
  errorMessage: string
): Promise<void> {
  const result = await gitResult(
    context,
    [
      'merge-base',
      '--is-ancestor',
      commitSha,
      `${refObjectId}^{commit}`,
    ],
    {
      acceptedExitCodes: [0, 1],
      operation: 'frozen ref reachability verification',
    }
  )
  if (result.exitCode === 1) {
    throw new Error(errorMessage)
  }
}

async function assertSafeLocalRepositoryConfig(context: GitContext): Promise<void> {
  const output = await git(
    context,
    ['config', '--local', '--null', '--list'],
    { operation: 'local repository config inspection' }
  )
  for (const entry of output.toString('utf8').split('\u0000')) {
    if (!entry) continue
    const newline = entry.indexOf('\n')
    const key = newline === -1 ? entry : entry.slice(0, newline)
    if (!SAFE_LOCAL_CONFIG_KEYS.has(key)) {
      throw new Error(`dangerous or unexpected local Git config persisted: ${key}`)
    }
  }
}

async function localRefInventory(context: GitContext): Promise<RepositoryRecoveryRef[]> {
  const output = await git(
    context,
    ['for-each-ref', '--format=%(objectname)%09%(refname)'],
    { operation: 'local ref inventory' }
  )
  const refs = output
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [objectId, name, extra] = line.split('\t')
      if (!objectId || !name || extra !== undefined) {
        throw new Error('local ref inventory contains a malformed line')
      }
      assertSha1ObjectId(objectId, `local object ID for ${name}`)
      assertRecoveryRefName(name, 'local ref')
      return { name, objectId }
    })
    .sort((left, right) => compareStrings(left.name, right.name))

  if (refs.length > context.limits.maxRefs) {
    throw new Error('local ref inventory exceeds the ref budget')
  }
  return refs
}

function assertEqualRefInventory(
  expected: readonly RepositoryRecoveryRef[],
  actual: readonly RepositoryRecoveryRef[],
  label: string
): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`${label} does not match the exact advertised ref inventory`)
  }
}

function parseObjectInventory(bytes: Buffer): RepositoryRecoveryObject[] {
  return bytes
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [objectId, type, sizeText, extra] = line.split('\t')
      if (!objectId || !type || !sizeText || extra !== undefined) {
        throw new Error('Git object inventory contains a malformed line')
      }
      assertSha1ObjectId(objectId, 'inventoried Git object ID')
      if (type !== 'blob' && type !== 'commit' && type !== 'tag' && type !== 'tree') {
        throw new Error(`unsupported inventoried Git object type: ${type}`)
      }
      const size = Number(sizeText)
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(`Git object ${objectId} has an invalid size`)
      }
      return { objectId, type: type as GitObjectType, size }
    })
    .sort((left, right) => compareStrings(left.objectId, right.objectId))
}

function assertObjectBudgets(
  objects: readonly RepositoryRecoveryObject[],
  limits: RepositoryBackupLimits
): void {
  if (objects.length > limits.maxObjects) {
    throw new Error('repository object budget exceeded')
  }
  const commits = objects.filter(object => object.type === 'commit').length
  if (commits > limits.maxCommits) {
    throw new Error('repository commit budget exceeded')
  }

  let total = 0
  const seen = new Set<string>()
  for (const object of objects) {
    if (seen.has(object.objectId)) {
      throw new Error(`duplicate object in Git inventory: ${object.objectId}`)
    }
    seen.add(object.objectId)
    if (object.size > limits.maxSingleObjectBytes) {
      throw new Error(`Git object ${object.objectId} exceeds the single-object byte budget`)
    }
    total += object.size
    if (!Number.isSafeInteger(total) || total > limits.maxObjectBytes) {
      throw new Error('repository object byte budget exceeded')
    }
  }
}

async function reachableObjectInventory(
  context: GitContext
): Promise<RepositoryRecoveryObject[]> {
  const idsOutput = await git(
    context,
    ['rev-list', '--objects', '--all', '--no-object-names'],
    { operation: 'reachable Git object enumeration' }
  )
  const ids = [...new Set(
    idsOutput
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map(value => {
        assertSha1ObjectId(value, 'reachable Git object ID')
        return value
      })
  )].sort(compareStrings)
  if (ids.length > context.limits.maxObjects) {
    throw new Error('repository object budget exceeded')
  }
  if (ids.length === 0) {
    throw new Error('repository backup contains no reachable Git objects')
  }

  const input = Buffer.from(`${ids.join('\n')}\n`, 'utf8')
  const output = await git(
    context,
    ['cat-file', '--batch-check=%(objectname)\t%(objecttype)\t%(objectsize)'],
    { stdin: input, operation: 'reachable Git object metadata inventory' }
  )
  const objects = parseObjectInventory(output)
  if (objects.length !== ids.length) {
    throw new Error('reachable Git object metadata inventory is incomplete')
  }
  assertObjectBudgets(objects, context.limits)
  return objects
}

async function allStoredObjectInventory(
  context: GitContext
): Promise<RepositoryRecoveryObject[]> {
  const output = await git(
    context,
    [
      'cat-file',
      '--batch-all-objects',
      '--batch-check=%(objectname)\t%(objecttype)\t%(objectsize)',
    ],
    { operation: 'stored Git object inventory' }
  )
  const objects = parseObjectInventory(output)
  assertObjectBudgets(objects, context.limits)
  return objects
}

function assertExactObjectInventory(
  expected: readonly RepositoryRecoveryObject[],
  actual: readonly RepositoryRecoveryObject[],
  label: string
): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`${label} contains missing, extra, or changed Git objects`)
  }
}

function parseTreeEntries(bytes: Buffer): ParsedTreeEntry[] {
  return decodeUtf8Strict(bytes, 'Git tree inventory')
    .split('\u0000')
    .filter(Boolean)
    .map(entry => {
      const tab = entry.indexOf('\t')
      if (tab === -1) throw new Error('Git tree inventory contains a malformed entry')
      const metadata = entry.slice(0, tab).split(' ')
      if (metadata.length !== 3) {
        throw new Error('Git tree inventory contains malformed metadata')
      }
      const [mode, type, objectId] = metadata
      const path = entry.slice(tab + 1)
      assertSha1ObjectId(objectId, `tree object ID for ${path}`)
      assertSafeRecoveryPath(path, 'inventoried repository path')
      return { mode, type, objectId, path }
    })
}

function dangerousPathReason(entry: ParsedTreeEntry): string | null {
  const parts = entry.path.split('/')
  const dangerousName = parts.find(part => DANGEROUS_PATH_NAMES.has(part.toLowerCase()))
  if (dangerousName) return `forbidden ${dangerousName} path`
  if (entry.mode === '160000' || entry.type === 'commit') return 'gitlink/submodule entry'
  if (entry.mode === '120000') return 'symbolic-link entry'
  if (entry.type === 'tree' && entry.mode === '040000') return null
  if (entry.type === 'blob' && entry.mode !== '100644' && entry.mode !== '100755') {
    return `unsupported blob mode ${entry.mode}`
  }
  if (entry.type !== 'blob') return `unexpected tree entry type ${entry.type}`
  return null
}

function hasDangerousAttributes(bytes: Buffer): boolean {
  const text = bytes.toString('utf8')
  if (text.includes('\u0000')) return true
  return text.split(/\r?\n/).some(line => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return false
    const attributes = trimmed.split(/\s+/).slice(1)
    return attributes.some(attribute =>
      /^(?:-|!)?filter(?:=|$)/i.test(attribute) ||
      /^(?:-|!)?(?:diff|merge)=lfs$/i.test(attribute) ||
      /^(?:-|!)?lockable$/i.test(attribute)
    )
  })
}

async function assertSafeReachableHistory(
  context: GitContext,
  objects: readonly RepositoryRecoveryObject[]
): Promise<void> {
  const objectsById = new Map(objects.map(object => [object.objectId, object.type]))
  // Inspect each reachable tree object exactly once. Scanning only current tips
  // would miss deleted historical .gitmodules/filter paths; scanning every
  // commit recursively would recount shared subtrees quadratically.
  const treeIds = objects
    .filter(object => object.type === 'tree')
    .map(object => object.objectId)
    .sort(compareStrings)
  const attributeBlobIds = new Set<string>()
  let treeEntries = 0

  for (const treeId of treeIds) {
    assertWithinDeadline(context.deadlineMs)
    const output = await git(
      context,
      ['ls-tree', '-z', treeId],
      { operation: `reachable tree scan ${treeId}` }
    )
    const entries = parseTreeEntries(output)
    const collisionKeys = new Map<string, string>()
    for (const entry of entries) {
      treeEntries += 1
      if (treeEntries > context.limits.maxTreeEntries) {
        throw new Error('repository tree-entry budget exceeded')
      }
      const reason = dangerousPathReason(entry)
      if (reason) {
        throw new Error(`dangerous repository content (${reason}): ${entry.path}`)
      }
      const collisionKey = entry.path.normalize('NFC').toLowerCase()
      const existingPath = collisionKeys.get(collisionKey)
      if (existingPath !== undefined && existingPath !== entry.path) {
        throw new Error(
          `dangerous repository content (case/Unicode-colliding paths): ${existingPath}, ${entry.path}`
        )
      }
      collisionKeys.set(collisionKey, entry.path)
      if (objectsById.get(entry.objectId) !== entry.type) {
        throw new Error(
          `tree entry ${entry.path} type does not match the complete object inventory`
        )
      }
      if (entry.path.toLowerCase() === '.gitattributes') {
        attributeBlobIds.add(entry.objectId)
      }
    }
  }

  for (const objectId of [...attributeBlobIds].sort(compareStrings)) {
    const attributes = await git(
      context,
      ['cat-file', 'blob', objectId],
      { operation: `Git attributes inspection ${objectId}` }
    )
    if (hasDangerousAttributes(attributes)) {
      throw new Error('dangerous repository content (filter/LFS attributes)')
    }
  }
}

async function verifyDatabasePins(
  context: GitContext,
  refs: readonly RepositoryRecoveryRef[],
  objects: readonly RepositoryRecoveryObject[],
  pins: readonly FrozenRepositoryDatabasePin[]
): Promise<void> {
  if (pins.length > context.limits.maxDatabasePins) {
    throw new Error('database pin budget exceeded')
  }
  const refsByName = refMap(refs)
  const objectsById = new Map(objects.map(object => [object.objectId, object]))
  const pinKeys = new Set<string>()

  for (const pin of pins) {
    assertWithinDeadline(context.deadlineMs)
    const key = `${pin.kind}\u0000${pin.pinId}`
    if (pinKeys.has(key)) {
      throw new Error(`duplicate database pin: ${pin.kind}/${pin.pinId}`)
    }
    pinKeys.add(key)
    assertSha1ObjectId(pin.commitSha, `database pin ${pin.pinId} commit`)
    if (objectsById.get(pin.commitSha)?.type !== 'commit') {
      throw new Error(`database pin ${pin.kind}/${pin.pinId} is not a reachable commit`)
    }
    assertRecoveryRefName(pin.ref, `database pin ${pin.pinId} ref`)
    if (
      pin.refBindingMode !== 'exact' &&
      pin.refBindingMode !== 'reachability'
    ) {
      throw new Error(
        `database pin ${pin.kind}/${pin.pinId} ref binding mode is invalid`
      )
    }
    if (pin.refBindingMode === 'exact') {
      if (refsByName.get(pin.ref) !== pin.commitSha) {
        throw new Error(
          `database pin ${pin.kind}/${pin.pinId} ref does not resolve to its exact commit`
        )
      }
    } else {
      const refObjectId = refsByName.get(pin.ref)
      if (refObjectId === undefined) {
        throw new Error(
          `database pin ${pin.kind}/${pin.pinId} frozen ref is absent`
        )
      }
      await assertCommitIsAncestorOfRef(
        context,
        pin.commitSha,
        refObjectId,
        `database pin ${pin.kind}/${pin.pinId} commit is not reachable from its frozen ref`
      )
    }
    const pathIdentityFields = [
      pin.path,
      pin.pathObjectType,
      pin.pathObjectId,
    ]
    const hasPathIdentity = pathIdentityFields.some(
      value => value !== undefined
    )
    if (
      hasPathIdentity &&
      pathIdentityFields.some(value => value === undefined)
    ) {
      throw new Error(
        `database pin ${pin.kind}/${pin.pinId} must freeze path, object type, and object ID together`
      )
    }
    if (!hasPathIdentity && pin.contentSha256 !== undefined) {
      throw new Error(
        `database pin ${pin.kind}/${pin.pinId} cannot freeze a content hash without a path identity`
      )
    }
    if (!hasPathIdentity) continue

    assertSafeRecoveryPath(pin.path!, `database pin ${pin.pinId} path`)
    if (
      pin.pathObjectType !== 'blob' &&
      pin.pathObjectType !== 'tree'
    ) {
      throw new Error(
        `database pin ${pin.kind}/${pin.pinId} path object type is invalid`
      )
    }
    assertSha1ObjectId(
      pin.pathObjectId!,
      `database pin ${pin.pinId} path object ID`
    )
    const resolvedObjectId = (await git(
      context,
      [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${pin.commitSha}:${pin.path}`,
      ],
      { operation: `database pin path resolution ${pin.kind}/${pin.pinId}` }
    )).toString('utf8').trim()
    if (resolvedObjectId !== pin.pathObjectId) {
      throw new Error(
        `database pin ${pin.kind}/${pin.pinId} path object ID does not match`
      )
    }
    if (
      objectsById.get(resolvedObjectId)?.type !==
      pin.pathObjectType
    ) {
      throw new Error(
        `database pin ${pin.kind}/${pin.pinId} path does not resolve to the frozen ${pin.pathObjectType}`
      )
    }
    if (pin.contentSha256 === undefined) continue
    if (pin.pathObjectType !== 'blob') {
      throw new Error(
        `database pin ${pin.kind}/${pin.pinId} content hash requires a blob path`
      )
    }
    const content = await git(
      context,
      ['cat-file', 'blob', resolvedObjectId],
      { operation: `database pin content verification ${pin.kind}/${pin.pinId}` }
    )
    if (sha256Hex(content) !== pin.contentSha256) {
      throw new Error(`database pin ${pin.kind}/${pin.pinId} content hash does not match`)
    }
  }
}

async function directoryBytes(
  path: string,
  state: { total: number; max: number; deadlineMs: number }
): Promise<number> {
  assertWithinDeadline(state.deadlineMs)
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return 0
    }
    throw error
  }
  if (metadata.isSymbolicLink()) {
    throw new Error('quarantine contains an unexpected symbolic link')
  }
  if (!metadata.isDirectory()) {
    state.total += metadata.size
    if (!Number.isSafeInteger(state.total) || state.total > state.max) {
      throw new RepositoryQuarantineBudgetExceededError(
        'repository quarantine byte budget exceeded'
      )
    }
    return metadata.size
  }

  let total = 0
  let entries: string[]
  try {
    entries = await readdir(path)
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return 0
    }
    throw error
  }
  for (const entry of entries) {
    total += await directoryBytes(join(path, entry), state)
    if (!Number.isSafeInteger(total)) {
      throw new Error('quarantine byte count exceeds the safe integer range')
    }
  }
  return total
}

async function assertQuarantineBudget(context: GitContext): Promise<void> {
  const bytes = await directoryBytes(context.repoDir, {
    total: 0,
    max: context.limits.maxQuarantineBytes,
    deadlineMs: context.deadlineMs,
  })
  if (bytes > context.limits.maxQuarantineBytes) {
    throw new RepositoryQuarantineBudgetExceededError(
      'repository quarantine byte budget exceeded'
    )
  }
}

async function assertIsSha1Repository(context: GitContext): Promise<void> {
  const format = (await git(
    context,
    ['rev-parse', '--show-object-format'],
    { operation: 'Git object-format assertion' }
  )).toString('utf8').trim()
  if (format !== 'sha1') {
    throw new Error(`repository uses unsupported ${format || 'unknown'} object format; SHA-1 required`)
  }
}

async function assertExactLocalHead(
  context: GitContext,
  expectedTarget: string | null,
  expectedObjectId: string | null
): Promise<void> {
  const headBytes = await readFile(join(context.repoDir, 'HEAD'))
  if (headBytes.length > 2_048) {
    throw new Error('local Git HEAD exceeds its byte budget')
  }
  const head = decodeUtf8Strict(headBytes, 'local Git HEAD').trimEnd()
  const expected = expectedTarget === null
    ? expectedObjectId
    : `ref: ${expectedTarget}`
  if (expected === null || head !== expected) {
    throw new Error('local Git HEAD does not match the exact advertised HEAD')
  }
  const resolved = (await git(
    context,
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    { operation: 'local Git HEAD commit assertion' }
  )).toString('utf8').trim()
  if (resolved !== expectedObjectId) {
    throw new Error('local Git HEAD does not resolve to its exact advertised commit')
  }
}

async function verifyRepositoryState(
  context: GitContext,
  expectedRefs: readonly RepositoryRecoveryRef[],
  pins: readonly FrozenRepositoryDatabasePin[],
  headTarget: string | null,
  headObjectId: string | null,
  requiredRef: string,
  requiredRefBindingMode: RepositoryRefBindingMode,
  requiredCommitSha: string
): Promise<RepositoryRecoveryObject[]> {
  await assertIsSha1Repository(context)
  await assertSafeLocalRepositoryConfig(context)
  await assertExactLocalHead(context, headTarget, headObjectId)
  const localRefs = await localRefInventory(context)
  assertEqualRefInventory(expectedRefs, localRefs, 'local repository')
  await git(
    context,
    ['fsck', '--full', '--strict', '--no-reflogs'],
    { operation: 'strict full Git fsck' }
  )
  const reachable = await reachableObjectInventory(context)
  const stored = await allStoredObjectInventory(context)
  assertExactObjectInventory(reachable, stored, 'Git object database')
  await assertSafeReachableHistory(context, reachable)
  const requiredRefObjectId = refMap(expectedRefs).get(requiredRef)
  if (requiredRefObjectId === undefined) {
    throw new Error('required provenance ref is absent')
  }
  if (requiredRefBindingMode === 'exact') {
    if (requiredRefObjectId !== requiredCommitSha) {
      throw new Error(
        'required ref does not resolve to the exact required commit SHA'
      )
    }
  } else {
    await assertCommitIsAncestorOfRef(
      context,
      requiredCommitSha,
      requiredRefObjectId,
      'required provenance commit is not reachable from its frozen ref'
    )
  }
  await verifyDatabasePins(context, expectedRefs, reachable, pins)
  await assertQuarantineBudget(context)
  return reachable
}

async function makeTempContext(
  jobRoot: string,
  directoryName: string,
  limits: RepositoryBackupLimits,
  allowedProtocols: readonly ('file' | 'https')[],
  deadlineMs: number,
  credentialHelper?: RecoveryCredentialHelperInvocation
): Promise<{ root: string; context: GitContext }> {
  const root = join(jobRoot, directoryName)
  const repoDir = join(root, 'repository.git')
  const homeDir = join(root, 'home')
  const hooksDir = join(root, 'hooks')
  const processTempDir = join(root, 'tmp')
  await mkdir(root, { mode: 0o700 })
  await mkdir(repoDir, { mode: 0o700 })
  await mkdir(homeDir, { mode: 0o700 })
  await mkdir(hooksDir, { mode: 0o700 })
  await mkdir(processTempDir, { mode: 0o700 })
  return {
    root,
    context: {
      repoDir,
      limits,
      deadlineMs,
      env: {
        ...buildHardenedGitEnvironment({
          homeDir,
          hooksDir,
          tempDir: processTempDir,
          allowedProtocols,
          credentialHelper,
        }),
        GIT_LITERAL_PATHSPECS: '1',
      },
    },
  }
}

async function initializeBareSha1(context: GitContext): Promise<void> {
  await git(
    context,
    ['init', '--bare', '--object-format=sha1', '.'],
    { operation: 'bare SHA-1 quarantine initialization' }
  )
  await assertIsSha1Repository(context)
}

async function assertNoCredentialPersistence(root: string): Promise<void> {
  const home = join(root, 'home')
  const entries = await readdir(home)
  if (entries.length > 0) {
    throw new Error('Git recovery attempted to persist configuration or credentials')
  }
}

interface RegularFileEvidence {
  byteCount: number
  inode: number
  modifiedMs: number
}

async function inspectRegularArtifact(
  path: string,
  maxBytes: number,
  label: string
): Promise<RegularFileEvidence> {
  const metadata = await lstat(path)
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.size <= 0 ||
    metadata.size > maxBytes
  ) {
    throw new Error(`${label} byte budget exceeded or artifact is not a regular file`)
  }
  return {
    byteCount: metadata.size,
    inode: metadata.ino,
    modifiedMs: metadata.mtimeMs,
  }
}

function assertUnchangedArtifact(
  before: RegularFileEvidence,
  after: RegularFileEvidence,
  label: string
): void {
  if (
    before.byteCount !== after.byteCount ||
    before.inode !== after.inode ||
    before.modifiedMs !== after.modifiedMs
  ) {
    throw new Error(`${label} changed while it was being consumed`)
  }
}

async function hashRegularArtifact(
  path: string,
  maxBytes: number,
  label: string
): Promise<{ byteCount: number; sha256: string }> {
  const before = await inspectRegularArtifact(path, maxBytes, label)
  const hash = createHash('sha256')
  let streamedBytes = 0
  for await (const chunk of createReadStream(path, { flags: 'r' })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    streamedBytes += bytes.length
    if (
      !Number.isSafeInteger(streamedBytes) ||
      streamedBytes > maxBytes
    ) {
      throw new Error(`${label} byte budget exceeded while streaming`)
    }
    hash.update(bytes)
  }
  const after = await inspectRegularArtifact(path, maxBytes, label)
  assertUnchangedArtifact(before, after, label)
  if (streamedBytes !== before.byteCount) {
    throw new Error(`${label} byte count changed while streaming`)
  }
  return {
    byteCount: before.byteCount,
    sha256: hash.digest('hex'),
  }
}

async function readManifestArtifact(
  path: string,
  limits: RepositoryBackupLimits
): Promise<{
  bytes: Buffer
  manifest: RepositoryRecoveryManifest
  byteCount: number
  sha256: string
}> {
  const before = await inspectRegularArtifact(
    path,
    limits.maxManifestBytes,
    'repository recovery manifest'
  )
  const bytes = await readFile(path)
  const after = await inspectRegularArtifact(
    path,
    limits.maxManifestBytes,
    'repository recovery manifest'
  )
  assertUnchangedArtifact(before, after, 'repository recovery manifest')
  if (bytes.length !== before.byteCount) {
    throw new Error(
      'repository recovery manifest changed while it was being read'
    )
  }
  return {
    bytes,
    manifest: parseRepositoryRecoveryManifestBytes(bytes),
    byteCount: bytes.length,
    sha256: sha256Hex(bytes),
  }
}

function pathBackedArtifact(
  path: string,
  evidence: { byteCount: number; sha256: string }
): PathBackedRepositoryBackupArtifact {
  return Object.freeze({
    path,
    byteCount: evidence.byteCount,
    sha256: evidence.sha256,
    openStream: () => createReadStream(path, { flags: 'r' }),
  })
}

function updateRefTransaction(refs: readonly RepositoryRecoveryRef[]): Buffer {
  const lines = ['start']
  for (const ref of refs) {
    lines.push(`update ${ref.name} ${ref.objectId} ${EMPTY_SHA1}`)
  }
  lines.push('prepare', 'commit', '')
  return Buffer.from(lines.join('\n'), 'utf8')
}

async function verifyBundleInContext(
  context: GitContext,
  bundlePath: string,
  manifest: RepositoryRecoveryManifest
): Promise<RepositoryBackupVerificationReceipt> {
  await git(
    context,
    ['bundle', 'verify', bundlePath],
    { operation: 'Git bundle structural verification' }
  )
  const heads = await git(
    context,
    ['bundle', 'list-heads', bundlePath],
    { operation: 'Git bundle ref inventory' }
  )
  let bundleHeadObjectId: string | null = null
  const advertisedBundleRefs = heads
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const space = line.indexOf(' ')
      if (space <= 0) throw new Error('Git bundle ref inventory is malformed')
      const objectId = line.slice(0, space)
      const name = line.slice(space + 1)
      assertSha1ObjectId(objectId, `bundle object ID for ${name}`)
      if (name === 'HEAD') {
        if (bundleHeadObjectId !== null) {
          throw new Error('Git bundle contains duplicate HEAD advertisements')
        }
        bundleHeadObjectId = objectId
        return null
      }
      assertRecoveryRefName(name, 'bundle ref')
      return { name, objectId }
    })
    .filter((value): value is RepositoryRecoveryRef => value !== null)
    .sort((left, right) => compareStrings(left.name, right.name))
  assertEqualRefInventory(manifest.refs, advertisedBundleRefs, 'Git bundle')
  if (bundleHeadObjectId !== manifest.headObjectId) {
    throw new Error('Git bundle HEAD does not match the recovery manifest')
  }

  await git(
    context,
    ['bundle', 'unbundle', bundlePath],
    { operation: 'Git bundle quarantine unbundle' }
  )
  await git(
    context,
    ['update-ref', '--stdin'],
    {
      stdin: updateRefTransaction(manifest.refs),
      operation: 'atomic restored-ref installation',
    }
  )
  if (manifest.headTarget !== null) {
    await git(
      context,
      ['symbolic-ref', 'HEAD', manifest.headTarget],
      { operation: 'restored HEAD installation' }
    )
  } else if (manifest.headObjectId !== null) {
    await git(
      context,
      // HEAD already exists as the bare repository's unborn symbolic ref.
      // Passing the all-zero "must not exist" old value was accepted by older
      // Git releases but is correctly rejected by Git 2.54 when --no-deref
      // replaces that symref with a direct detached HEAD. This repository is a
      // fresh private restore boundary, so there is no caller-owned HEAD to
      // compare-and-swap.
      ['update-ref', '--no-deref', 'HEAD', manifest.headObjectId],
      { operation: 'restored detached HEAD installation' }
    )
  }

  const objects = await verifyRepositoryState(
    context,
    manifest.refs,
    manifest.databasePins,
    manifest.headTarget,
    manifest.headObjectId,
    manifest.requiredRef,
    manifest.requiredRefBindingMode,
    manifest.requiredCommitSha
  )
  assertExactObjectInventory(manifest.objects, objects, 'restored repository')
  return {
    refsVerified: manifest.refs.length,
    objectsVerified: objects.length,
    databasePinsVerified: manifest.databasePins.length,
  }
}

async function verifyRepositoryBackupPathsByDeadline(
  input: {
    jobRoot: string
    bundlePath: string
    manifestPath: string
    restoreDirectoryName: string
  },
  admissionEnvelopeVersion: RepositoryBackupAdmissionEnvelopeVersion,
  limits: RepositoryBackupLimits,
  deadlineMs: number
): Promise<{
  receipt: RepositoryBackupVerificationReceipt
  manifest: RepositoryRecoveryManifest
  manifestEvidence: { byteCount: number; sha256: string }
  bundleEvidence: { byteCount: number; sha256: string }
}> {
  const manifestArtifact = await readManifestArtifact(
    input.manifestPath,
    limits
  )
  if (
    manifestArtifact.manifest.admissionEnvelopeVersion !==
    admissionEnvelopeVersion
  ) {
    throw new Error(
      'repository recovery manifest admission envelope conflicts with the frozen backup attempt'
    )
  }
  const bundleEvidence = await hashRegularArtifact(
    input.bundlePath,
    limits.maxBundleBytes,
    'Git bundle'
  )
  if (manifestArtifact.sha256 === bundleEvidence.sha256) {
    throw new Error('manifest and bundle must have distinct SHA-256 hashes')
  }
  const { root, context } = await makeTempContext(
    input.jobRoot,
    input.restoreDirectoryName,
    limits,
    ['https'],
    deadlineMs
  )

  try {
    await initializeBareSha1(context)
    const receipt = await verifyBundleInContext(
      context,
      input.bundlePath,
      manifestArtifact.manifest
    )
    await assertNoCredentialPersistence(root)
    return {
      receipt,
      manifest: manifestArtifact.manifest,
      manifestEvidence: {
        byteCount: manifestArtifact.byteCount,
        sha256: manifestArtifact.sha256,
      },
      bundleEvidence,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function verifyRepositoryBackupBundle(
  input: VerifyRepositoryBackupBundleInput
): Promise<RepositoryBackupVerificationReceipt> {
  const admissionEnvelopeVersion =
    input.admissionEnvelopeVersion
  const limits = resolveLimits(
    admissionEnvelopeVersion,
    input.limits
  )
  if (typeof input.stageArtifacts !== 'function') {
    throw new Error(
      'repository backup verification requires a streaming staging callback'
    )
  }
  return withExecutionFilesystem({
    boundary: input.executionBoundary,
    limits,
    purpose: 'verify-existing',
    allowUnenforcedTestBoundary: false,
    async operation(filesystem) {
      const deadlineMs = Date.now() + limits.overallTimeoutMs
      const stagingRoot = join(filesystem.rootPath, 'staged-artifacts')
      await mkdir(stagingRoot, { mode: 0o700 })
      const bundlePath = join(stagingRoot, 'backup.bundle')
      const manifestPath = join(stagingRoot, 'recovery-manifest.json')
      await withinOverallDeadline(
        deadlineMs,
        'repository backup artifact staging',
        deadline =>
          input.stageArtifacts(
            { bundlePath, manifestPath },
            deadline
          )
      )
      const verified = await verifyRepositoryBackupPathsByDeadline(
        {
          jobRoot: filesystem.rootPath,
          bundlePath,
          manifestPath,
          restoreDirectoryName: 'restore-quarantine',
        },
        admissionEnvelopeVersion,
        limits,
        deadlineMs
      )
      return verified.receipt
    },
  })
}

export async function createVerifiedRepositoryBackup<TArtifactResult>(
  input: CreateVerifiedRepositoryBackupInput<TArtifactResult>
): Promise<VerifiedRepositoryBackup<TArtifactResult>> {
  const admissionEnvelopeVersion =
    input.admissionEnvelopeVersion
  const limits = resolveLimits(
    admissionEnvelopeVersion,
    input.limits
  )
  // Snapshot every value used after an await. JavaScript callers can supply
  // accessors or mutate otherwise TypeScript-readonly objects; a validated
  // provider URL must never be re-read from such a live request object.
  const remoteUrl = input.remoteUrl
  const allowLocalRemote = input.allowLocalRemote === true
  const cloudflareArtifactsTarget =
    snapshotCloudflareArtifactsTarget(
      input.cloudflareArtifactsTarget
    )
  const requiredRef = input.requiredRef
  const requiredCommitSha = input.requiredCommitSha
  const requiredRefBindingMode =
    input.requiredRefBindingMode ?? 'exact'
  const databasePins = Object.freeze(
    input.databasePins.map(pin =>
      Object.freeze({
        pinId: pin.pinId,
        kind: pin.kind,
        commitSha: pin.commitSha,
        ref: pin.ref,
        refBindingMode: pin.refBindingMode,
        path: pin.path,
        pathObjectType: pin.pathObjectType,
        pathObjectId: pin.pathObjectId,
        contentSha256: pin.contentSha256,
      })
    )
  )
  const executionBoundary = input.executionBoundary
  const consumeVerifiedArtifacts =
    input.consumeVerifiedArtifacts
  const rawCredentialHelper = input.credentialHelper
  const credentialHelper =
    rawCredentialHelper === undefined
      ? undefined
      : Object.freeze({
          executablePath: rawCredentialHelper.executablePath,
          arguments:
            rawCredentialHelper.arguments === undefined
              ? undefined
              : Object.freeze([
                  ...rawCredentialHelper.arguments,
                ]),
        })
  const protocol = validateRemoteUrl(
    remoteUrl,
    allowLocalRemote,
    cloudflareArtifactsTarget
  )
  assertRecoveryRefName(requiredRef, 'required backup ref')
  if (
    requiredRefBindingMode !== 'exact' &&
    requiredRefBindingMode !== 'reachability'
  ) {
    throw new Error(
      'required backup ref binding mode must be exact or reachability'
    )
  }
  assertSha1ObjectId(requiredCommitSha, 'required backup commit SHA')
  if (databasePins.length > limits.maxDatabasePins) {
    throw new Error('database pin budget exceeded')
  }
  if (typeof consumeVerifiedArtifacts !== 'function') {
    throw new Error(
      'repository backup requires a verified-artifact streaming callback'
    )
  }

  return withExecutionFilesystem({
    boundary: executionBoundary,
    limits,
    purpose: 'create-and-verify',
    allowUnenforcedTestBoundary:
      protocol === 'file' && allowLocalRemote,
    async operation(filesystem) {
      const deadlineMs = Date.now() + limits.overallTimeoutMs
      const { root, context } = await makeTempContext(
        filesystem.rootPath,
        'source-quarantine',
        limits,
        protocol === 'file' ? ['https', 'file'] : ['https'],
        deadlineMs,
        credentialHelper
      )

      try {
        await initializeBareSha1(context)
        const advertisementBefore = await advertisedRefs(
          context,
          remoteUrl
        )
        if (advertisementBefore.refs.length === 0) {
          throw new Error('remote repository advertises no refs')
        }
        assertRequiredTarget(
          advertisementBefore,
          requiredRef,
          requiredRefBindingMode,
          requiredCommitSha
        )

        const detachedHeadFetchRef =
          advertisementBefore.headTarget === null &&
          advertisementBefore.headObjectId !== null
            ? `refs/orizu-backup-internal/detached-head-${randomUUID()}`
            : null
        const fetchRefspecLines = advertisementBefore.refs
          .map(ref => `+${ref.name}:${ref.name}`)
        if (detachedHeadFetchRef !== null) {
          // A directly advertised HEAD can point at an object that no named
          // ref reaches. Fetch HEAD into a private quarantine ref so the
          // object is present before installing the exact detached HEAD. The
          // private ref is removed before inventory and bundle creation.
          fetchRefspecLines.push(`+HEAD:${detachedHeadFetchRef}`)
        }
        const refspecs = Buffer.from(
          `${fetchRefspecLines.join('\n')}\n`,
          'utf8'
        )
        await git(
          context,
          [
            'fetch',
            '--atomic',
            '--force',
            '--no-tags',
            '--no-write-fetch-head',
            '--no-recurse-submodules',
            '--no-auto-maintenance',
            '--stdin',
            remoteUrl,
          ],
          {
            stdin: refspecs,
            operation: 'full advertised-ref quarantine fetch',
            monitorQuarantine: true,
          }
        )
        await assertQuarantineBudget(context)
        if (advertisementBefore.headTarget !== null) {
          await git(
            context,
            ['symbolic-ref', 'HEAD', advertisementBefore.headTarget],
            { operation: 'quarantine HEAD installation' }
          )
        } else if (advertisementBefore.headObjectId !== null) {
          if (detachedHeadFetchRef === null) {
            throw new Error(
              'detached HEAD quarantine ref was not initialized'
            )
          }
          const fetchedHeadObjectId = (await git(
            context,
            ['rev-parse', '--verify', detachedHeadFetchRef],
            { operation: 'quarantine detached HEAD fetch verification' }
          )).toString('utf8').trim()
          if (fetchedHeadObjectId !== advertisementBefore.headObjectId) {
            throw new Error(
              'fetched detached HEAD does not match its exact advertisement'
            )
          }
          await git(
            context,
            [
              'update-ref',
              '--no-deref',
              'HEAD',
              advertisementBefore.headObjectId,
            ],
            { operation: 'quarantine detached HEAD installation' }
          )
          await git(
            context,
            [
              'update-ref',
              '-d',
              detachedHeadFetchRef,
              advertisementBefore.headObjectId,
            ],
            { operation: 'quarantine detached HEAD fetch-ref cleanup' }
          )
        }

        const advertisementAfterFetch = await advertisedRefs(
          context,
          remoteUrl
        )
        assertStableRepositoryRefAdvertisement(
          advertisementBefore,
          advertisementAfterFetch
        )
        const objects = await verifyRepositoryState(
          context,
          advertisementBefore.refs,
          databasePins,
          advertisementBefore.headTarget,
          advertisementBefore.headObjectId,
          requiredRef,
          requiredRefBindingMode,
          requiredCommitSha
        )

        const manifest = canonicalizeRepositoryRecoveryManifest({
          admissionEnvelopeVersion,
          objectFormat: 'sha1',
          headTarget: advertisementBefore.headTarget,
          headObjectId: advertisementBefore.headObjectId,
          requiredRef,
          requiredRefBindingMode,
          requiredCommitSha,
          refs: advertisementBefore.refs,
          objects,
          databasePins,
        })
        const manifestPath = join(
          filesystem.rootPath,
          'recovery-manifest.json'
        )
        {
          const manifestBytes =
            serializeRepositoryRecoveryManifest(manifest)
          if (manifestBytes.length > limits.maxManifestBytes) {
            throw new Error(
              'repository recovery manifest byte budget exceeded'
            )
          }
          await writeFile(manifestPath, manifestBytes, {
            mode: 0o600,
            flag: 'wx',
          })
        }

        const bundlePath = join(filesystem.rootPath, 'backup.bundle')
        await git(
          context,
          [
            'bundle',
            'create',
            '--quiet',
            '--version=2',
            bundlePath,
            '--all',
          ],
          { operation: 'full-ref Git bundle creation' }
        )
        await inspectRegularArtifact(
          bundlePath,
          limits.maxBundleBytes,
          'Git bundle'
        )

        await git(
          context,
          ['bundle', 'verify', bundlePath],
          { operation: 'source-side Git bundle verification' }
        )
        const advertisementAfter = await advertisedRefs(
          context,
          remoteUrl
        )
        assertStableRepositoryRefAdvertisement(
          advertisementBefore,
          advertisementAfter
        )
        await assertNoCredentialPersistence(root)
        // The immutable bundle and manifest are now the only inputs to the
        // independent restore. Removing the source quarantine first keeps the
        // hard filesystem peak to one quarantine plus both artifacts.
        await rm(root, { recursive: true, force: true })

        const verified =
          await verifyRepositoryBackupPathsByDeadline(
            {
              jobRoot: filesystem.rootPath,
              bundlePath,
              manifestPath,
              restoreDirectoryName: 'restore-quarantine',
            },
            admissionEnvelopeVersion,
            limits,
            deadlineMs
          )
        if (
          JSON.stringify(verified.manifest) !==
            JSON.stringify(manifest) ||
          verified.receipt.refsVerified !==
            manifest.totals.refCount ||
          verified.receipt.objectsVerified !==
            manifest.totals.objectCount ||
          verified.receipt.databasePinsVerified !==
            manifest.totals.databasePinCount
        ) {
          throw new Error(
            'independent Git bundle verification receipt is incomplete'
          )
        }

        const artifactResult = await withinOverallDeadline(
          deadlineMs,
          'verified repository backup artifact consumption',
          deadline =>
            consumeVerifiedArtifacts(
              Object.freeze({
                manifest: pathBackedArtifact(
                  manifestPath,
                  verified.manifestEvidence
                ),
                bundle: pathBackedArtifact(
                  bundlePath,
                  verified.bundleEvidence
                ),
              }),
              deadline
            )
        )

        return {
          manifest,
          manifestSha256: verified.manifestEvidence.sha256,
          bundleSha256: verified.bundleEvidence.sha256,
          manifestByteCount:
            verified.manifestEvidence.byteCount,
          bundleByteCount: verified.bundleEvidence.byteCount,
          artifactResult,
          advertisementBefore,
          advertisementAfter,
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  })
}
