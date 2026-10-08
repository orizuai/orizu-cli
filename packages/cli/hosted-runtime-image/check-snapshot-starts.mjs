#!/usr/bin/env node
/** ORI-2248: start a sandbox from a freshly captured snapshot, check it, stop it.
 * The release bake runs this after capture and before the snapshot becomes
 * current, so a snapshot that cannot start fails the release instead of the
 * first customer run. Runs under bun (the Vercel provider is TS source).
 *
 * Usage: bun check-snapshot-starts.mjs --snapshot <snap_…> --cli-version <semver>
 *   [--braintrust-py-version <v>]   only for a snapshot whose marker records none
 *   [--create-timeout-ms] [--check-timeout-ms]   (tests only; see DEFAULTS)
 * Credentials come from VERCEL_TOKEN (or VERCEL_OIDC_TOKEN), VERCEL_PROJECT_ID
 * and VERCEL_TEAM_ID; only step names and ids are logged. Exit 0 = the snapshot
 * starts and reports the release; 1 = it does not; 2 = bad input. The sandbox
 * is stopped on every path once it exists, and the stop is logged. */

import { parseArgs } from 'node:util'

import { buildEgressPolicy } from '../src/egress-policy.ts'
import { isHostedOptimizationPrebakedMarker } from '../src/hosted-optimization-prebaked-marker.ts'
import { BRAINTRUST_PY_VERSION_RE, publishedBootProof, resolveCredsOrFail, sandboxToolsCheck, withDeadline } from './provision-snapshot.mjs'

/** The workflow passes none of the timeout flags, so these are the release contract. */
export const DEFAULTS = Object.freeze({ createTimeoutMs: 180_000, checkTimeoutMs: 180_000, stopTimeoutMs: 60_000, sandboxLifetimeMs: 1_800_000 })
/** Version, marker, boot proof, source-copy protocol, skilled-proposer venv verify, merge-job tools,
 *  sandbox tools (ripgrep + an app preview, ORI-2258 / ORI-2261). */
const CHECK_COUNT = 7
/** Read-only on a good snapshot: it fails, rather than installs, when the baked
 *  venv cannot be reused (skilled-proposer-launch.ts skilledProposerBakeCommand). */
const SKILLED_PROPOSER_VERIFY = 'orizu internal verify-skilled-proposer-bake --json'
/** The merge job runs git over ssh in this snapshot (merge-sandbox-job plan
 *  D10). `ssh -V` prints its version to stderr. */
const MERGE_JOB_TOOLS = 'git --version && ssh -V'

/** The longest a run can take with the defaults: create, a late sandbox's stop,
 *  every check, then the stop. The workflow step deadline must exceed it. */
export function worstCaseMs() {
  return DEFAULTS.createTimeoutMs + DEFAULTS.stopTimeoutMs + CHECK_COUNT * DEFAULTS.checkTimeoutMs + DEFAULTS.stopTimeoutMs
}

const SNAPSHOT_RE = /^snap_[A-Za-z0-9]+$/
const CLI_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)?$/
const MARKER_PATH = '/opt/orizu/prebaked.json'

class UsageError extends Error {}
const message = error => (error instanceof Error ? error.message : String(error))

function positiveInteger(flag, raw, fallback) {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new UsageError(`invalid --${flag}: ${raw}`)
  return value
}

function resolveOptions(argv, env) {
  let values
  try {
    ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      snapshot: { type: 'string' }, 'cli-version': { type: 'string' }, 'braintrust-py-version': { type: 'string' },
      'create-timeout-ms': { type: 'string' }, 'check-timeout-ms': { type: 'string' },
    } }))
  } catch (error) { throw new UsageError(message(error)) }
  if (!SNAPSHOT_RE.test(values.snapshot ?? '')) throw new UsageError(`--snapshot must be a snapshot id like snap_abc123, got "${values.snapshot ?? ''}"`)
  if (!CLI_VERSION_RE.test(values['cli-version'] ?? '')) throw new UsageError(`--cli-version must be a semver like 0.6.0, got "${values['cli-version'] ?? ''}"`)
  const braintrustPyVersion = values['braintrust-py-version']
  if (braintrustPyVersion !== undefined && !BRAINTRUST_PY_VERSION_RE.test(braintrustPyVersion)) throw new UsageError(`--braintrust-py-version must be a version like 0.30.0, got "${braintrustPyVersion}"`)
  const missing = []
  const creds = resolveCredsOrFail(env, text => missing.push(text))
  if (missing.length) throw new UsageError(missing.join('; '))
  return {
    snapshot: values.snapshot,
    cliVersion: values['cli-version'],
    braintrustPyVersion,
    creds,
    createTimeoutMs: positiveInteger('create-timeout-ms', values['create-timeout-ms'], DEFAULTS.createTimeoutMs),
    checkTimeoutMs: positiveInteger('check-timeout-ms', values['check-timeout-ms'], DEFAULTS.checkTimeoutMs),
    stopTimeoutMs: DEFAULTS.stopTimeoutMs,
  }
}

async function createProvider(creds) {
  const mod = await import(new URL('../src/vercel-sandbox-provider.ts', import.meta.url).href)
  return mod.createVercelProvider(creds)
}

/** Reads the restored marker, applies the coordinator's own marker check, ties
 *  it to this release, and returns the braintrust version it records (else the
 *  flag). */
async function checkMarker(session, { cliVersion, braintrustPyVersion, checkTimeoutMs }, out) {
  out(`- ${MARKER_PATH}\n`)
  const read = await withDeadline(() => session.exec(`cat ${MARKER_PATH}`), 'START_CHECK_MARKER', checkTimeoutMs)
  if (read.exitCode !== 0) throw new Error(`${MARKER_PATH} is unreadable: ${(read.stderr || `exit ${read.exitCode}`).trim()}`)
  if (!isHostedOptimizationPrebakedMarker(read.stdout)) throw new Error(`the prebaked marker fails the coordinator's marker check: ${read.stdout.trim().slice(0, 200)}`)
  const marker = JSON.parse(read.stdout)
  if (marker.cliVersion !== cliVersion) throw new Error(`the prebaked marker records cliVersion "${marker.cliVersion}", expected "${cliVersion}"`)
  if (marker.braintrustPyVersion === undefined) {
    if (braintrustPyVersion === undefined) throw new Error('the prebaked marker records no braintrustPyVersion; pass --braintrust-py-version')
    return braintrustPyVersion
  }
  if (typeof marker.braintrustPyVersion !== 'string' || !BRAINTRUST_PY_VERSION_RE.test(marker.braintrustPyVersion)) {
    throw new Error(`the prebaked marker records an invalid braintrustPyVersion ${JSON.stringify(marker.braintrustPyVersion).slice(0, 80)}`)
  }
  return marker.braintrustPyVersion
}

async function runCheck(session, options, out) {
  const { cliVersion, checkTimeoutMs } = options
  out('- orizu --version\n')
  const version = await withDeadline(() => session.exec('orizu --version'), 'START_CHECK_VERSION', checkTimeoutMs)
  // The CLI prints `orizu <version>` (cli-console-output.ts printVersion).
  const reported = version.stdout.trim(), expected = `orizu ${cliVersion}`
  if (version.exitCode !== 0 || reported !== expected) {
    throw new Error(`orizu --version reported "${reported}" (exit ${version.exitCode}), expected exactly "${expected}"`)
  }
  const braintrustPyVersion = await checkMarker(session, options, out)
  out(`- boot proof (opencode, hosted-loop, workspace bootstrap, claude-agent-sdk, braintrust ${braintrustPyVersion})\n`)
  const proof = await withDeadline(() => session.exec(publishedBootProof(braintrustPyVersion)), 'START_CHECK_BOOT_PROOF', checkTimeoutMs)
  if (proof.exitCode !== 0) throw new Error(`boot proof failed: ${(proof.stderr || proof.stdout || `exit ${proof.exitCode}`).trim()}`)
  out('- source copy capability\n')
  const sourceCopy = await withDeadline(() => session.exec('orizu internal hosted-boot --capability-check'), 'START_CHECK_SOURCE_COPY', checkTimeoutMs)
  if (sourceCopy.exitCode !== 0 || sourceCopy.stdout.trim() !== 'orizu-hosted-source-copy-v1' || sourceCopy.stderr.trim()) {
    throw new Error('source copy capability was not confirmed by the installed CLI')
  }
  out(`- ${SKILLED_PROPOSER_VERIFY}\n`)
  const venv = await withDeadline(() => session.exec(SKILLED_PROPOSER_VERIFY), 'START_CHECK_SKILLED_PROPOSER', checkTimeoutMs)
  if (venv.exitCode !== 0) throw new Error(`skilled-proposer venv verify failed: ${(venv.stderr || venv.stdout || `exit ${venv.exitCode}`).trim()}`)
  out(`- ${MERGE_JOB_TOOLS}\n`)
  const tools = await withDeadline(() => session.exec(MERGE_JOB_TOOLS), 'START_CHECK_MERGE_JOB_TOOLS', checkTimeoutMs)
  const git = tools.stdout.trim(), ssh = tools.stderr.trim()
  if (tools.exitCode !== 0 || !/^git version \S/.test(git) || !/^OpenSSH_\S/.test(ssh)) {
    throw new Error(`merge-job tools check failed (exit ${tools.exitCode}): ${[git, ssh].filter(Boolean).join('; ').slice(0, 300)}`)
  }
  out(`  ${git}; ${ssh}\n`)
  // Runs under the default-deny network policy, so nothing it needs is fetched.
  out('- ripgrep + orizu apps preview on a fixture app\n')
  const sandboxTools = await withDeadline(() => session.exec(sandboxToolsCheck()), 'START_CHECK_SANDBOX_TOOLS', checkTimeoutMs)
  if (sandboxTools.exitCode !== 0) throw new Error(`sandbox tools check failed: ${(sandboxTools.stderr || sandboxTools.stdout || `exit ${sandboxTools.exitCode}`).trim().slice(-500)}`)
}

export async function checkSnapshotStarts(argv = process.argv.slice(2), env = process.env, out = s => process.stdout.write(s), errOut = s => process.stderr.write(s)) {
  let options
  try { options = resolveOptions(argv, env) }
  catch (error) {
    if (!(error instanceof UsageError)) throw error
    errOut(`error: ${error.message}\n`)
    return 2
  }
  const stop = async session => {
    out(`Stopping sandbox ${session.id}…\n`)
    await withDeadline(() => session.destroy(), 'START_CHECK_STOP', options.stopTimeoutMs)
    out(`sandbox ${session.id} stopped\n`)
  }

  out(`Starting a sandbox from ${options.snapshot} to check orizu@${options.cliVersion}…\n`)
  let session
  try {
    const provider = await createProvider(options.creds)
    // Default-deny network, as a hosted session gets (hosted-session-cli.ts), so
    // the checks prove the snapshot needs no download. A late sandbox is stopped.
    session = await withDeadline(() => provider.createSandbox({ snapshot: options.snapshot, timeoutMs: DEFAULTS.sandboxLifetimeMs, egressPolicy: buildEgressPolicy() }), 'START_CHECK_CREATE', options.createTimeoutMs,
      async late => { try { await stop(late) } catch (error) { errOut(`::warning title=Start-check sandbox not stopped::${message(error)}\n`) } }, options.stopTimeoutMs)
  } catch (error) {
    errOut(`error: no sandbox started from ${options.snapshot}: ${message(error)}\n`)
    return 1
  }
  out(`sandbox ${session.id}\n`)

  let failure
  try { await runCheck(session, options, out) }
  catch (error) { failure = error }
  try { await stop(session) }
  catch (error) {
    // The sandbox's own lifetime caps what a failed stop leaks, so cleanup
    // alone never fails a sound release.
    errOut(`::warning title=Start-check sandbox not stopped::sandbox ${session.id}: ${message(error)}\n`)
  }
  if (failure) {
    errOut(`error: the sandbox started from ${options.snapshot} failed its check: ${message(failure)}\n`)
    return 1
  }
  out(`Snapshot ${options.snapshot} starts and reports orizu@${options.cliVersion}.\n`)
  return 0
}

if (import.meta.main) process.exitCode = await checkSnapshotStarts()
