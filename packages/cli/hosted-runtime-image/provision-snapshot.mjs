#!/usr/bin/env node
/** Provision the hosted runtime in either published-package (`--cli-version`) or
 * from-source mode, then capture a Vercel Sandbox snapshot. Credentials stay in
 * environment variables and this script logs only step names and the snapshot id. */

import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildCliBundle, resolveGitVersion } from './build-cli-bundle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// Pins mirrored from the Dockerfile (source-of-truth for the npm-pinned externals).
export const DEFAULT_OPENCODE_VERSION = '1.14.41'
export const DEFAULT_CLAUDE_SDK_VERSION = '0.3.201'
export const DEFAULT_BRAINTRUST_PY_VERSION = '0.30.0'
export const DEFAULT_BRAINTRUST_NPM_VERSION = '3.23.1'
export const SNAPSHOT_OPERATION_TIMEOUTS = { provider: 30_000, create: 120_000, write: 30_000, exec: 45 * 60_000, snapshot: 180_000, destroy: 60_000, lateSettlement: 70_000 }
export const SNAPSHOT_STEP_TIMEOUTS = { write: 30_000, quick: 5 * 60_000, install: 15 * 60_000, manager: 45 * 60_000 }
export const BRAINTRUST_PY_VERSION_RE =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))?(?:(?:a|b|rc)(?:0|[1-9][0-9]*)|\.post(?:0|[1-9][0-9]*)|\.dev(?:0|[1-9][0-9]*))?$/
export const BRAINTRUST_NPM_VERSION_RE =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$/

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const CLI_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)?$/

const CLI_DIR = '/opt/orizu/cli'
const CLI_DIST_DIR = `${CLI_DIR}/dist`
const CLI_INDEX = `${CLI_DIST_DIR}/index.js`
const CLI_PKG = `${CLI_DIR}/package.json`
const MARKER_PATH = '/opt/orizu/prebaked.json'
const STAGE_BUNDLE = 'orizu-cli-bundle.js'
const STAGE_PKG = 'orizu-cli-package.json'
const STAGE_MARKER = 'orizu-prebaked.json'
const STAGE_ASSETS = 'orizu-skilled-proposer-assets.json'
const BAKE_COMMAND = 'orizu internal bake-skilled-proposer-venv --json'
const VERIFY_COMMAND = 'orizu internal verify-skilled-proposer-bake --json'
const writeStep = (name, writeFile) => ({ name, timeoutClass: 'write', writeFile })
const execStep = (name, exec, timeoutClass = 'quick') => ({ name, timeoutClass, exec })

export function sourceAssetPayload(runGit = spawnSync) {
  const cliRoot = resolve(HERE, '..')
  const repoRoot = resolve(cliRoot, '..', '..')
  const roots = ['packages/cli/scripts/ensure-skilled-proposer-venv.mjs', 'packages/cli/scripts/vendor-gepa-python.mjs', 'packages/cli/src/skilled-proposer-venv-manager.mjs', 'packages/cli/src/skilled-proposer-bake-report.ts', 'packages/cli/requirements/skilled-proposer.lock', 'packages/cli/gepa-python-source.zip', 'packages/orizu-gepa/src', 'packages/orizu-gepa/pyproject.toml', 'packages/orizu-gepa-python/src', 'packages/orizu-gepa-python/pyproject.toml', 'packages/orizu-gepa-python/manifest.json']
  const listed = runGit('git', ['ls-files', '-z', '--error-unmatch', '--', ...roots], { cwd: repoRoot, encoding: 'utf8' })
  if (listed.error || listed.status !== 0) throw new Error(`ALI_1588_SOURCE_ASSET_MANIFEST_FAILED: ${listed.error?.message || listed.stderr || `exit ${listed.status}`}`)
  const entries = {}
  for (const source of listed.stdout.split('\0').filter(Boolean).sort()) {
    let target = source.replace('packages/cli/', '')
    if (source.startsWith('packages/orizu-gepa/')) target = source.replace('packages/orizu-gepa/', 'vendor/orizu-gepa/')
    if (source.startsWith('packages/orizu-gepa-python/')) target = source.replace('packages/orizu-gepa-python/', 'vendor/orizu-gepa-python/')
    entries[target] = readFileSync(resolve(repoRoot, source)).toString('base64')
  }
  return JSON.stringify(entries)
}

function skilledProposerSteps() {
  return [
    execStep('prepare skilled-proposer cache', 'sudo mkdir -p /opt/orizu/cache/skilled-proposer && sudo chown -R "$(id -u):$(id -g)" /opt/orizu/cache/skilled-proposer'),
    execStep('bake skilled-proposer managed venv', BAKE_COMMAND, 'manager'),
    execStep('verify skilled-proposer managed venv', VERIFY_COMMAND, 'manager'),
  ]
}

export function parseArgs(argv) {
  const args = { flags: new Set(), values: {} }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args.flags.add(key)
    } else {
      args.values[key] = next
      i += 1
    }
  }
  return args
}

function packageJson(gitVersion) {
  return `{\n  "name": "orizu",\n  "version": "${gitVersion}",\n  "type": "module"\n}\n`
}

function markerJson({ cliVersion, cliSource, cliGitVersion, opencodeVersion, claudeSdkVersion, braintrustPyVersion, braintrustNpmVersion }) {
  const gitLine = cliGitVersion ? `  "cliGitVersion": "${cliGitVersion}",\n` : ''
  return (
    `{\n  "cliVersion": "${cliVersion}",\n  "cliSource": "${cliSource}",\n` +
    `${gitLine}  "opencodeVersion": "${opencodeVersion}",\n` +
    `  "claudeSdkVersion": "${claudeSdkVersion}",\n` +
    `  "braintrustPyVersion": "${braintrustPyVersion}",\n` +
    `  "braintrustNpmVersion": "${braintrustNpmVersion}",\n  "builtFor": "vercel-sandbox"\n}\n`
  )
}

function braintrustSteps({ braintrustPyVersion, braintrustNpmVersion }) {
  return [
    execStep(`install braintrust npm CLI @${braintrustNpmVersion} (global; kept as \`bt\`, \`braintrust\` link removed)`,
        `sudo npm install -g "braintrust@${braintrustNpmVersion}" && sudo npm cache clean --force && ` +
        `sudo rm -f "$(command -v braintrust)"`, 'install'),
    execStep(`install python3.11 + braintrust[cli]==${braintrustPyVersion} (python eval harness; python3 -> 3.11 via /usr/local/bin)`,
        `sudo dnf -y install python3.11 python3.11-pip && sudo dnf clean all && ` +
        `sudo python3.11 -m pip install --no-cache-dir "braintrust[cli]==${braintrustPyVersion}" && ` +
        `sudo ln -sf /usr/bin/python3.11 /usr/local/bin/python3 && sudo ln -sf /usr/bin/pip3.11 /usr/local/bin/pip3`, 'install'),
  ]
}

function braintrustVerify(braintrustPyVersion) {
  return (
    `command -v braintrust && command -v bt && ` +
    `head -1 "$(command -v braintrust)" | grep -Eq '^#!.*/python3\\.11$' && ` +
    `braintrust --help >/dev/null && bt --help >/dev/null && ` +
    `python3 --version | grep -F "Python 3.11" && python3 -c 'import braintrust' && ` +
    `python3.11 -c 'import braintrust; from importlib.metadata import version; assert version("braintrust") == "${braintrustPyVersion}"'`
  )
}

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'` }
export function claudeSdkImportProbe(cliDir = CLI_DIR) {
  return `cd ${shellQuote(cliDir)} && node --input-type=module -e "const m=await import('@anthropic-ai/claude-agent-sdk');if(typeof m.query!=='function')process.exit(1)"`
}

/** Presence check that never echoes the values (no secret in logs/errors). */
export function resolveCredsOrFail(env, fail) {
  const token = env.VERCEL_TOKEN ?? env.VERCEL_OIDC_TOKEN
  const projectId = env.VERCEL_PROJECT_ID
  const teamId = env.VERCEL_TEAM_ID
  const missing = []
  if (!token) missing.push('VERCEL_TOKEN')
  if (!projectId) missing.push('VERCEL_PROJECT_ID')
  if (!teamId) missing.push('VERCEL_TEAM_ID')
  if (missing.length) fail(`missing Vercel credentials in env: ${missing.join(', ')}`)
  return { token, projectId, teamId }
}

/**
 * The ordered in-sandbox provisioning steps. Pure data (no I/O) so a test can
 * assert the plan without a sandbox. `sudo` assumes Vercel's passwordless-sudo
 * non-root sandbox user; drop it if the runtime ever runs as root.
 *
 * Passing `cliVersion` switches to PUBLISHED-PACKAGE mode: the CLI comes from
 * `npm i -g orizu@<cliVersion>` (which carries its own pinned
 * @anthropic-ai/claude-agent-sdk dependency) instead of a from-source bundle.
 */
export function buildProvisionSteps({
  bundleContent,
  assetContent = '<assets>',
  gitVersion,
  opencodeVersion,
  claudeSdkVersion,
  braintrustPyVersion = DEFAULT_BRAINTRUST_PY_VERSION,
  braintrustNpmVersion = DEFAULT_BRAINTRUST_NPM_VERSION,
  cliVersion = null,
}) {
  if (cliVersion) {
    return [
      execStep(`install published orizu@${cliVersion} at canonical root`, `sudo sh -c 'npm install -g "orizu@${cliVersion}" && mkdir -p /opt/orizu && cp -a "$(npm root -g)/orizu" ${CLI_DIR} && cd ${CLI_DIR} && npm install --no-save --package-lock=false --omit=dev "@anthropic-ai/claude-agent-sdk@${claudeSdkVersion}" && npm cache clean --force && ln -sf ${CLI_INDEX} /usr/local/bin/orizu'`, 'install'),
      execStep('install opencode-ai (global bin)', `sudo npm install -g "opencode-ai@${opencodeVersion}" && sudo npm cache clean --force`, 'install'),
      ...braintrustSteps({ braintrustPyVersion, braintrustNpmVersion }),
      writeStep('stage prebaked marker', [
          STAGE_MARKER,
          markerJson({ cliVersion, cliSource: 'published-npm', cliGitVersion: null, opencodeVersion, claudeSdkVersion, braintrustPyVersion, braintrustNpmVersion }),
        ]),
      execStep('install prebaked marker', `sudo mkdir -p /opt/orizu && sudo mv ${STAGE_MARKER} ${MARKER_PATH}`),
      execStep('verify git + ssh client present (merge-job runtime requirement)', 'command -v ssh >/dev/null 2>&1 || sudo dnf -y install openssh-clients; git --version && ssh -V', 'install'),
      execStep('verify bake (orizu version + opencode + hosted-loop + braintrust)',
          `command -v orizu && command -v opencode && orizu --version | grep -F "${cliVersion}" && ` +
          `orizu internal hosted-loop 2>&1 | grep -q 'hosted-loop --context' && ` +
          `${claudeSdkImportProbe()} && ` +
          braintrustVerify(braintrustPyVersion)),
      ...skilledProposerSteps(),
    ]
  }
  return [
    writeStep('stage skilled-proposer assets', [STAGE_ASSETS, assetContent]),
    execStep('install skilled-proposer assets', `sudo mkdir -p ${CLI_DIR} && sudo node -e 'const f=require("fs"),p=require("path"),o=JSON.parse(f.readFileSync(process.argv[1],"utf8"));for(const [n,v] of Object.entries(o)){const d=p.join(process.argv[2],n);f.mkdirSync(p.dirname(d),{recursive:true});f.writeFileSync(d,Buffer.from(v,"base64"))}' ${STAGE_ASSETS} ${CLI_DIR} && sudo node ${CLI_DIR}/scripts/vendor-gepa-python.mjs --archive ${CLI_DIR}/gepa-python-source.zip --destination ${CLI_DIR}/vendor/gepa-python && sudo rm -f ${CLI_DIR}/gepa-python-source.zip ${STAGE_ASSETS}`),
    writeStep('stage CLI bundle', [STAGE_BUNDLE, bundleContent]),
    execStep('install CLI bundle', `sudo mkdir -p ${CLI_DIST_DIR} && sudo mv ${STAGE_BUNDLE} ${CLI_INDEX} && sudo chmod +x ${CLI_INDEX}`),
    writeStep('stage package.json', [STAGE_PKG, packageJson(gitVersion)]),
    execStep('install package.json', `sudo mv ${STAGE_PKG} ${CLI_PKG}`),
    execStep('symlink orizu onto PATH', `sudo ln -sf ${CLI_INDEX} /usr/local/bin/orizu`),
    execStep('install @anthropic-ai/claude-agent-sdk (sibling of bundle)', `cd ${CLI_DIR} && sudo npm install --no-save --omit=dev "@anthropic-ai/claude-agent-sdk@${claudeSdkVersion}" && sudo npm cache clean --force`, 'install'),
    execStep('install opencode-ai (global bin)', `sudo npm install -g "opencode-ai@${opencodeVersion}" && sudo npm cache clean --force`, 'install'),
    ...braintrustSteps({ braintrustPyVersion, braintrustNpmVersion }),
    writeStep('stage prebaked marker', [
        STAGE_MARKER,
        markerJson({ cliVersion: gitVersion, cliSource: 'from-source', cliGitVersion: gitVersion, opencodeVersion, claudeSdkVersion, braintrustPyVersion, braintrustNpmVersion }),
      ]),
    execStep('install prebaked marker', `sudo mkdir -p /opt/orizu && sudo mv ${STAGE_MARKER} ${MARKER_PATH}`),
    execStep('verify git + ssh client present (merge-job runtime requirement)', 'git --version && ssh -V'),
    execStep('verify bake (orizu + opencode + hosted-loop + braintrust)',
        `command -v orizu && command -v opencode && orizu --version && orizu internal hosted-loop 2>&1 | grep -q 'hosted-loop --context' && ` +
        braintrustVerify(braintrustPyVersion)),
    ...skilledProposerSteps(),
  ]
}

export function provisionStepTimeout(step, operationTimeouts = SNAPSHOT_OPERATION_TIMEOUTS) {
  if (step.timeoutClass === 'write') return Math.min(operationTimeouts.write, SNAPSHOT_STEP_TIMEOUTS.write)
  if (step.timeoutClass === 'quick') return Math.min(operationTimeouts.exec / 9, SNAPSHOT_STEP_TIMEOUTS.quick)
  if (step.timeoutClass === 'install') return Math.min(operationTimeouts.exec / 3, SNAPSHOT_STEP_TIMEOUTS.install)
  if (step.timeoutClass === 'manager') return Math.min(operationTimeouts.exec, SNAPSHOT_STEP_TIMEOUTS.manager)
  throw new Error(`ALI_1588_SNAPSHOT_STEP_TIMEOUT_CLASS_INVALID: ${step.name}`)
}

export function provisionPlanMaximum(steps, operationTimeouts = SNAPSHOT_OPERATION_TIMEOUTS) {
  return steps.reduce((total, step) => total + provisionStepTimeout(step, operationTimeouts), 0)
}

const publishedBudgetSteps = buildProvisionSteps({ bundleContent: null, gitVersion: 'budget', opencodeVersion: DEFAULT_OPENCODE_VERSION, claudeSdkVersion: DEFAULT_CLAUDE_SDK_VERSION, cliVersion: '0.0.0' })
const sourceBudgetSteps = buildProvisionSteps({ bundleContent: 'budget', assetContent: 'budget', gitVersion: 'budget', opencodeVersion: DEFAULT_OPENCODE_VERSION, claudeSdkVersion: DEFAULT_CLAUDE_SDK_VERSION })
export const PUBLISHED_PROVISION_PLAN_MAXIMUM_MILLISECONDS = provisionPlanMaximum(publishedBudgetSteps)
export const FROM_SOURCE_PROVISION_PLAN_MAXIMUM_MILLISECONDS = provisionPlanMaximum(sourceBudgetSteps)
const sandboxDuration = planMaximum => Math.ceil((planMaximum + SNAPSHOT_OPERATION_TIMEOUTS.snapshot + SNAPSHOT_OPERATION_TIMEOUTS.lateSettlement + (10 * 60_000)) / 60_000)
export const PUBLISHED_SANDBOX_DURATION_MINUTES = sandboxDuration(PUBLISHED_PROVISION_PLAN_MAXIMUM_MILLISECONDS)
export const FROM_SOURCE_SANDBOX_DURATION_MINUTES = sandboxDuration(FROM_SOURCE_PROVISION_PLAN_MAXIMUM_MILLISECONDS)
export const DEFAULT_DURATION_MINUTES = FROM_SOURCE_SANDBOX_DURATION_MINUTES
export const PUBLISHED_SNAPSHOT_MAXIMUM_MILLISECONDS = SNAPSHOT_OPERATION_TIMEOUTS.provider + SNAPSHOT_OPERATION_TIMEOUTS.create + SNAPSHOT_OPERATION_TIMEOUTS.lateSettlement + PUBLISHED_PROVISION_PLAN_MAXIMUM_MILLISECONDS + SNAPSHOT_OPERATION_TIMEOUTS.snapshot + SNAPSHOT_OPERATION_TIMEOUTS.lateSettlement + SNAPSHOT_OPERATION_TIMEOUTS.destroy + (5 * 60_000)
export const SOURCE_BUNDLE_TIMEOUT_MILLISECONDS = 10_000

/** Default real provider loader — imported LAZILY (TS source) so tests that inject
 *  a fake provider never load the SDK. Runs under bun. */
async function defaultCreateProvider() {
  const url = new URL('../src/vercel-sandbox-provider.ts', import.meta.url).href
  const mod = await import(url)
  return mod.createVercelProvider()
}

async function withDeadline(operation, label, timeout, onLateSuccess, lateTimeout = 0, onLateTimeout) {
  let timer, timedOut = false
  const pending = Promise.resolve().then(operation)
  return await new Promise((resolveResult, rejectResult) => {
    pending.then(value => { if (!timedOut) { clearTimeout(timer); resolveResult(value) } }, error => { if (!timedOut) { clearTimeout(timer); rejectResult(error) } })
    timer = setTimeout(async () => {
      timedOut = true
      if (onLateSuccess) {
        let lateTimer, reconciled = false
        await Promise.race([pending.then(value => onLateSuccess(value)).then(() => { reconciled = true }, () => { reconciled = true }), new Promise(resolveLate => { lateTimer = setTimeout(resolveLate, lateTimeout) })])
        clearTimeout(lateTimer)
        if (!reconciled && onLateTimeout) onLateTimeout()
      }
      rejectResult(new Error(`ALI_1588_SNAPSHOT_${label}_TIMEOUT`))
    }, timeout)
  })
}

export async function runProvisionSnapshot(opts = {}) {
  const argv = opts.argv ?? process.argv.slice(2)
  const env = opts.env ?? process.env
  const buildBundle = opts.buildBundle ?? buildCliBundle
  const gitVersion = opts.gitVersion ?? resolveGitVersion()
  const out = opts.stdout ?? (s => process.stdout.write(s))
  const errOut = opts.stderr ?? (s => process.stderr.write(s))
  const createProvider = opts.createProvider ?? defaultCreateProvider
  const operationTimeouts = { ...SNAPSHOT_OPERATION_TIMEOUTS, ...opts.operationTimeouts }

  let failed = false
  const fail = message => {
    failed = true
    errOut(`error: ${message}\n`)
  }

  const args = parseArgs(argv)
  const dryRun = args.flags.has('dry-run')

  const cliVersion = args.values['cli-version'] ?? null
  if (cliVersion !== null && !CLI_VERSION_RE.test(cliVersion)) {
    fail(`invalid --cli-version "${cliVersion}" — expected a semver like 0.6.0`)
  }

  const label = args.values.label ?? (cliVersion ? `cli-v${cliVersion}` : gitVersion)
  if (!LABEL_RE.test(label)) fail(`invalid label "${label}" — must match ${LABEL_RE}`)

  const idFile = args.values['id-file'] ?? null

  const minimumDurationMinutes = cliVersion ? PUBLISHED_SANDBOX_DURATION_MINUTES : FROM_SOURCE_SANDBOX_DURATION_MINUTES
  const durationMinutes = Number(args.values.duration ?? minimumDurationMinutes)
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) fail('--duration must be a positive number of minutes')
  else if (durationMinutes < minimumDurationMinutes) fail(`--duration must be at least ${minimumDurationMinutes} minutes for this provision plan`)

  let expiration
  if (args.values.expiration !== undefined) {
    expiration = Number(args.values.expiration)
    if (!Number.isFinite(expiration) || expiration < 0) fail('--expiration must be a non-negative number of ms (0 = never)')
  }

  const opencodeVersion = args.values['opencode-version'] ?? DEFAULT_OPENCODE_VERSION
  const claudeSdkVersion = args.values['claude-sdk-version'] ?? DEFAULT_CLAUDE_SDK_VERSION
  const braintrustPyVersion = args.values['braintrust-py-version'] ?? DEFAULT_BRAINTRUST_PY_VERSION
  const braintrustNpmVersion = args.values['braintrust-npm-version'] ?? DEFAULT_BRAINTRUST_NPM_VERSION
  for (const [flag, value, re, example] of [
    ['braintrust-py-version', braintrustPyVersion, BRAINTRUST_PY_VERSION_RE, '0.30.0'],
    ['braintrust-npm-version', braintrustNpmVersion, BRAINTRUST_NPM_VERSION_RE, '3.23.1'],
  ]) {
    if (args.flags.has(flag)) fail(`--${flag} requires a value (e.g. ${example})`)
    else if (!re.test(value)) fail(`invalid --${flag} "${value}" — expected a version like ${example}`)
  }

  const creds = dryRun ? { token: env.VERCEL_TOKEN, projectId: env.VERCEL_PROJECT_ID, teamId: env.VERCEL_TEAM_ID } : resolveCredsOrFail(env, fail)

  if (failed) return { ok: false }

  if (cliVersion) {
    out(`Snapshot label (published-package bake): ${label}\n`)
    out(`CLI provenance: orizu@${cliVersion} (published npm package)\n`)
  } else {
    out(`Snapshot label (git-describe, baked from source): ${label}\n`)
    out(`CLI provenance: ${gitVersion}\n`)
  }
  out(`Provisioning sandbox lifetime: ${durationMinutes}m\n`)
  out(
    `Pinned externals: opencode-ai@${opencodeVersion}, @anthropic-ai/claude-agent-sdk@${claudeSdkVersion}, ` +
      `braintrust[cli]==${braintrustPyVersion} (PyPI), braintrust@${braintrustNpmVersion} (npm)\n\n`
  )

  const stepsPlan = buildProvisionSteps({ bundleContent: '<bundle>', assetContent: '<assets>', gitVersion, opencodeVersion, claudeSdkVersion, braintrustPyVersion, braintrustNpmVersion, cliVersion })
  out('Plan:\n')
  let planStep = 1
  if (!cliVersion) {
    out(`  ${planStep}. bun build → self-contained CLI bundle (from source)\n`)
    planStep += 1
  }
  out(`  ${planStep}. create base sandbox (OPEN network — provision-time npm installs need egress)\n`)
  planStep += 1
  stepsPlan.forEach(step => {
    out(`  ${planStep}. ${step.name}\n`)
    planStep += 1
  })
  out(`  ${planStep}. snapshot() → capture snapshot id${expiration !== undefined ? ` (expiration ${expiration}ms)` : ''}\n\n`)

  if (dryRun) {
    out('--dry-run: not building the bundle, not creating a sandbox, not snapshotting.\n')
    return { ok: true, dryRun: true, label, snapshotId: null, cliVersion }
  }

  const bundleFile = resolve(HERE, 'dist', 'orizu.js')
  let bundleContent = null
  let assetContent = null
  if (!cliVersion) {
    out('Baking the CLI from source (bun build)…\n')
    buildBundle(bundleFile, SOURCE_BUNDLE_TIMEOUT_MILLISECONDS)
    bundleContent = readFileSync(bundleFile, 'utf8')
    assetContent = sourceAssetPayload()
  }

  let provider, session
  try {
    provider = await withDeadline(() => createProvider({ ...creds }), 'PROVIDER_CREATE', operationTimeouts.provider)
    out('Creating base sandbox (open network)…\n')
    session = await withDeadline(() => provider.createSandbox({ timeoutMs: durationMinutes * 60 * 1000 }), 'CREATE', operationTimeouts.create, async lateSession => {
      try { await withDeadline(() => lateSession.destroy(), 'DESTROY', operationTimeouts.destroy) }
      catch (error) { errOut(`error: ALI_1588_SNAPSHOT_LATE_CREATE_CLEANUP_FAILED: ${error instanceof Error ? error.message : String(error)}\n`) }
    }, operationTimeouts.lateSettlement, () => errOut('error: ALI_1588_SNAPSHOT_LATE_CREATE_RECONCILIATION_TIMEOUT\n'))
  } catch (error) {
    rmSync(bundleFile, { force: true })
    throw error
  }
  out(`sandbox ${session.id}\n`)

  try {
    const steps = buildProvisionSteps({ bundleContent, assetContent, gitVersion, opencodeVersion, claudeSdkVersion, braintrustPyVersion, braintrustNpmVersion, cliVersion })
    for (const step of steps) {
      out(`- ${step.name}\n`)
      if (step.writeFile) {
        await withDeadline(() => session.writeFile(step.writeFile[0], step.writeFile[1]), 'WRITE', provisionStepTimeout(step, operationTimeouts))
      } else if (step.exec) {
        const res = await withDeadline(() => session.exec(step.exec), 'EXEC', provisionStepTimeout(step, operationTimeouts))
        if (res.exitCode !== 0) {
          const detail = (res.stderr || res.stdout || `exit ${res.exitCode}`).trim()
          throw new Error(`step "${step.name}" failed: ${detail}`)
        }
      }
    }

    // 3. Snapshot the provisioned sandbox → the id future sessions boot from.
    if (typeof session.snapshot !== 'function') {
      throw new Error('provider session does not support snapshot() — is this the Vercel provider?')
    }
    out('Snapshotting (the sandbox is stopped as part of this)…\n')
    const snapshotId = await withDeadline(() => session.snapshot(expiration !== undefined ? { expiration } : undefined), 'CAPTURE', operationTimeouts.snapshot,
      lateId => errOut(`error: ALI_1588_SNAPSHOT_LATE_CAPTURE_REQUIRES_RECONCILIATION: ${lateId}\n`), operationTimeouts.lateSettlement,
      () => errOut('error: ALI_1588_SNAPSHOT_LATE_CAPTURE_RECONCILIATION_TIMEOUT\n'))

    out(`\nSnapshot ready: ${snapshotId}\n`)
    out('Use it (zero-Docker prebaked runtime):\n')
    out(`  ORIZU_HOSTED_SNAPSHOT=${snapshotId} orizu session start --hosted --task "…"\n`)
    out(`  # or: orizu session start --hosted --snapshot ${snapshotId} --task "…"\n`)
    if (idFile) {
      writeFileSync(idFile, `${snapshotId}\n`)
      out(`Snapshot id written to ${idFile}\n`)
    }
    return { ok: true, snapshotId, label, cliVersion }
  } catch (error) {
    try { await withDeadline(() => session.destroy(), 'DESTROY', operationTimeouts.destroy) }
    catch (cleanupError) {
      const primary = error instanceof Error ? error : new Error(String(error)), cleanup = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
      throw new AggregateError([primary, cleanup], `${primary.message}; cleanup failed: ${cleanup.message}`)
    }
    throw error
  } finally {
    // The staged bundle is git-ignored; remove it so the context stays clean.
    try {
      rmSync(bundleFile, { force: true })
    } catch {
      // ignore
    }
  }
}

export async function runProvisionSnapshotExecutable(opts) {
  try { return (await runProvisionSnapshot(opts)).ok ? 0 : 1 }
  catch (error) { (opts?.stderr ?? (value => process.stderr.write(value)))(`error: ${error instanceof Error ? error.message : String(error)}\n`); return 1 }
}
if (import.meta.main) process.exitCode = await runProvisionSnapshotExecutable()
