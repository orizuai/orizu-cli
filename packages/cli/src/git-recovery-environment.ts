import { isAbsolute } from 'node:path'

export type RecoveryGitProtocol = 'file' | 'https'

export interface RecoveryCredentialHelperInvocation {
  /**
   * Trusted worker-installed helper. Secrets are never arguments: the helper
   * resolves the exact operation/repository through the broker at invocation
   * time and returns a one-use credential over Git's stdin/stdout protocol.
   */
  executablePath: string
  arguments?: readonly string[]
}

export interface HardenedGitEnvironmentInput {
  homeDir: string
  hooksDir: string
  tempDir?: string
  allowedProtocols?: readonly RecoveryGitProtocol[]
  credentialHelper?: RecoveryCredentialHelperInvocation
  sourceEnv?: NodeJS.ProcessEnv
}

interface GitEnvironmentConfig {
  key: string
  value: string
}

function assertAbsoluteDirectoryPath(value: string, label: string): void {
  if (
    !isAbsolute(value) ||
    value.includes('\u0000') ||
    /[\r\n]/.test(value)
  ) {
    throw new Error(`${label} must be an absolute path without control characters`)
  }
}

function normalizeProtocols(
  protocols: readonly RecoveryGitProtocol[] | undefined
): RecoveryGitProtocol[] {
  const requested = protocols ?? ['https']
  for (const protocol of requested) {
    if (protocol !== 'https' && protocol !== 'file') {
      throw new Error(`unsupported Git recovery protocol: ${String(protocol)}`)
    }
  }
  const requestedSet = new Set(requested)
  const normalized = (['https', 'file'] as const).filter(protocol =>
    requestedSet.has(protocol)
  )
  if (normalized.length === 0 || !normalized.includes('https')) {
    throw new Error('the hardened Git environment must allow HTTPS transport')
  }
  return normalized
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function credentialHelperConfigValue(
  helper: RecoveryCredentialHelperInvocation | undefined
): string {
  if (helper === undefined) return ''
  if (!isAbsolute(helper.executablePath)) {
    throw new Error('recovery credential helper requires an absolute executable path')
  }
  const values = [helper.executablePath, ...(helper.arguments ?? [])]
  for (const value of values) {
    if (
      value.length === 0 ||
      Buffer.byteLength(value, 'utf8') > 4_096 ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new Error(
        'recovery credential helper path and arguments must be non-empty, bounded, and control-free'
      )
    }
  }
  return `!exec ${values.map(shellQuote).join(' ')}`
}

function gitConfig(
  hooksDir: string,
  allowedProtocols: readonly RecoveryGitProtocol[],
  credentialHelper: RecoveryCredentialHelperInvocation | undefined
): GitEnvironmentConfig[] {
  const fileAllowed = allowedProtocols.includes('file') ? 'always' : 'never'
  return [
    { key: 'credential.helper', value: credentialHelperConfigValue(credentialHelper) },
    { key: 'credential.useHttpPath', value: 'true' },
    { key: 'core.hooksPath', value: hooksDir },
    { key: 'core.attributesFile', value: '/dev/null' },
    { key: 'core.fsmonitor', value: 'false' },
    { key: 'core.sshCommand', value: '/usr/bin/false' },
    { key: 'protocol.allow', value: 'never' },
    { key: 'protocol.version', value: '2' },
    { key: 'protocol.https.allow', value: 'always' },
    { key: 'protocol.http.allow', value: 'never' },
    { key: 'protocol.file.allow', value: fileAllowed },
    { key: 'protocol.ext.allow', value: 'never' },
    { key: 'http.followRedirects', value: 'false' },
    { key: 'http.sslVerify', value: 'true' },
    { key: 'http.saveCookies', value: 'false' },
    { key: 'fetch.fsckObjects', value: 'true' },
    { key: 'transfer.fsckObjects', value: 'true' },
    { key: 'receive.fsckObjects', value: 'true' },
    // Bound Git's own parallelism and delta caches inside the independently
    // enforced job memory/PID boundary. These only trade throughput and pack
    // compression efficiency; all object-integrity checks remain enabled.
    { key: 'pack.threads', value: '1' },
    { key: 'index.threads', value: '1' },
    { key: 'pack.windowMemory', value: '67108864' },
    { key: 'pack.deltaCacheSize', value: '67108864' },
    { key: 'core.deltaBaseCacheLimit', value: '67108864' },
    { key: 'fetch.recurseSubmodules', value: 'false' },
    { key: 'submodule.recurse', value: 'false' },
    { key: 'filter.lfs.process', value: '' },
    { key: 'filter.lfs.smudge', value: '' },
    { key: 'filter.lfs.clean', value: '' },
    { key: 'filter.lfs.required', value: 'false' },
    { key: 'maintenance.auto', value: 'false' },
    { key: 'gc.auto', value: '0' },
  ]
}

/**
 * Construct, rather than scrub, the environment. Only PATH crosses the
 * boundary from the parent process. Provider tokens, cloud credentials,
 * ambient Git repository variables, HOME config, SSH agents, and askpass
 * helpers therefore cannot accidentally enter the recovery subprocess.
 */
export function buildHardenedGitEnvironment(
  input: HardenedGitEnvironmentInput
): NodeJS.ProcessEnv {
  assertAbsoluteDirectoryPath(input.homeDir, 'Git recovery HOME')
  assertAbsoluteDirectoryPath(input.hooksDir, 'Git recovery hooks directory')
  if (input.tempDir !== undefined) {
    assertAbsoluteDirectoryPath(input.tempDir, 'Git recovery temp directory')
  }

  const allowedProtocols = normalizeProtocols(input.allowedProtocols)
  const sourceEnv = input.sourceEnv ?? process.env
  const path = sourceEnv.PATH
  if (!path || /[\u0000\r\n]/.test(path)) {
    throw new Error('Git recovery requires a safe PATH')
  }

  const config = gitConfig(input.hooksDir, allowedProtocols, input.credentialHelper)
  const env: NodeJS.ProcessEnv = {
    // Never inherit runtime mode across the recovery boundary. Git ignores
    // NODE_ENV, while an explicitly installed credential helper may not.
    NODE_ENV: 'production',
    PATH: path,
    HOME: input.homeDir,
    XDG_CONFIG_HOME: input.homeDir,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false',
    GCM_INTERACTIVE: 'Never',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ALLOW_PROTOCOL: allowedProtocols.join(':'),
    GIT_CONFIG_COUNT: String(config.length),
    ...(input.tempDir === undefined ? {} : { TMPDIR: input.tempDir }),
  }

  config.forEach(({ key, value }, index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return env
}

/**
 * Test/diagnostic helper for the non-secret `GIT_CONFIG_COUNT` contract.
 * Rejecting holes also prevents a caller from constructing an ambiguous config.
 */
export function parseConfiguredGitEnvironment(
  env: NodeJS.ProcessEnv
): Map<string, string> {
  const countText = env.GIT_CONFIG_COUNT
  if (!countText || !/^(0|[1-9][0-9]*)$/.test(countText)) {
    throw new Error('invalid GIT_CONFIG_COUNT')
  }
  const count = Number(countText)
  if (!Number.isSafeInteger(count) || count > 128) {
    throw new Error('GIT_CONFIG_COUNT exceeds the recovery configuration budget')
  }

  const parsed = new Map<string, string>()
  for (let index = 0; index < count; index += 1) {
    const key = env[`GIT_CONFIG_KEY_${index}`]
    const value = env[`GIT_CONFIG_VALUE_${index}`]
    if (key === undefined || value === undefined) {
      throw new Error(`incomplete hardened Git config at index ${index}`)
    }
    if (parsed.has(key)) {
      throw new Error(`duplicate hardened Git config key: ${key}`)
    }
    parsed.set(key, value)
  }
  return parsed
}
