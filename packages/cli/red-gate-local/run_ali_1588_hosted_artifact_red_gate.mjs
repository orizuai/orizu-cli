#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildCliBundle } from '../hosted-runtime-image/build-cli-bundle.mjs'
import { sourceAssetPayload } from '../hosted-runtime-image/provision-snapshot.mjs'
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const contextRoot = repoRoot
const dockerfilePath = resolve(repoRoot, 'packages/cli/hosted-runtime-image/Dockerfile')
const bundlePath = resolve(repoRoot, 'packages/cli/hosted-runtime-image/dist/orizu.js')
const assetsPath = resolve(repoRoot, 'packages/cli/hosted-runtime-image/dist/skilled-proposer-assets.json')
const vendorRoot = resolve(here, '../vendor')
const vendorScript = resolve(here, '../scripts/vendor-gepa-python.mjs')
export const PROBE_PREFIX = `orizu-ali-1588-probe-${randomUUID()}`
export const PROBE_IMAGE = `${PROBE_PREFIX}:local`
export const PROBE_CONTAINER = PROBE_PREFIX
export const PROBE_TIMEOUTS = { vendor: 3_000, bundle: 10_000, build: 20 * 60_000, sentinel: 8_000, inspect: 2_000, remove: 4_000, container: 300_000, audit: 1_000, outer: 28 * 60_000 }
export const ARTIFACT_CONTAINER_TIMEOUT = PROBE_TIMEOUTS.container
export const ARTIFACT_GNU_TIMEOUT = 290_000
let lastDockerEnv
export function getProbeDockerEnv() { return lastDockerEnv }
export function run(label, command, args, options = {}, spawn = spawnSync) {
  process.stdout.write(`\n[ALI-1588] ${label}\n`)
  const result = spawn(command, args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error || result.status !== 0) {
    const reason = result.error?.message || result.stderr?.trim() || `exit ${result.status}`
    throw new Error(`ALI_1588_${label.replaceAll(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_FAILED: ${reason}`)
  }
  return result
}
export function removeDockerTarget(kind, target, dockerEnv) {
  const inspect = spawnSync('docker', [kind, 'inspect', target], { encoding: 'utf8', timeout: PROBE_TIMEOUTS.inspect, env: dockerEnv })
  if (inspect.error) throw new Error(`ALI_1588_DOCKER_${kind.toUpperCase()}_INSPECT_FAILED: ${inspect.error.message}`)
  if (inspect.status !== 0) {
    if (/No such (?:container|image)/i.test(inspect.stderr)) return
    throw new Error(`ALI_1588_DOCKER_${kind.toUpperCase()}_INSPECT_FAILED: ${(inspect.stderr || `exit ${inspect.status}`).trim()}`)
  }
  const remove = spawnSync('docker', [kind, 'rm', '--force', target], { encoding: 'utf8', timeout: PROBE_TIMEOUTS.remove, env: dockerEnv })
  if (remove.error || remove.status !== 0) {
    const detail = remove.error?.message || remove.stderr || `exit ${remove.status}`
    throw new Error(`ALI_1588_DOCKER_${kind.toUpperCase()}_CLEANUP_FAILED: ${detail.trim()}`)
  }
}
export function cleanupAll(actions) {
  const failures = []
  for (const [label, action] of actions) {
    try { action() } catch (error) { failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (failures.length) throw new Error(`ALI_1588_PROBE_CLEANUP_FAILED: ${failures.join('; ')}`)
}
export function main(work, actions) {
  let primary, hasPrimary = false
  try { work() } catch (error) { primary = error; hasPrimary = true }
  try { cleanupAll(actions) } catch (cleanupError) {
    if (hasPrimary) throw new AggregateError([primary, cleanupError], 'ALI_1588_PRIMARY_AND_CLEANUP_FAILED')
    throw cleanupError
  }
  if (hasPrimary) throw primary
}
export function probeCleanupActions({
  dockerEnv, vendorAlreadyPresent, dockerConfigRoot,
  containerTarget = PROBE_CONTAINER, imageTarget = PROBE_IMAGE, bundleTarget = bundlePath, vendorExecutable = 'node',
}) {
  return [
    ['container', () => removeDockerTarget('container', containerTarget, dockerEnv)],
    ['bundle', () => rmSync(bundleTarget, { force: true })],
    ['assets', () => rmSync(assetsPath, { force: true })],
    ['vendor', () => {
      if (vendorAlreadyPresent) return
      const result = spawnSync(vendorExecutable, [vendorScript, '--clean'], { cwd: repoRoot, encoding: 'utf8', timeout: PROBE_TIMEOUTS.vendor, env: dockerEnv })
      if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `exit ${result.status}`)
    }],
    ['image', () => removeDockerTarget('image', imageTarget, dockerEnv)],
    ['docker-config', () => rmSync(dockerConfigRoot, { recursive: true, force: true })],
  ]
}
export function productionWork({ dockerEnv, vendorAlreadyPresent, runCommand = run, bundleBuilder = buildCliBundle }) {
 return () => {
  if (!vendorAlreadyPresent) runCommand('materialize pinned GEPA fixture', 'node', [vendorScript], { timeout: PROBE_TIMEOUTS.vendor })
  bundleBuilder(bundlePath, PROBE_TIMEOUTS.bundle)
  mkdirSync(dirname(assetsPath), { recursive: true })
  writeFileSync(assetsPath, sourceAssetPayload())
  try { runCommand('build linux amd64 hosted image', 'docker', ['build', '--file', dockerfilePath, '--platform', 'linux/amd64', '--tag', PROBE_IMAGE, contextRoot], { timeout: PROBE_TIMEOUTS.build, env: dockerEnv }) }
  catch (error) {
    try {
      runCommand('seed confined failure image', 'docker', ['build', '--tag', PROBE_IMAGE, '-'], { input: 'FROM scratch\n', timeout: PROBE_TIMEOUTS.sentinel, env: dockerEnv })
      runCommand('seed confined failure container', 'docker', ['container', 'create', '--name', PROBE_CONTAINER, PROBE_IMAGE, '/bin/true'], { timeout: PROBE_TIMEOUTS.sentinel, env: dockerEnv })
    } catch (seedError) { throw new AggregateError([error, seedError], 'ALI_1588_BUILD_AND_SENTINEL_FAILED') }
    throw error
  }
  runCommand('egress denied skilled proposer launch', 'docker', [
    'run', '--name', PROBE_CONTAINER, '--rm', '--platform', 'linux/amd64', '--network', 'none',
    '--workdir', '/vercel/sandbox/repo', PROBE_IMAGE, 'timeout', '--signal=KILL', '--kill-after=1s', `${ARTIFACT_GNU_TIMEOUT / 1000}s`, 'bun', '/opt/orizu/cli/red-gate-local/verify_ali_1588_hosted_artifact.ts',
  ], { timeout: ARTIFACT_CONTAINER_TIMEOUT, env: dockerEnv })
 }
}
export function assertNoPreexistingVendorState(root = vendorRoot) {
 if (['orizu-gepa-python', 'orizu-gepa', 'gepa-python'].some(name => existsSync(resolve(root, name)))) throw new Error('ALI_1588_PREEXISTING_VENDOR_STATE: refusing to replace pre-existing vendor content')
}
export function runProductionProbe(injected) {
 let work, actions
 const guardedVendorRoot = injected?.vendorRoot ?? (injected ? null : vendorRoot)
 if (guardedVendorRoot) assertNoPreexistingVendorState(guardedVendorRoot)
 if (injected) ({ work, actions } = injected)
 else {
  const dockerConfigRoot = mkdtempSync(resolve(tmpdir(), 'orizu-ali-1588-docker-'))
  const dockerEnv = { ...process.env, DOCKER_CONFIG: dockerConfigRoot }
  lastDockerEnv = dockerEnv
  work = productionWork({ dockerEnv, vendorAlreadyPresent: false })
  actions = probeCleanupActions({ dockerEnv, vendorAlreadyPresent: false, dockerConfigRoot })
 }
 return main(work, actions)
}
if (import.meta.url === `file://${process.argv[1]}`) runProductionProbe()
