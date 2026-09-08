import { spawn } from 'node:child_process'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Writable } from 'node:stream'

const ARTIFACT_TOKEN_BODY = /^[^\s\u0000-\u001f\u007f]{16,1024}$/
const ARTIFACT_TOKEN_ADVISORY_SUFFIX = '?expires='
const ARTIFACT_TOKEN_BARE_BODY = /art_v1_[0-9a-fA-F]{40}/
const DEFAULT_GIT_TIMEOUT_MS = 30_000
const GIT_TERMINATION_GRACE_MS = 1_000
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
    IFS= read -r password <&3 || exit 1
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

export const defaultGitRunner: GitRunner = (
  args,
  { cwd, auth, env: suppliedEnv, commitIdentityEnv, timeoutMs = DEFAULT_GIT_TIMEOUT_MS, signal }
) =>
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
      ? buildGitAuthEnvironment(auth, suppliedEnv)
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
      stdio: auth ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
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

    if (auth) {
      const credentialPipe = child.stdio[3] as Writable | null
      if (!credentialPipe) {
        fail(new Error('Could not establish one-use Git credential pipe'))
        return
      }
      credentialPipe.on('error', () => {
        /* EPIPE if Git fails before auth. */
      })
      if (termination) {
        credentialPipe.destroy()
        return
      }
      try {
        credentialPipe.end(`${auth.token}\n`)
      } catch (error) {
        fail(
          error instanceof Error ? error : new Error('Could not write the one-use Git credential')
        )
      }
    }
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
