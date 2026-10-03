import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ARTIFACT_TOKEN_BODY = /^[^\s\u0000-\u001f\u007f]{16,1024}$/
const ARTIFACT_TOKEN_ADVISORY_SUFFIX = '?expires='
const ARTIFACT_TOKEN_BARE_BODY = /art_v1_[0-9a-fA-F]{40}/
const DEFAULT_GIT_TIMEOUT_MS = 30_000
const GIT_TERMINATION_GRACE_MS = 1_000
/** Names the one-use key file, set on the git process that needs it and nowhere else. */
const GIT_KEY_FILE_ENV = 'ORIZU_GIT_KEY_FILE'
const GIT_CONTEXT_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
] as const
const GIT_CHILD_ENV_ALLOWLIST = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'LANG',
  'TZ',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
] as const
const COMMIT_IDENTITY_ENV_PATTERN = /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/

export interface GitCommandResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut?: boolean
  cancelled?: boolean
}

export interface GitAuth {
  askPassPath: string
  token: string
}

export interface GitRunOptions {
  cwd: string
  auth?: GitAuth
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  signal?: AbortSignal
  commitIdentityEnv?: Readonly<Record<string, string>>
}

export type GitRunner = (args: string[], options: GitRunOptions) => Promise<GitCommandResult>

export function assertCommitIdentityEnv(overlay: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(overlay)) {
    if (!COMMIT_IDENTITY_ENV_PATTERN.test(key)) {
      throw new Error(
        `Refusing Git environment overlay ${JSON.stringify(key)}: only ` +
          'GIT_AUTHOR_/GIT_COMMITTER_ NAME, EMAIL and DATE may be set'
      )
    }
  }
}

export function parseArtifactTokenExpiry(token: string): number | null {
  const separator = token.lastIndexOf(ARTIFACT_TOKEN_ADVISORY_SUFFIX)
  if (separator !== -1) {
    const body = token.slice(0, separator)
    const suffix = token.slice(separator + ARTIFACT_TOKEN_ADVISORY_SUFFIX.length)
    if (!ARTIFACT_TOKEN_BODY.test(body) || !/^\d{1,15}$/.test(suffix)) {
      throw new Error('Artifacts returned an unexpected token format')
    }
    const expiry = Number(suffix)
    if (!Number.isSafeInteger(expiry)) {
      throw new Error('Artifacts returned an invalid token expiry')
    }
    return expiry
  }
  if (!ARTIFACT_TOKEN_BODY.test(token)) {
    throw new Error('Artifacts returned an unexpected token format')
  }
  return null
}

export function credentialSecretVariants(secrets: readonly (string | undefined)[]): string[] {
  const variants = new Set<string>()
  for (const secret of secrets) {
    if (!secret) continue
    variants.add(secret)
    const bareBody = ARTIFACT_TOKEN_BARE_BODY.exec(secret)?.[0]
    if (bareBody) variants.add(bareBody)
  }
  return [...variants]
}

export function redactSecrets(value: string, secrets: readonly (string | undefined)[]): string {
  return credentialSecretVariants(secrets)
    .filter((secret) => secret.length >= 4)
    .sort((left, right) => right.length - left.length)
    .reduce((redacted, secret) => redacted.split(secret).join('[REDACTED]'), value)
}

export async function createEphemeralAskPass(
  root: string
): Promise<{ path: string; dispose: () => Promise<void> }> {
  const authDir = join(root, 'git-auth')
  await mkdir(authDir, { recursive: true, mode: 0o700 })
  await chmod(authDir, 0o700)
  const path = join(authDir, 'askpass.sh')
  const script = `#!/bin/sh
case "$1" in
  *sername*) printf '%s\\n' x ;;
  *assword*)
    [ -n "$${GIT_KEY_FILE_ENV}" ] || exit 1
    IFS= read -r password < "$${GIT_KEY_FILE_ENV}" || exit 1
    [ -n "$password" ] || exit 1
    printf '%s\\n' "$password"
    ;;
  *) exit 1 ;;
esac
`
  await writeFile(path, script, { mode: 0o700 })
  await chmod(path, 0o700)
  return {
    path,
    dispose: () => rm(authDir, { recursive: true, force: true }),
  }
}

function minimalGitChildEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = { NODE_ENV: base.NODE_ENV }
  for (const key of GIT_CHILD_ENV_ALLOWLIST) {
    if (base[key] !== undefined) selected[key] = base[key]
  }
  return selected
}

export function buildGitAuthEnvironment(
  auth: GitAuth,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  parseArtifactTokenExpiry(auth.token)
  const env: NodeJS.ProcessEnv = {
    ...minimalGitChildEnvironment(base),
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: auth.askPassPath,
    GIT_ASKPASS_REQUIRE: 'force',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.useHttpPath',
    GIT_CONFIG_VALUE_1: 'true',
  }
  for (const key of GIT_CONTEXT_ENV_KEYS) delete env[key]
  return env
}

function buildUnauthenticatedGitEnvironment(
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...minimalGitChildEnvironment(base),
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  }
  for (const key of GIT_CONTEXT_ENV_KEYS) delete env[key]
  return env
}

export function assertSafeGitInvocation(
  args: readonly string[],
  secrets: readonly string[] = []
): void {
  const joined = args.join('\u0000')
  for (const secret of credentialSecretVariants(secrets)) {
    if (joined.includes(secret)) throw new Error('Refusing to place a credential in Git argv')
  }
  for (const arg of args) {
    if (!/^https?:\/\//i.test(arg)) continue
    const url = new URL(arg)
    if (url.username || url.password) {
      throw new Error('Refusing a Git remote URL containing userinfo')
    }
  }
}

function signalGitProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // The process may have exited between the state check and the signal.
  }
}

/** Key folders this process holds right now. An abrupt end of the process
 * skips the runner's own cleanup, so they are also removed, best effort, on
 * exit, and on a termination signal that ends the process. A script that
 * handles the signal itself keeps its keys: its running command may still need
 * them, and the exit listener covers it later. SIGKILL cannot be caught: a
 * folder it leaves behind holds a key that still expires on its own. */
const liveKeyDirs = new Set<string>()
let isExitCleanupInstalled = false
// SIGHUP and SIGQUIT run no exit handlers either; operator scripts run over SSH.
const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const

function removeLiveKeyDirs(): void {
  for (const dir of liveKeyDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best effort: the process is ending.
    }
  }
  liveKeyDirs.clear()
}

function handleTerminationSignal(signal: NodeJS.Signals): void {
  // Another listener decides whether the process ends; leave the keys to it.
  if (process.listenerCount(signal) !== 1) return
  removeLiveKeyDirs()
  // End the way the signal would have without this listener.
  process.off(signal, handleTerminationSignal)
  process.kill(process.pid, signal)
}

function installExitCleanup(): void {
  if (isExitCleanupInstalled) return
  isExitCleanupInstalled = true
  process.on('exit', removeLiveKeyDirs)
  for (const signal of TERMINATION_SIGNALS) process.on(signal, handleTerminationSignal)
}

/** Runs one git command. With auth, the key goes in a 0600 file inside a
 * fresh 0700 folder, named to that git process only by ORIZU_GIT_KEY_FILE.
 * Askpass reads it from there. The folder is removed when the command
 * settles, however it ends: success, failure, timeout or cancel; and if this
 * process ends first, on its way out (see liveKeyDirs). */
export const defaultGitRunner: GitRunner = async (args, options) => {
  if (!options.auth) return runGitProcess(args, options, null)
  installExitCleanup()
  const keyDir = await mkdtemp(join(tmpdir(), 'orizu-git-key-'))
  liveKeyDirs.add(keyDir)
  try {
    await chmod(keyDir, 0o700)
    const keyFile = join(keyDir, 'key')
    await writeFile(keyFile, `${options.auth.token}\n`, { mode: 0o600, flag: 'wx' })
    return await runGitProcess(args, options, keyFile)
  } finally {
    await rm(keyDir, { recursive: true, force: true })
    liveKeyDirs.delete(keyDir)
  }
}

const runGitProcess = (
  args: string[],
  { cwd, auth, env: suppliedEnv, commitIdentityEnv, timeoutMs = DEFAULT_GIT_TIMEOUT_MS, signal }: GitRunOptions,
  keyFile: string | null
): Promise<GitCommandResult> =>
  new Promise((resolve, reject) => {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      reject(new Error('Git timeout must be a positive integer'))
      return
    }
    const secrets = auth ? [auth.token] : []
    assertSafeGitInvocation(args, secrets)
    if (signal?.aborted) {
      resolve({
        exitCode: 130,
        stdout: '',
        stderr: 'Git operation cancelled',
        cancelled: true,
      })
      return
    }
    const baseEnv = auth
      ? { ...buildGitAuthEnvironment(auth, suppliedEnv), ...(keyFile ? { [GIT_KEY_FILE_ENV]: keyFile } : {}) }
      : buildUnauthenticatedGitEnvironment(suppliedEnv)
    let env = baseEnv
    if (commitIdentityEnv) {
      assertCommitIdentityEnv(commitIdentityEnv)
      env = { ...baseEnv, ...commitIdentityEnv }
    }
    const spawnArgs = auth ? ['-c', 'core.hooksPath=/dev/null', ...args] : args
    const child = spawn('git', spawnArgs, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let termination: 'timeout' | 'cancelled' | null = null
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | null = null
    let hardStopTimer: ReturnType<typeof setTimeout> | null = null
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      if (hardStopTimer) clearTimeout(hardStopTimer)
      signal?.removeEventListener('abort', cancel)
    }
    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        exitCode,
        stdout: redactSecrets(stdout, secrets),
        stderr: redactSecrets(stderr, secrets),
        timedOut: termination === 'timeout' || undefined,
        cancelled: termination === 'cancelled' || undefined,
      })
    }
    const terminate = (reason: 'timeout' | 'cancelled') => {
      if (termination || settled) return
      termination = reason
      signalGitProcess(child, 'SIGTERM')
      killTimer = setTimeout(() => signalGitProcess(child, 'SIGKILL'), GIT_TERMINATION_GRACE_MS)
      killTimer.unref?.()
      hardStopTimer = setTimeout(
        () => finish(reason === 'timeout' ? 124 : 130),
        GIT_TERMINATION_GRACE_MS * 2
      )
      hardStopTimer.unref?.()
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      signalGitProcess(child, 'SIGKILL')
      reject(error)
    }
    const cancel = () => terminate('cancelled')
    timeoutTimer = setTimeout(() => terminate('timeout'), timeoutMs)
    timeoutTimer.unref?.()
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()

    const childStdout = child.stdout
    const childStderr = child.stderr
    if (!childStdout || !childStderr) {
      fail(new Error('Could not capture Git process output'))
      return
    }
    childStdout.setEncoding('utf8')
    childStderr.setEncoding('utf8')
    childStdout.on('data', (chunk) => {
      stdout += chunk
    })
    childStderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      if (termination) {
        finish(termination === 'timeout' ? 124 : 130)
        return
      }
      fail(error)
    })
    child.on('close', (code) => {
      finish(termination === 'timeout' ? 124 : termination === 'cancelled' ? 130 : (code ?? 1))
    })
  })

export async function gitOk(
  runGit: GitRunner,
  args: string[],
  options: GitRunOptions,
  operation: string
): Promise<string> {
  const result = await runGit(args, options)
  if (result.timedOut) throw new Error(`${operation} timed out`)
  if (result.cancelled) throw new Error(`${operation} cancelled`)
  if (result.exitCode !== 0) {
    const secrets = options.auth ? [options.auth.token] : []
    const detail = redactSecrets((result.stderr || result.stdout).trim(), secrets)
    throw new Error(detail ? `${operation} failed: ${detail}` : `${operation} failed`)
  }
  return result.stdout.trim()
}

export async function revParse(runGit: GitRunner, cwd: string, ref: string): Promise<string> {
  return gitOk(runGit, ['rev-parse', '--verify', ref], { cwd }, `resolve ${ref}`)
}
