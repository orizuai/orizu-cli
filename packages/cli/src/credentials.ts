// Reads only the user's credential, lock and token files.
// @tia-reads: none
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { homedir, hostname } from 'os'
import { randomBytes } from 'crypto'
import { AsyncLocalStorage } from 'async_hooks'
import { canonicalServerUrl, normalizeBaseUrl } from './global-flags.js'
import {
  ServerCredentials,
  StoredCredentialsV1,
  StoredCredentialsV2,
  StoredCredentialsV3,
} from './types.js'

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
}

// The system's short error code (EACCES, EPERM), never the message: messages
// from fs calls carry paths, and this one goes to the terminal.
function errorCode(error: unknown): string {
  return isNodeError(error) && typeof error.code === 'string' ? error.code : 'unknown error'
}

export function getConfigDir(): string {
  if (process.env.ORIZU_CONFIG_DIR) {
    return process.env.ORIZU_CONFIG_DIR
  }
  return join(homedir(), '.config', 'orizu')
}

function getCredentialsPath(): string {
  return join(getConfigDir(), 'credentials.json')
}

const DEFAULT_CREDENTIALS_LOCK_TIMEOUT_MS = 2_000
const MAX_CREDENTIALS_LOCK_TIMEOUT_MS = 10_000
export const CREDENTIALS_LOCK_RETRY_MS = 20

interface CredentialsLockMetadata {
  version: 1
  pid: number
  hostname: string
  createdAt: number
  instanceId: string
}

export interface HeldCredentialsLock {
  path: string
  metadata: string
  depth: number
  asyncOwner?: symbol
  released: Promise<void>
  resolveReleased: () => void
}

let heldCredentialsLock: HeldCredentialsLock | null = null
const credentialsTransactionOwner = new AsyncLocalStorage<symbol>()

function getCredentialsLockPath(): string {
  return `${getCredentialsPath()}.lock`
}

function readLockDuration(name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

export function credentialsLockTimeoutMs(): number {
  return readLockDuration(
    'ORIZU_CREDENTIALS_LOCK_TIMEOUT_MS',
    DEFAULT_CREDENTIALS_LOCK_TIMEOUT_MS,
    MAX_CREDENTIALS_LOCK_TIMEOUT_MS
  )
}

export function credentialsLockTimeoutError(timeoutMs: number): Error {
  return new Error(
    `ORIZU_CREDENTIALS_LOCK_TIMEOUT: credentials mutation did not acquire the lock within ${timeoutMs}ms. Verify no Orizu process is running, then remove credentials.json.lock manually.`
  )
}

/**
 * One try at the cross-process lock. Returns null when another owner holds
 * it. The waits between tries belong to the caller: a blocking one below for
 * synchronous writers, an Effect sleep in credentials-transaction.ts.
 */
export function tryAcquireCredentialsLock(): HeldCredentialsLock | null {
  const dir = getConfigDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)

  const lockPath = getCredentialsLockPath()
  const metadata = JSON.stringify({
    version: 1,
    pid: process.pid,
    hostname: hostname(),
    createdAt: Date.now(),
    instanceId: randomBytes(16).toString('hex'),
  } satisfies CredentialsLockMetadata)
  const tempPath = join(
    dir,
    `.credentials.json.lock.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  )

  try {
    const fd = openSync(tempPath, 'wx', 0o600)
    try {
      writeFileSync(fd, metadata, 'utf8')
      fsyncSync(fd)
      chmodSync(tempPath, 0o600)
    } finally {
      closeSync(fd)
    }

    try {
      // link(2) publishes the already-complete inode without replacing an
      // existing owner. No contender ever unlinks the canonical lock.
      linkSync(tempPath, lockPath)
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') return null
      throw error
    }

    let resolveReleased = () => {}
    const released = new Promise<void>(resolve => { resolveReleased = resolve })
    return { path: lockPath, metadata, depth: 1, released, resolveReleased }
  } finally {
    // The unique owner-only preparation link is never retained, whether
    // publication succeeds, loses to an owner, or fails unexpectedly.
    rmSync(tempPath, { force: true })
  }
}

/** Blocks the process between tries; only for synchronous writers. */
function acquireCredentialsLock(): HeldCredentialsLock {
  const timeoutMs = credentialsLockTimeoutMs()
  const deadline = Date.now() + timeoutMs
  while (true) {
    const lock = tryAcquireCredentialsLock()
    if (lock) return lock
    if (Date.now() >= deadline) throw credentialsLockTimeoutError(timeoutMs)
    sleepSync(Math.min(CREDENTIALS_LOCK_RETRY_MS, Math.max(1, deadline - Date.now())))
  }
}

export function releaseCredentialsLock(lock: HeldCredentialsLock): void {
  let currentMetadata: string
  try {
    currentMetadata = readFileSync(lock.path, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return
    throw error
  }
  // Preserve a changed/replaced lock rather than risking removal of another owner.
  if (currentMetadata !== lock.metadata) return
  rmSync(lock.path)
}

/**
 * Runs a synchronous credentials transaction under the one process-wide and
 * cross-process lock. Exported so real-process fixtures can hold the production
 * lock; CLI credential mutations use this same helper.
 */
export function withCredentialsTransactionLock<T>(operation: () => T): T {
  const lockPath = getCredentialsLockPath()
  if (heldCredentialsLock) {
    if (heldCredentialsLock.path !== lockPath) {
      throw new Error('ORIZU_CREDENTIALS_LOCK_NESTED_CONFIG: credentials config changed during a mutation.')
    }
    if (
      heldCredentialsLock.asyncOwner
      && credentialsTransactionOwner.getStore() !== heldCredentialsLock.asyncOwner
    ) {
      throw new Error('ORIZU_CREDENTIALS_LOCK_REQUIRED: an asynchronous credentials transaction already owns the lock.')
    }
    heldCredentialsLock.depth += 1
    try {
      return operation()
    } finally {
      heldCredentialsLock.depth -= 1
    }
  }

  const lock = acquireCredentialsLock()
  heldCredentialsLock = lock
  let failed = false
  try {
    return operation()
  } catch (error) {
    failed = true
    throw error
  } finally {
    heldCredentialsLock = null
    endTransaction(lock, failed)
  }
}

/** Release the lock if it is still ours. A release error never hides the transaction's own error. */
function endTransaction(lock: HeldCredentialsLock, failed: boolean): void {
  try {
    releaseCredentialsLock(lock)
  } catch (releaseError) {
    if (!failed) throw releaseError
  } finally {
    lock.resolveReleased()
  }
}

/**
 * Holds the credentials lock until an awaited transaction settles. Nested
 * synchronous credential writes are admitted only from this transaction's
 * async execution context; unrelated same-process work must wait or fail.
 */
export async function withCredentialsTransactionLockAsync<T>(
  operation: () => Promise<T>,
  // How to wait for the cross-process lock. The default blocks the process
  // between tries; stored-login commands pass credentials-transaction.ts's.
  acquire: () => HeldCredentialsLock | Promise<HeldCredentialsLock> = acquireCredentialsLock
): Promise<T> {
  const lockPath = getCredentialsLockPath()
  const currentOwner = credentialsTransactionOwner.getStore()
  if (heldCredentialsLock) {
    if (heldCredentialsLock.path !== lockPath) {
      throw new Error('ORIZU_CREDENTIALS_LOCK_NESTED_CONFIG: credentials config changed during a mutation.')
    }
    if (heldCredentialsLock.asyncOwner === currentOwner && currentOwner) {
      heldCredentialsLock.depth += 1
      try {
        return await operation()
      } finally {
        heldCredentialsLock.depth -= 1
      }
    }

    const timeoutMs = credentialsLockTimeoutMs()
    let timer: ReturnType<typeof setTimeout> | undefined
    const didRelease = await Promise.race([
      heldCredentialsLock.released.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) }),
    ])
    if (timer) clearTimeout(timer)
    if (!didRelease) throw credentialsLockTimeoutError(timeoutMs)
    return await withCredentialsTransactionLockAsync(operation, acquire)
  }

  const lock = await acquire()
  const owner = Symbol('credentials-transaction-owner')
  lock.asyncOwner = owner
  heldCredentialsLock = lock
  let failed = false
  try {
    return await credentialsTransactionOwner.run(owner, operation)
  } catch (error) {
    failed = true
    throw error
  } finally {
    heldCredentialsLock = null
    endTransaction(lock, failed)
  }
}

function assertCredentialsLockHeld(): void {
  if (!heldCredentialsLock || heldCredentialsLock.path !== getCredentialsLockPath()) {
    throw new Error('ORIZU_CREDENTIALS_LOCK_REQUIRED: credentials writes require a transaction lock.')
  }
}

function isStoredCredentialsV2(value: unknown): value is StoredCredentialsV2 {
  if (!value || typeof value !== 'object') {
    return false
  }

  const typed = value as Partial<StoredCredentialsV2>
  return typed.version === 2 && !!typed.servers && typeof typed.servers === 'object'
}

function isStoredCredentialsV3(value: unknown): value is StoredCredentialsV3 {
  if (!value || typeof value !== 'object') {
    return false
  }

  const typed = value as Partial<StoredCredentialsV3>
  return typed.version === 3 && !!typed.servers && typeof typed.servers === 'object'
}

function isStoredCredentialsV1(value: unknown): value is StoredCredentialsV1 {
  if (!value || typeof value !== 'object') {
    return false
  }

  const typed = value as Partial<StoredCredentialsV1>
  return (
    typeof typed.baseUrl === 'string' &&
    typeof typed.accessToken === 'string' &&
    typeof typed.refreshToken === 'string' &&
    typeof typed.expiresAt === 'number'
  )
}

function migrateToV2(stored: StoredCredentialsV1): StoredCredentialsV2 {
  return {
    version: 2,
    activeBaseUrl: stored.baseUrl,
    servers: {
      [stored.baseUrl]: {
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken,
        expiresAt: stored.expiresAt,
      },
    },
  }
}

function writeCredentials(config: StoredCredentialsV2 | StoredCredentialsV3) {
  assertCredentialsLockHeld()
  const dir = getConfigDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)

  const path = getCredentialsPath()
  const tempPath = join(
    dir,
    `.credentials.json.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  )
  const payload = JSON.stringify(config, null, 2) + '\n'

  try {
    try {
      const fd = openSync(tempPath, 'wx', 0o600)
      try {
        writeFileSync(fd, payload, 'utf-8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }

      chmodSync(tempPath, 0o600)
      // Never delete the destination to emulate replacement. If this platform
      // cannot atomically replace it, preserve the old file and surface the error.
      renameSync(tempPath, path)
    } catch (error) {
      // Until the rename succeeds the saved file is untouched.
      throw new Error(
        `ORIZU_CREDENTIALS_WRITE_FAILED: could not save sign-ins to ${path} (${errorCode(error)}). The saved file is unchanged.`,
        { cause: error }
      )
    }
    chmodSync(path, 0o600)
  } finally {
    // On success rename has already removed this path; on every error this
    // removes the owner-only temporary file containing credential material.
    rmSync(tempPath, { force: true })
  }
}

function createEmptyCredentialsConfig(): StoredCredentialsV3 {
  return {
    version: 3 as const,
    activeBaseUrl: null,
    servers: {},
  }
}

// A missing file, invalid JSON or an unknown format start empty (the "log in
// again" recovery). A file that exists but cannot be read is never replaced:
// that would delete every other saved sign-in.
function loadCredentialsConfigForWrite(): StoredCredentialsV2 | StoredCredentialsV3 {
  try {
    return loadCredentialsConfig() || createEmptyCredentialsConfig()
  } catch (error) {
    throw new Error(
      `ORIZU_CREDENTIALS_READ_FAILED: could not read ${getCredentialsPath()} (${errorCode(error)}). Saved sign-ins were not changed. Move it aside, then run \`orizu login\` again.`,
      { cause: error }
    )
  }
}

export function loadCredentialsConfig(): StoredCredentialsV2 | StoredCredentialsV3 | null {
  const path = getCredentialsPath()
  if (!existsSync(path)) {
    return null
  }

  const raw = readFileSync(path, 'utf-8')

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn('Warning: credentials file contains invalid JSON — please re-login with `orizu login`')
    return null
  }

  if (isStoredCredentialsV3(parsed)) {
    return parsed
  }

  if (isStoredCredentialsV2(parsed)) {
    return parsed
  }

  if (isStoredCredentialsV1(parsed)) {
    return migrateToV2(parsed)
  }

  console.warn('Warning: credentials file has unrecognized format — please re-login with `orizu login`')
  return null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * A saved sign-in this CLI can use: a session (it has an access token) or an
 * API key. Plain code, not Effect Schema: this file is loaded by every
 * command, including hosted sessions signed with ORIZU_TOKEN, which must never
 * load Effect.
 */
function isServerCredentials(value: unknown): value is ServerCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  if ('accessToken' in entry) {
    return isNonEmptyString(entry.accessToken)
      && isNonEmptyString(entry.refreshToken)
      && typeof entry.expiresAt === 'number'
      && Number.isFinite(entry.expiresAt)
  }
  return isNonEmptyString(entry.apiKey)
}

const warnedUnreadableServers = new Set<string>()

export function getServerCredentials(baseUrl: string): ServerCredentials | null {
  const config = loadCredentialsConfig()
  if (!config) {
    return null
  }

  if (!Object.hasOwn(config.servers, baseUrl)) {
    return null
  }

  const entry: unknown = config.servers[baseUrl]
  if (entry === null || entry === undefined) return null
  if (!isServerCredentials(entry)) {
    // Never the value: a hand-edited file may hold a token here (ORI-2675).
    if (!warnedUnreadableServers.has(baseUrl)) {
      warnedUnreadableServers.add(baseUrl)
      console.warn(
        `Warning: the saved sign-in for ${baseUrl} is not in a format this CLI understands. Run \`orizu login --server ${baseUrl}\` to replace it, or \`orizu logout --server ${baseUrl}\` to remove it.`
      )
    }
    return null
  }
  return entry
}

export function saveServerCredentials(baseUrl: string, credentials: ServerCredentials) {
  return withCredentialsTransactionLock(() => {
    const loaded = loadCredentialsConfigForWrite()
    const config: StoredCredentialsV3 = loaded.version === 3
      ? loaded
      : {
        version: 3,
        activeBaseUrl: loaded.activeBaseUrl,
        servers: loaded.servers,
      }

    config.servers[baseUrl] = credentials
    config.activeBaseUrl = baseUrl
    writeCredentials(config)
  })
}

export function credentialsEqual(left: ServerCredentials, right: ServerCredentials): boolean {
  // Entries read straight from the file may be malformed; those never match.
  if (!isServerCredentials(left) || !isServerCredentials(right)) return false
  if ('apiKey' in left || 'apiKey' in right) {
    return 'apiKey' in left && 'apiKey' in right && left.apiKey === right.apiKey
  }
  return left.accessToken === right.accessToken
    && left.refreshToken === right.refreshToken
    && left.expiresAt === right.expiresAt
}

export function updateServerCredentialsIfCurrent(
  baseUrl: string,
  expected: ServerCredentials,
  replacement: ServerCredentials
): boolean {
  return withCredentialsTransactionLock(() => {
    const config = loadCredentialsConfig()
    const current = config?.servers[baseUrl]
    if (!config || !current || !credentialsEqual(current, expected)) return false

    config.servers[baseUrl] = replacement
    writeCredentials(config)
    return true
  })
}

function isServerAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    normalizeBaseUrl(value)
    return true
  } catch {
    return false
  }
}

// Never the value: the "Invalid server URL" error would print it (ORI-2675).
// No fallback to the default server either: with an app.orizu.ai sign-in
// saved, that would run the command as a different account.
function unreadableActiveServerError(): Error {
  return new Error('The saved server in credentials.json isn\'t a valid address. Run `orizu login --server <url>`.')
}

export function getActiveBaseUrl(): string | null {
  const config = loadCredentialsConfig()
  const active: unknown = config?.activeBaseUrl
  if (active === null || active === undefined || active === '') return null
  if (isServerAddress(active)) return active
  throw unreadableActiveServerError()
}

/** Resolve the selected server and move a retired production credential atomically. */
export function resolveCredentialServer(selected?: string): string | null {
  const source = selected ?? getActiveBaseUrl()
  if (!source) return null
  const target = canonicalServerUrl(source)
  if (normalizeBaseUrl(source) === target) return target
  const snapshot = loadCredentialsConfig()
  // Explicit legacy env/flags are common in hosted processes. Once migrated,
  // resolution is read-only: do not create a config directory or contend on a lock.
  if (!snapshot?.servers[source] && snapshot?.activeBaseUrl !== source) return target

  return withCredentialsTransactionLock(() => {
    const config = loadCredentialsConfig()
    // Another process may have selected a different server while we waited.
    const storedSource: unknown = config?.activeBaseUrl
    if (!selected && storedSource !== null && storedSource !== undefined && storedSource !== '' && !isServerAddress(storedSource)) {
      throw unreadableActiveServerError()
    }
    const currentSource = selected ?? (isServerAddress(storedSource) ? storedSource : null)
    if (!currentSource) return null
    const currentTarget = canonicalServerUrl(currentSource)
    if (!config || normalizeBaseUrl(currentSource) === currentTarget) return currentTarget
    const credential = config.servers[currentSource]
    const destination = config.servers[currentTarget]
    if (credential && destination && !credentialsEqual(credential, destination)) {
      throw new Error(
        'A different sign-in is already saved for app.orizu.ai. Run `orizu --server https://app.orizu.ai logout` to remove it, or `orizu --server https://app.orizu.ai login` to sign in again. Plain `orizu logout` removes the selected old sign-in instead. No saved sign-ins were changed.'
      )
    }
    let changed = false
    if (credential) {
      config.servers[currentTarget] = credential
      delete config.servers[currentSource]
      changed = true
    }
    if (config.activeBaseUrl === currentSource) {
      config.activeBaseUrl = currentTarget
      changed = true
    }
    if (changed) writeCredentials(config)
    return currentTarget
  })
}

const secretsSeenThisProcess = new Set<string>()

export function rememberProcessSecret(secret: string): string {
  secretsSeenThisProcess.add(secret)
  return secret
}

export function rememberResolvedBearer(bearer: string): string {
  return rememberProcessSecret(bearer)
}

export function getSecretsSeenThisProcess(): readonly string[] {
  return [...secretsSeenThisProcess]
}

/**
 * In-sandbox bearer resolution (ALI-1044). Resolves a bearer supplied out-of-band
 * to the hosted agent, WITHOUT consulting credentials.json:
 *   1. `ORIZU_TOKEN` — an explicit bearer in the environment (wins if present).
 *   2. `ORIZU_TOKEN_FILE` — an absolute path to a 0600 file whose TRIMMED contents
 *      are the bearer.
 * Returns null when neither is set, so callers fall through to credentials.json.
 *
 * The token file is read FRESH on EVERY call and never cached: the hosted loop
 * ROTATES the file underneath a long-lived agent process, so caching the value
 * would pin a stale (soon-expired) bearer. The token is never logged, echoed, or
 * passed via argv — only returned to the caller for a single request's header.
 *
 * A set-but-unreadable/empty `ORIZU_TOKEN_FILE` throws a clear error rather than
 * returning null, so a misconfigured sandbox fails loudly instead of silently
 * falling back to (absent) credentials.json and emitting a confusing "not logged
 * in" message.
 */
export function resolveEnvBearerToken(): string | null {
  const explicit = process.env.ORIZU_TOKEN
  if (explicit && explicit.trim()) {
    return rememberResolvedBearer(explicit.trim())
  }

  const tokenFile = process.env.ORIZU_TOKEN_FILE
  if (tokenFile && tokenFile.length > 0) {
    if (!existsSync(tokenFile)) {
      throw new Error(`ORIZU_TOKEN_FILE is set to ${tokenFile} but no such file exists.`)
    }
    let raw: string
    try {
      raw = readFileSync(tokenFile, 'utf8')
    } catch (error) {
      const detail = isNodeError(error) ? error.message : String(error)
      throw new Error(`Failed to read ORIZU_TOKEN_FILE (${tokenFile}): ${detail}`)
    }
    const token = raw.trim()
    if (!token) {
      throw new Error(`ORIZU_TOKEN_FILE (${tokenFile}) is empty.`)
    }
    return rememberResolvedBearer(token)
  }

  return null
}

/**
 * THE uniform bearer resolution for every CLI command (ALI-1090). Exactly the
 * order `authedFetch` uses: `ORIZU_TOKEN` env → `ORIZU_TOKEN_FILE` (both via
 * resolveEnvBearerToken, read FRESH per call — never cached, so hosted token
 * rotations are picked up) → stored credentials.json. Commands that need a raw
 * bearer (`orizu env`, the run-gepa wrapper) MUST use this instead of reading
 * credentials.json directly, or they break in hosted sandboxes that are
 * pre-authenticated via ORIZU_TOKEN_FILE and never ran `orizu login`.
 */
export function resolveAuthTokenForBaseUrl(baseUrl: string): string {
  const envBearer = resolveEnvBearerToken()
  if (envBearer) {
    return envBearer
  }

  const credentials = getServerCredentials(baseUrl)
  if (!credentials) {
    throw new Error(`Not logged in for ${baseUrl}. Run \`orizu login --server ${baseUrl}\` (or \`--local\`) first.`)
  }

  return rememberResolvedBearer(
    'accessToken' in credentials ? credentials.accessToken : credentials.apiKey
  )
}

/**
 * Non-throwing "is any auth available?" check (login --no-prompt-if-logged-in,
 * setup status). Mirrors resolveAuthTokenForBaseUrl's order so an env bearer
 * counts as signed in. A misconfigured ORIZU_TOKEN_FILE reports false here —
 * actual requests still fail loudly via resolveEnvBearerToken.
 */
export function hasResolvableAuth(baseUrl: string): boolean {
  try {
    if (resolveEnvBearerToken()) {
      return true
    }
  } catch {
    // fall through to stored credentials
  }
  return getServerCredentials(baseUrl) !== null
}

export function clearServerCredentialsIfCurrent(
  baseUrl: string,
  expected: ServerCredentials
): boolean {
  return withCredentialsTransactionLock(() => {
    const config = loadCredentialsConfig()
    const current = config?.servers[baseUrl]
    if (!config || !current || !credentialsEqual(current, expected)) return false

    delete config.servers[baseUrl]
    if (config.activeBaseUrl === baseUrl) config.activeBaseUrl = null
    writeCredentials(config)
    return true
  })
}

export function clearServerCredentials(baseUrl: string): boolean {
  return withCredentialsTransactionLock(() => {
    const config = loadCredentialsConfig()
    if (!config || !Object.hasOwn(config.servers, baseUrl)) {
      return false
    }

    delete config.servers[baseUrl]
    if (config.activeBaseUrl === baseUrl) {
      config.activeBaseUrl = null
    }
    writeCredentials(config)
    return true
  })
}

/**
 * Remove a saved sign-in this CLI cannot read (it may be a pasted token).
 * Returns false when there is none, or when it has become readable since.
 */
export function clearUnreadableServerCredentials(baseUrl: string): boolean {
  return withCredentialsTransactionLock(() => {
    const config = loadCredentialsConfig()
    if (!config || !Object.hasOwn(config.servers, baseUrl)) return false
    const entry: unknown = config.servers[baseUrl]
    if (entry === null || entry === undefined || isServerCredentials(entry)) return false

    delete config.servers[baseUrl]
    if (config.activeBaseUrl === baseUrl) config.activeBaseUrl = null
    writeCredentials(config)
    return true
  })
}

export function clearCredentialsFile() {
  return withCredentialsTransactionLock(() => {
    const path = getCredentialsPath()
    if (existsSync(path)) rmSync(path)
  })
}
