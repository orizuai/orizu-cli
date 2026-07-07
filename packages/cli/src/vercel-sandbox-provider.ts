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
 * G5 (ALI-1006) owns the egress ALLOWLIST CONTENT (`egress-policy.ts` →
 * `buildEgressPolicy`); this adapter only plumbs the `egressPolicy` option
 * through to the Sandbox firewall (`networkPolicy`) at create. The model-key
 * credential broker (G3/ALI-1004) is COMPOSED into that same default-deny policy
 * by `buildEgressPolicy`: a per-domain request transform injects the model key AT
 * THE PROXY, so the raw key never enters the sandbox (see
 * docs/.../sandbox-secrets-policy.md §3).
 */

import type {
  ExecResult,
  GitCloneParams,
  GitPushParams,
  SandboxCreateOpts,
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

// -- Custom-image readiness retry (ALI-1017) ---------------------------------
// A freshly-pushed VCR image is asynchronously PREPARED; a create against it
// while it is still 'Preparing' throws `image_not_ready`. We retry that (and
// only that) a bounded number of times with linear backoff so a create that
// races the preparation window succeeds instead of failing the whole run.
/** Max create attempts when the SDK reports the image is not yet ready. */
export const VERCEL_IMAGE_NOT_READY_MAX_ATTEMPTS = 6
/** Base backoff (ms) between image-not-ready retries (multiplied by attempt#). */
export const VERCEL_IMAGE_NOT_READY_BACKOFF_MS = 5000

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

/** The @vercel/sandbox `Snapshot` surface we touch: the id getter is enough to
 *  hand the snapshot to a later `create({ source: { type: 'snapshot', … } })`. */
interface VercelSdkSnapshot {
  readonly snapshotId: string
}

interface VercelSdkSandbox {
  readonly sandboxId: string
  runCommand(params: VercelRunCommandParams): Promise<VercelSdkCommandFinished>
  readFileToBuffer(file: { path: string; cwd?: string }): Promise<Uint8Array | Buffer | null>
  writeFiles(files: { path: string; content: string | Uint8Array; mode?: number }[]): Promise<void>
  stop(opts?: { blocking?: boolean }): Promise<unknown>
  extendTimeout(durationMs: number): Promise<void>
  updateNetworkPolicy(policy: unknown): Promise<unknown>
  /** Snapshot the running sandbox; STOPS it as part of the process (verified
   *  against @vercel/sandbox@1.10.2 `Sandbox.snapshot(opts?): Promise<Snapshot>`). */
  snapshot(opts?: { expiration?: number }): Promise<VercelSdkSnapshot>
}

interface VercelCreateParams {
  timeout: number
  runtime?: string
  /** Custom VCR image ref (pre-baked runtime, ALI-1017); omitted → base runtime. */
  image?: string
  /**
   * Boot from a Vercel Sandbox SNAPSHOT (ALI-1017, zero-Docker prebaked path).
   * VERIFIED against @vercel/sandbox@1.10.2: the create-from-snapshot param is the
   * NESTED `source: { type: 'snapshot', snapshotId }` (NOT a flat `snapshot`), and
   * the snapshot variant of `CreateSandboxParams` OMITS `runtime`/`source` from the
   * base — so we never set `runtime` alongside a snapshot `source`.
   */
  source?: { type: 'snapshot'; snapshotId: string }
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
// `{ token, projectId, teamId }` credential fields, and a `source` union whose
// snapshot arm is `{ type: 'snapshot', snapshotId }` (create-from-snapshot). The
// returned Sandbox exposes `runCommand / readFileToBuffer / writeFiles / stop /
// extendTimeout / updateNetworkPolicy / snapshot / sandboxId`, and `snapshot()`
// returns a `Snapshot` with a `snapshotId` getter. packages/cli/package.json pins
// this version EXACTLY (no caret); re-verify before bumping. The lazy
// `import(specifier)` keeps the (Node-only) SDK genuinely optional — it loads only
// when the Vercel provider is actually selected.
//
// The specifier is ASSEMBLED at runtime (join, not a literal) so a bundler that
// reaches this module through the shared `lib/hosted-runtime/` surface (ALI-1015:
// `next build` for the app, wrangler for the coordinator Worker) cannot
// constant-fold `import(specifier)` into a static dependency on the SDK — the
// same discipline as the ALI-1031 server provider.
const VERCEL_SDK_SPECIFIER = ['@vercel', 'sandbox'].join('/')

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
  /** Default custom VCR image ref (pre-baked runtime); default env
   *  ORIZU_HOSTED_IMAGE, else undefined = base runtime (back-compat). */
  image?: string
  /** Default Vercel Sandbox snapshot id (zero-Docker prebaked runtime); default
   *  env ORIZU_HOSTED_SNAPSHOT, else undefined. Mutually exclusive with `image`;
   *  when both resolve, the snapshot wins (see createSandbox). */
  snapshot?: string
  /** Default session length (ms) when createSandbox opts omit one. */
  defaultTimeoutMs?: number
  /** Hard cap on the configured session length (ms; default 24 h). */
  maxTimeoutMs?: number
  /** Max create attempts while a custom image reports `image_not_ready`. */
  imageNotReadyMaxAttempts?: number
  /** Base backoff (ms) between image-not-ready retries (× attempt number). */
  imageNotReadyBackoffMs?: number
}

export interface VercelProviderDeps {
  loadModule?: () => Promise<VercelSdkModule>
  /** Injectable delay so the image-not-ready retry test runs without real waits. */
  sleep?: (ms: number) => Promise<void>
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

/**
 * True when an error is the SDK's "custom image is still being prepared" signal.
 * We match on a `code` field OR the message text, so we catch the error whether
 * the SDK surfaces it as `{ code: 'image_not_ready' }` or only in `.message`.
 * ONLY this specific condition is retried — any other create failure propagates.
 */
export function isImageNotReadyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const rec = error as { code?: unknown; message?: unknown }
  if (typeof rec.code === 'string' && rec.code === 'image_not_ready') return true
  return typeof rec.message === 'string' && /image_not_ready/i.test(rec.message)
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

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
    // ALI-1017: capture a snapshot of THIS running sandbox and return its id so a
    // provisioner can bake the runtime once and boot future sandboxes from it with
    // no Docker/VCR. Vercel STOPS the sandbox as part of snapshotting, so the
    // caller must treat the session as spent afterwards.
    async snapshot(opts?: { expiration?: number }): Promise<string> {
      const snap = await sandbox.snapshot(opts)
      const id = snap?.snapshotId
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error('sandbox.snapshot() returned no snapshotId')
      }
      return id
    },
  }
}

export function createVercelProvider(
  config: VercelProviderConfig = {},
  deps: VercelProviderDeps = {}
): SandboxProvider {
  const load = deps.loadModule ?? loadVercelModule
  const waitFor = deps.sleep ?? sleep
  const defaultTimeoutMs = config.defaultTimeoutMs ?? VERCEL_DEFAULT_TIMEOUT_MS
  const maxTimeoutMs = config.maxTimeoutMs ?? VERCEL_MAX_TIMEOUT_MS
  const imageNotReadyMaxAttempts = config.imageNotReadyMaxAttempts ?? VERCEL_IMAGE_NOT_READY_MAX_ATTEMPTS
  const imageNotReadyBackoffMs = config.imageNotReadyBackoffMs ?? VERCEL_IMAGE_NOT_READY_BACKOFF_MS
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
      }
      // ALI-1017: two mutually-exclusive prebaked-runtime paths, each resolved by
      // the same precedence (per-call opts → provider config → env default):
      //   - `snapshot` → boot from a Vercel Sandbox snapshot (zero-Docker path);
      //   - `image`    → boot from a custom VCR image (Docker/VCR path).
      // When BOTH resolve, the SNAPSHOT wins (documented preference) — never boot
      // an ambiguous mix. A snapshot boot OMITS `runtime`/`image` (the SDK's
      // snapshot create-variant forbids `runtime`); the base runtime is otherwise
      // set so we never fall back to Vercel's default.
      const snapshot = opts.snapshot ?? config.snapshot ?? process.env.ORIZU_HOSTED_SNAPSHOT
      const image = opts.image ?? config.image ?? process.env.ORIZU_HOSTED_IMAGE
      if (snapshot) {
        params.source = { type: 'snapshot', snapshotId: snapshot }
      } else {
        params.runtime = opts.runtime ?? config.runtime ?? VERCEL_DEFAULT_RUNTIME
        if (image) params.image = image
      }
      if (typeof opts.vcpus === 'number' && opts.vcpus > 0) params.resources = { vcpus: opts.vcpus }
      if (opts.ports && opts.ports.length > 0) params.ports = opts.ports
      // G5 supplies the allowlist content; we only pass the policy through.
      if (opts.egressPolicy !== undefined) params.networkPolicy = opts.egressPolicy
      if (opts.envVars) params.env = opts.envVars
      if (creds.token) params.token = creds.token
      if (creds.projectId) params.projectId = creds.projectId
      if (creds.teamId) params.teamId = creds.teamId

      // A freshly-pushed custom image may still be 'Preparing' in VCR; retry the
      // `image_not_ready` create (and ONLY that) with bounded linear backoff.
      let lastError: unknown
      for (let attempt = 1; attempt <= imageNotReadyMaxAttempts; attempt += 1) {
        try {
          const sandbox = await mod.Sandbox.create(params)
          return wrapVercelSandbox(sandbox)
        } catch (error) {
          if (!isImageNotReadyError(error)) throw error
          lastError = error
          if (attempt < imageNotReadyMaxAttempts) await waitFor(imageNotReadyBackoffMs * attempt)
        }
      }
      const detail = lastError instanceof Error ? lastError.message : String(lastError)
      throw new Error(
        `Vercel Sandbox image ${image ?? snapshot ?? '(unknown)'} not ready after ${imageNotReadyMaxAttempts} attempts (${detail}). ` +
          'Wait until the image shows status "Ready" for linux/amd64 in VCR before creating a sandbox.'
      )
    },
  }
}

// -- Model-key credential brokering (G3 / ALI-1004) --------------------------
//
// The model-key broker is NOT a separate builder anymore: `egress-policy.ts` →
// `buildEgressPolicy({ modelKeyBroker })` COMPOSES the key-injection transform
// onto the model host's rule inside the ONE default-deny allowlist, so brokering
// and allowlisting cannot disagree. The prior permissive `buildModelKeyBrokerPolicy`
// (which emitted an allow-all `'*': []`) has been DELETED — a default-deny policy
// must only ever come from `buildEgressPolicy`. See
// docs/requirements/hosted-customer-workbench/sandbox-egress-policy.md §2.
