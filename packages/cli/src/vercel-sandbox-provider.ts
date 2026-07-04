/**
 * Vercel Sandbox adapter for the Orizu SandboxProvider seam (ALI-928 / P3.5,
 * per ADR-003 + ADR-005). Thin adapter over `@vercel/sandbox`, mirroring the
 * Daytona adapter's shape (`createDaytonaProvider`):
 *
 *   - the SDK is imported LAZILY through a NON-LITERAL specifier so the CLI /
 *     app build resolve without the package and tests never load it;
 *   - a `loadModule` dep is injectable, so the fake-SDK unit tests exercise the
 *     request mapping (timeout, runtime, egress pass-through, extendTimeout)
 *     without the real package or a network.
 *
 * FOUNDER REQUIREMENT (locked): the sandbox `timeout` is ALWAYS set from opts
 * (session length) — the adapter NEVER lets Vercel's 5-minute default apply.
 * Default 60 min, hard cap 24 h.
 *
 * G5 (ALI-1006) owns the egress ALLOWLIST CONTENT; this adapter only plumbs the
 * `egressPolicy` option through to the Sandbox firewall (`networkPolicy`) at
 * create. The model-key credential-broker path (`buildModelKeyBrokerPolicy`,
 * G3/ALI-1004) is built on the SAME firewall seam: a per-domain request
 * transform injects the model key AT THE PROXY, so the raw key never enters the
 * sandbox (see docs/.../sandbox-secrets-policy.md §3).
 */

import type {
  ExecResult,
  GitCloneParams,
  GitPushParams,
  SandboxCreateOpts,
  SandboxEgressPolicy,
  SandboxProvider,
  SandboxSession,
} from './sandbox-provider.js'

// -- Timeout policy (founder requirement) ------------------------------------

/** Default sandbox session length when opts omit one (NEVER Vercel's 5 min). */
export const VERCEL_DEFAULT_TIMEOUT_MS = 60 * 60 * 1000
/** Hard cap on a configured session length (24 h). */
export const VERCEL_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000
/** Default runtime image when opts/config omit one. */
export const VERCEL_DEFAULT_RUNTIME = 'node24'

// -- Structural view of the @vercel/sandbox surface we touch -----------------
// Kept local (not imported) so the seam type-checks and the app build resolves
// without the package present — same discipline as the Daytona adapter.

interface VercelSdkCommandFinished {
  exitCode: number
  stdout(): Promise<string>
  stderr(): Promise<string>
}

interface VercelRunCommandParams {
  cmd: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  sudo?: boolean
}

interface VercelSdkSandbox {
  readonly sandboxId: string
  runCommand(params: VercelRunCommandParams): Promise<VercelSdkCommandFinished>
  readFileToBuffer(file: { path: string; cwd?: string }): Promise<Uint8Array | Buffer | null>
  writeFiles(files: { path: string; content: string | Uint8Array; mode?: number }[]): Promise<void>
  stop(opts?: { blocking?: boolean }): Promise<unknown>
  extendTimeout(durationMs: number): Promise<void>
  updateNetworkPolicy(policy: unknown): Promise<unknown>
}

interface VercelCreateParams {
  timeout: number
  runtime?: string
  resources?: { vcpus: number }
  ports?: number[]
  networkPolicy?: unknown
  env?: Record<string, string>
  token?: string
  projectId?: string
  teamId?: string
}

interface VercelSandboxCtor {
  create(params: VercelCreateParams): Promise<VercelSdkSandbox>
}

export interface VercelSdkModule {
  Sandbox: VercelSandboxCtor
}

// PIN CONTRACT: verified against @vercel/sandbox@1.10.2 — `Sandbox.create`
// accepts `{ timeout, runtime, resources, ports, networkPolicy, env }` plus the
// `{ token, projectId, teamId }` credential fields, and the returned Sandbox
// exposes `runCommand / readFileToBuffer / writeFiles / stop / extendTimeout /
// updateNetworkPolicy / sandboxId`. packages/cli/package.json pins this version
// EXACTLY (no caret); re-verify before bumping. The lazy `import(specifier)`
// keeps the (Node-only) SDK genuinely optional — it loads only when the Vercel
// provider is actually selected.
const VERCEL_SDK_SPECIFIER = '@vercel/sandbox'

async function loadVercelModule(): Promise<VercelSdkModule> {
  try {
    const specifier: string = VERCEL_SDK_SPECIFIER
    const mod = (await import(specifier)) as unknown as VercelSdkModule
    if (!mod || typeof mod.Sandbox?.create !== 'function') {
      throw new Error('module did not export a Sandbox class with create()')
    }
    return mod
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Vercel Sandbox SDK unavailable (${detail}). Install it before the live run: \`bun install --cwd packages/cli\` (declares @vercel/sandbox).`
    )
  }
}

// -- Auth resolution ---------------------------------------------------------

export interface VercelProviderConfig {
  /** Vercel API token; default env VERCEL_TOKEN, then VERCEL_OIDC_TOKEN. */
  token?: string
  /** Project id; default env VERCEL_PROJECT_ID. */
  projectId?: string
  /** Team id; default env VERCEL_TEAM_ID. */
  teamId?: string
  /** Default runtime image (default node24). */
  runtime?: string
  /** Default session length (ms) when createSandbox opts omit one. */
  defaultTimeoutMs?: number
  /** Hard cap on the configured session length (ms; default 24 h). */
  maxTimeoutMs?: number
}

export interface VercelProviderDeps {
  loadModule?: () => Promise<VercelSdkModule>
}

interface ResolvedCredentials {
  token?: string
  projectId?: string
  teamId?: string
}

function resolveCredentials(
  config: VercelProviderConfig,
  env: NodeJS.ProcessEnv
): ResolvedCredentials {
  return {
    token: config.token ?? env.VERCEL_TOKEN ?? env.VERCEL_OIDC_TOKEN,
    projectId: config.projectId ?? env.VERCEL_PROJECT_ID,
    teamId: config.teamId ?? env.VERCEL_TEAM_ID,
  }
}

/** True when live credentials are present (used by the env-gated smoke test). */
export function hasVercelCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  const creds = resolveCredentials({}, env)
  return Boolean(creds.token && creds.projectId && creds.teamId)
}

// The inline git credential helper: git runs the value as a shell command with
// the action appended, and it simply echoes the per-call username/password from
// the command's OWN env. No secret is written to git config or the clone URL —
// the credential lives only in the single git process's transient env, matching
// the Daytona adapter's clean per-call contract.
const GIT_USER_ENV = 'ORIZU_GIT_USER'
const GIT_PASS_ENV = 'ORIZU_GIT_PASS'
const INLINE_CRED_HELPER = `!f() { echo "username=$${GIT_USER_ENV}"; echo "password=$${GIT_PASS_ENV}"; }; f`

function credEnv(username?: string, password?: string): Record<string, string> {
  return { [GIT_USER_ENV]: username ?? 'x-access-token', [GIT_PASS_ENV]: password ?? '' }
}

function clampTimeout(requested: number | undefined, def: number, cap: number): number {
  const base = typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? requested : def
  return Math.min(Math.max(1, Math.floor(base)), cap)
}

function wrapVercelSandbox(sandbox: VercelSdkSandbox): SandboxSession {
  const runShell = async (command: string, cwd?: string): Promise<VercelSdkCommandFinished> =>
    sandbox.runCommand({ cmd: 'bash', args: ['-c', command], cwd })

  return {
    id: sandbox.sandboxId,
    async gitClone(params: GitCloneParams) {
      const args = ['-c', `credential.helper=${INLINE_CRED_HELPER}`, 'clone']
      if (params.branch) args.push('--branch', params.branch)
      args.push(params.url, params.path)
      const res = await sandbox.runCommand({ cmd: 'git', args, env: credEnv(params.username, params.password) })
      if (res.exitCode !== 0) {
        const stderr = (await res.stderr()).trim()
        throw new Error(`git clone failed: ${stderr || `exit ${res.exitCode}`}`)
      }
    },
    async gitPush(params: GitPushParams) {
      const res = await sandbox.runCommand({
        cmd: 'git',
        args: ['-C', params.path, '-c', `credential.helper=${INLINE_CRED_HELPER}`, 'push'],
        env: credEnv(params.username, params.password),
      })
      if (res.exitCode !== 0) {
        const stderr = (await res.stderr()).trim()
        throw new Error(`git push failed: ${stderr || `exit ${res.exitCode}`}`)
      }
    },
    async exec(command: string, opts?: { cwd?: string }): Promise<ExecResult> {
      const res = await runShell(command, opts?.cwd)
      const [stdout, stderr] = await Promise.all([res.stdout(), res.stderr()])
      // A missing/non-numeric exitCode is a FAILURE (1), never masked to success.
      const exitCode = typeof res.exitCode === 'number' ? res.exitCode : 1
      return { stdout, exitCode, stderr }
    },
    async readFile(path: string): Promise<string> {
      const buf = await sandbox.readFileToBuffer({ path })
      if (buf === null || buf === undefined) {
        throw new Error(`readFile: ${path} not found`)
      }
      return Buffer.from(buf).toString('utf8')
    },
    async writeFile(path: string, content: string): Promise<void> {
      await sandbox.writeFiles([{ path, content }])
    },
    async fileExists(path: string): Promise<boolean> {
      const res = await sandbox.runCommand({ cmd: 'test', args: ['-e', path] })
      return res.exitCode === 0
    },
    async destroy(): Promise<void> {
      await sandbox.stop()
    },
    async extendTimeout(durationMs: number): Promise<void> {
      await sandbox.extendTimeout(durationMs)
    },
  }
}

export function createVercelProvider(
  config: VercelProviderConfig = {},
  deps: VercelProviderDeps = {}
): SandboxProvider {
  const load = deps.loadModule ?? loadVercelModule
  const defaultTimeoutMs = config.defaultTimeoutMs ?? VERCEL_DEFAULT_TIMEOUT_MS
  const maxTimeoutMs = config.maxTimeoutMs ?? VERCEL_MAX_TIMEOUT_MS
  let modulePromise: Promise<VercelSdkModule> | null = null
  const sdk = (): Promise<VercelSdkModule> => {
    if (!modulePromise) modulePromise = load()
    return modulePromise
  }

  return {
    kind: 'vercel',
    async createSandbox(opts: SandboxCreateOpts = {}): Promise<SandboxSession> {
      const mod = await sdk()
      const creds = resolveCredentials(config, process.env)
      const params: VercelCreateParams = {
        // FOUNDER REQUIREMENT: always set timeout from opts/config; never rely
        // on Vercel's 5-minute default.
        timeout: clampTimeout(opts.timeoutMs, defaultTimeoutMs, maxTimeoutMs),
        runtime: opts.runtime ?? config.runtime ?? VERCEL_DEFAULT_RUNTIME,
      }
      if (typeof opts.vcpus === 'number' && opts.vcpus > 0) params.resources = { vcpus: opts.vcpus }
      if (opts.ports && opts.ports.length > 0) params.ports = opts.ports
      // G5 supplies the allowlist content; we only pass the policy through.
      if (opts.egressPolicy !== undefined) params.networkPolicy = opts.egressPolicy
      if (opts.envVars) params.env = opts.envVars
      if (creds.token) params.token = creds.token
      if (creds.projectId) params.projectId = creds.projectId
      if (creds.teamId) params.teamId = creds.teamId
      const sandbox = await mod.Sandbox.create(params)
      return wrapVercelSandbox(sandbox)
    },
  }
}

// -- Model-key credential brokering (G3 / ALI-1004, item 4) ------------------

/** Default model endpoint the broker policy injects a key for. */
export const ANTHROPIC_API_HOST = 'api.anthropic.com'
/** Anthropic authenticates with `x-api-key` (not a Bearer Authorization). */
export const ANTHROPIC_API_KEY_HEADER = 'x-api-key'

export interface ModelKeyBrokerOptions {
  /** The raw model API key. Stays HOST-side in the firewall policy; NEVER enters
   *  the sandbox — the proxy sets it on matching egress. */
  apiKey: string
  /** Domain to inject the key for (default api.anthropic.com). */
  host?: string
  /** Header the endpoint authenticates with (default x-api-key). */
  headerName?: string
  /** G5's allowlist to merge the injection rule INTO. When omitted or
   *  'allow-all', the result stays permissive (`'*': []`) for v0 — G5 tightens
   *  it later — while still injecting the key for the model host. */
  basePolicy?: SandboxEgressPolicy
}

function normalizeAllow(
  policy: SandboxEgressPolicy | undefined
): Record<string, { transform?: { headers?: Record<string, string> }[] }[]> {
  if (!policy || policy === 'allow-all') return { '*': [] }
  if (policy === 'deny-all') return {}
  const allow = policy.allow
  if (!allow) return {}
  if (Array.isArray(allow)) {
    const out: Record<string, { transform?: { headers?: Record<string, string> }[] }[]> = {}
    for (const domain of allow) out[domain] = []
    return out
  }
  return { ...allow }
}

/**
 * Build an egress policy that injects `apiKey` as the model endpoint's auth
 * header AT THE PROXY (Vercel firewall request transform). The key lives only in
 * the policy the HOST sends to Vercel's control plane at create — it is never
 * written into the sandbox env, disk, or a run event. OpenCode inside the
 * sandbox is given a NON-SECRET dummy key so it forms requests; the proxy
 * overrides the header with the real value.
 */
export function buildModelKeyBrokerPolicy(opts: ModelKeyBrokerOptions): SandboxEgressPolicy {
  const host = opts.host ?? ANTHROPIC_API_HOST
  const headerName = opts.headerName ?? ANTHROPIC_API_KEY_HEADER
  const allow = normalizeAllow(opts.basePolicy)
  allow[host] = [{ transform: [{ headers: { [headerName]: opts.apiKey } }] }]
  // Preserve v0 permissiveness unless G5's basePolicy explicitly constrains it.
  if (opts.basePolicy === undefined || opts.basePolicy === 'allow-all') {
    if (!('*' in allow)) allow['*'] = []
  }
  const subnets = typeof opts.basePolicy === 'object' ? opts.basePolicy.subnets : undefined
  return subnets ? { allow, subnets } : { allow }
}
