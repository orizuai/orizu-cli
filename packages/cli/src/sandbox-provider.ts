/**
 * Orizu-owned sandbox provider seam (ALI-973 / WS-F, per ADR-003).
 *
 * ADR-003 requires every provider call (GitHub, Daytona) to sit behind an
 * Orizu-owned interface so the durable contracts never couple to whichever SDK
 * wins the quarter. This module defines `SandboxProvider` / `SandboxSession` and
 * ships two implementations:
 *
 *   - `createDaytonaProvider(config)` — a THIN adapter over the Daytona
 *     TypeScript SDK (`@daytonaio/sdk`). The SDK is imported LAZILY (dynamic
 *     import through a non-literal specifier) so the CLI works without it
 *     installed, the app build never resolves it, and tests never load it.
 *   - `createLocalSimProvider(config)` — a temp-dir + real-`git`-subprocess
 *     simulation used by the unit tests AND by the no-credentials local-sim
 *     rehearsal. It is a genuine rehearsal (real clone/commit/push against a
 *     local bare repo), not a mock.
 *
 * SDK-vs-docs note (verified against daytona.io/docs, 2026-07-02): the real
 * `git.clone` signature is
 *   clone(url, path, branch?, commitId?, username?, password?, insecureSkipTls?)
 * i.e. a `commitId` argument sits BETWEEN `branch` and `username` — the ALI-973
 * brief documented `clone(url, path, branch, username, password)`. The adapter
 * passes `undefined` for `commitId` so the Orizu seam keeps its clean per-call
 * credential shape. `git.push(path, username?, password?)` matches the brief.
 */

import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'

export interface ExecResult {
  stdout: string
  exitCode: number
  /** Captured standard error, when the provider exposes it — surfaced so a
   *  failed git clone/push does not vanish behind a masked exit code. */
  stderr?: string
}

export interface GitCloneParams {
  url: string
  path: string
  branch?: string
  username?: string
  password?: string
}

export interface GitPushParams {
  path: string
  username?: string
  password?: string
}

/**
 * A single request transform a provider firewall applies to matching egress
 * (the credential-brokering seam: inject a header at the proxy so the raw
 * secret never enters the sandbox). Structurally identical to @vercel/sandbox's
 * `NetworkPolicyRule` so a Vercel adapter can pass it straight through, but
 * declared here so the Orizu seam owns the shape (ADR-003).
 */
export interface SandboxEgressRule {
  transform?: { headers?: Record<string, string> }[]
}

/**
 * Provider-neutral egress/network policy, wired to the sandbox firewall AT
 * CREATE. G5 (ALI-1006) owns the allowlist CONTENT; this slice only plumbs the
 * option so the orchestrator can pass a policy (incl. a credential-injection
 * transform for a model endpoint). `'allow-all'` is the provider default when
 * omitted. Structurally compatible with @vercel/sandbox's `NetworkPolicy`.
 */
export type SandboxEgressPolicy =
  | 'allow-all'
  | 'deny-all'
  | {
      allow?: string[] | Record<string, SandboxEgressRule[]>
      subnets?: { allow?: string[]; deny?: string[] }
    }

export interface SandboxCreateOpts {
  language?: string
  snapshot?: string
  envVars?: Record<string, string>
  labels?: Record<string, string>
  /** Sandbox auto-terminate timeout (ms). Honored where the provider supports a
   *  configurable session length (Vercel); ignored by providers that do not. */
  timeoutMs?: number
  /** Provider runtime image hint (e.g. Vercel 'node24'); provider-specific. */
  runtime?: string
  /** vCPUs to allocate (memory scales with vCPUs on Vercel: 2048 MiB each). */
  vcpus?: number
  /** Ports to expose from the sandbox (provider-specific; up to 4 on Vercel). */
  ports?: number[]
  /** Egress/firewall policy applied at create (G5 supplies content). */
  egressPolicy?: SandboxEgressPolicy
}

/**
 * A live sandbox. Per-call git credentials mirror Daytona's contract (and
 * OpenInspect's credential-helper shape): the token is handed to each operation,
 * never written once per session.
 */
export interface SandboxSession {
  readonly id: string
  gitClone(params: GitCloneParams): Promise<void>
  gitPush(params: GitPushParams): Promise<void>
  exec(command: string, opts?: { cwd?: string }): Promise<ExecResult>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  fileExists(path: string): Promise<boolean>
  destroy(): Promise<void>
  /**
   * Extend the sandbox's auto-terminate timeout by `durationMs` (keepalive).
   * OPTIONAL: only providers with a configurable session length implement it
   * (Vercel). Host-side token rotation uses it to keep a long session alive
   * beyond the provider's default. Absent on local-sim / Daytona.
   */
  extendTimeout?(durationMs: number): Promise<void>
}

export type SandboxProviderKind = 'daytona' | 'local-sim' | 'vercel'

export interface SandboxProvider {
  readonly kind: SandboxProviderKind
  createSandbox(opts?: SandboxCreateOpts): Promise<SandboxSession>
}

// -- Daytona adapter (lazy SDK) ---------------------------------------------

export interface DaytonaProviderConfig {
  apiKey: string
  apiUrl?: string
  target?: string
}

// Minimal structural view of the SDK surface the adapter touches. Kept local so
// the seam type-checks and the app build resolves without the package present.
interface DaytonaSdkSandbox {
  id: string
  git: {
    clone(
      url: string,
      path: string,
      branch?: string,
      commitId?: string,
      username?: string,
      password?: string,
      insecureSkipTls?: boolean
    ): Promise<void>
    push(path: string, username?: string, password?: string): Promise<void>
  }
  process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number
    ): Promise<{ exitCode?: number; result?: string; stderr?: string; artifacts?: { stdout?: string; stderr?: string } }>
  }
  fs: {
    downloadFile(remotePath: string): Promise<Uint8Array | Buffer | string>
    uploadFile(file: Uint8Array, remotePath: string): Promise<void>
    getFileDetails(path: string): Promise<unknown>
  }
  delete(timeout?: number): Promise<void>
}

interface DaytonaSdkClient {
  create(params?: Record<string, unknown>, options?: { timeout: number }): Promise<DaytonaSdkSandbox>
}

export interface DaytonaSdkModule {
  Daytona: new (config: { apiKey: string; apiUrl?: string; target?: string }) => DaytonaSdkClient
}

/** Test seam: inject a fake SDK module so the adapter's request mapping can be
 *  exercised without the real package installed or a network. */
export interface DaytonaProviderDeps {
  loadModule?: () => Promise<DaytonaSdkModule>
}

// The package name lives in a variable so TypeScript treats the dynamic import
// as `any` (no static module resolution / no ts2307 at app build time) and so
// no bundler traces it. This is what keeps the SDK genuinely optional.
//
// PIN CONTRACT: `wrapDaytonaSandbox` hard-codes the POSITIONAL git.clone
// signature (url, path, branch, commitId, username, password) verified against
// @daytonaio/sdk@0.193.0. package.json pins that version EXACTLY (no caret) and
// packages/cli/bun.lock records it, so a minor bump cannot silently shift the
// argument order out from under this adapter. Re-verify the signature before
// changing the pin.
//
// TRANSITIVE-DEPENDENCY NOTE: @daytonaio/sdk itself drags in a substantial
// tree — @aws-sdk/client-s3, the OpenTelemetry SDK/exporters, and friends —
// into packages/cli's dependency graph. `bun install --cwd packages/cli`
// resolves and downloads all of it even though this file only ever reaches
// the package via the lazy `import(specifier)` above. That's judged
// acceptable because: (1) this is a founder-only, not end-user-shipped,
// script — packages/cli's app build and published `dist/` never bundle or
// execute this path; (2) the lazy import means the SDK (and its transitive
// tree) is never loaded into the running process unless `runDaytonaSlice`
// actually selects the `daytona` provider; (3) `bun install`'s resolve-time
// cost is a one-time developer/CI tax on this package, not a runtime or
// shipped-artifact cost. Re-evaluate if @daytonaio/sdk ever becomes a
// dependency of a package that IS shipped to end users.
const DAYTONA_SDK_SPECIFIER = '@daytonaio/sdk'

async function loadDaytonaModule(): Promise<DaytonaSdkModule> {
  try {
    const specifier: string = DAYTONA_SDK_SPECIFIER
    const mod = (await import(specifier)) as unknown as DaytonaSdkModule
    if (!mod || typeof mod.Daytona !== 'function') {
      throw new Error('module did not export a Daytona class')
    }
    return mod
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Daytona SDK unavailable (${detail}). Install it before the live run: \`bun install --cwd packages/cli\` (declares @daytonaio/sdk).`
    )
  }
}

function wrapDaytonaSandbox(sandbox: DaytonaSdkSandbox): SandboxSession {
  return {
    id: sandbox.id,
    async gitClone(params) {
      // commitId (4th arg) is undefined — clean per-call credential shape.
      await sandbox.git.clone(
        params.url,
        params.path,
        params.branch,
        undefined,
        params.username,
        params.password
      )
    },
    async gitPush(params) {
      await sandbox.git.push(params.path, params.username, params.password)
    },
    async exec(command, opts) {
      const res = await sandbox.process.executeCommand(command, opts?.cwd)
      const stdout =
        typeof res.result === 'string' ? res.result : res.artifacts?.stdout ?? ''
      const stderr = res.stderr ?? res.artifacts?.stderr
      // A missing exitCode is treated as a FAILURE (1), never masked to success:
      // a live clone/push that returns no code must not read as green.
      const exitCode = typeof res.exitCode === 'number' ? res.exitCode : 1
      return { stdout, exitCode, stderr }
    },
    async readFile(path) {
      const data = await sandbox.fs.downloadFile(path)
      if (typeof data === 'string') return data
      return Buffer.from(data).toString('utf8')
    },
    async writeFile(path, content) {
      await sandbox.fs.uploadFile(Buffer.from(content, 'utf8'), path)
    },
    async fileExists(path) {
      try {
        await sandbox.fs.getFileDetails(path)
        return true
      } catch {
        return false
      }
    },
    async destroy() {
      await sandbox.delete()
    },
  }
}

export function createDaytonaProvider(
  config: DaytonaProviderConfig,
  deps: DaytonaProviderDeps = {}
): SandboxProvider {
  const load = deps.loadModule ?? loadDaytonaModule
  let clientPromise: Promise<DaytonaSdkClient> | null = null
  const client = (): Promise<DaytonaSdkClient> => {
    if (!clientPromise) {
      clientPromise = (async () => {
        const mod = await load()
        return new mod.Daytona({
          apiKey: config.apiKey,
          apiUrl: config.apiUrl,
          target: config.target,
        })
      })()
    }
    return clientPromise
  }

  return {
    kind: 'daytona',
    async createSandbox(opts) {
      const daytona = await client()
      const params: Record<string, unknown> = {}
      if (opts?.language) params.language = opts.language
      if (opts?.snapshot) params.snapshot = opts.snapshot
      if (opts?.envVars) params.envVars = opts.envVars
      if (opts?.labels) params.labels = opts.labels
      // ORPHAN-SANDBOX WINDOW: `daytona.create(...)` is a single SDK call that
      // provisions the remote sandbox AND resolves with its handle as one unit.
      // If it throws AFTER the remote sandbox exists but BEFORE this awaits
      // returns (e.g. the create succeeded server-side but the response never
      // reached us), the caller (runDaytonaSlice) never receives a
      // SandboxSession and has no id to destroy — the sandbox is orphaned on
      // Daytona's side with nothing in our process able to name it. This is
      // inherent to the SDK's create-returns-handle shape, not fixable by
      // catching here (there is no id to catch). `--keep`/manual cleanup in
      // the Daytona dashboard is the backstop. A create-then-fetch-id two-phase
      // API (create returns an id immediately, a separate call waits for
      // readiness) would close this window if Daytona ever ships one.
      const sandbox = await daytona.create(Object.keys(params).length ? params : undefined)
      return wrapDaytonaSandbox(sandbox)
    },
  }
}

// -- Local-sim provider (real git subprocess) --------------------------------

export interface LocalSimProviderConfig {
  /** Parent directory for per-sandbox temp dirs (defaults to the OS tmpdir). */
  rootDir?: string
  /** Skip filesystem teardown on destroy() (used by --keep for debugging). */
  keepOnDestroy?: boolean
}

interface ProcResult {
  stdout: string
  stderr: string
  exitCode: number
}

function runIn(bin: string, args: string[], cwd: string, home: string): ProcResult {
  // Strip git's repo-context env (set by git when this code runs inside a
  // hook, e.g. pre-push running `bun test`) so sim git commands operate on
  // the sandbox cwd — not whatever repo GIT_DIR points at. See
  // daytona-slice-rehearsal.ts for the core.bare=true corruption this caused.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  delete env.GIT_OBJECT_DIRECTORY
  delete env.GIT_COMMON_DIR
  const res = spawnSync(bin, args, { cwd, encoding: 'utf8', env })
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', exitCode: res.status ?? 1 }
}

function makeLocalSimSession(id: string, root: string, keepOnDestroy: boolean): SandboxSession {
  // A self-contained git identity so commits work regardless of host config.
  writeFileSync(
    join(root, '.gitconfig'),
    '[user]\n\temail = orizu-slice@local.sim\n\tname = Orizu Slice\n' +
      '[init]\n\tdefaultBranch = main\n[safe]\n\tdirectory = *\n'
  )
  const inRoot = (p: string): string => join(root, p)

  return {
    id,
    async gitClone(params) {
      const args = ['clone']
      if (params.branch) args.push('--branch', params.branch)
      // Clean per-call shape: the clone URL is the bare repo path; the
      // per-call username/password are honored by the transport but never
      // persisted into the cloned repo's config (mirrors the contract we
      // require of Daytona). Nothing to sanitize because nothing is embedded.
      args.push(params.url, params.path)
      const r = runIn('git', args, root, root)
      if (r.exitCode !== 0) {
        throw new Error(`git clone failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
      }
    },
    async gitPush(params) {
      const r = runIn('git', ['-C', params.path, 'push'], root, root)
      if (r.exitCode !== 0) {
        throw new Error(`git push failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
      }
    },
    async exec(command, opts) {
      const cwd = opts?.cwd ? inRoot(opts.cwd) : root
      const r = runIn('bash', ['-c', command], cwd, root)
      return { stdout: r.stdout, exitCode: r.exitCode, stderr: r.stderr }
    },
    async readFile(path) {
      return readFileSync(inRoot(path), 'utf8')
    },
    async writeFile(path, content) {
      const abs = inRoot(path)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    },
    async fileExists(path) {
      return existsSync(inRoot(path))
    },
    async destroy() {
      if (!keepOnDestroy) {
        rmSync(root, { recursive: true, force: true })
      }
    },
  }
}

export function createLocalSimProvider(config: LocalSimProviderConfig = {}): SandboxProvider {
  let counter = 0
  return {
    kind: 'local-sim',
    async createSandbox() {
      counter += 1
      const parent = config.rootDir ?? tmpdir()
      mkdirSync(parent, { recursive: true })
      const root = mkdtempSync(join(parent, 'orizu-sim-'))
      return makeLocalSimSession(`local-sim-${counter}-${basename(root)}`, root, Boolean(config.keepOnDestroy))
    },
  }
}
