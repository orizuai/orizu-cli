import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, join } from 'node:path'
import { devNull } from 'node:os'

const PYTHON_IDENTITY_PROGRAM = String.raw`
import json
import os
import platform
import sys
import sysconfig

print(json.dumps({
    "implementation": platform.python_implementation(),
    "version": list(sys.version_info[:3]),
    "executable": os.path.realpath(sys.executable),
    "platform": sysconfig.get_platform(),
    "cacheTag": sys.implementation.cache_tag,
    "soabi": sysconfig.get_config_var("SOABI"),
    "system": platform.system(),
    "machine": platform.machine(),
    "osVersion": platform.mac_ver()[0] if platform.system() == "Darwin" else platform.release(),
    "libc": list(platform.libc_ver()),
}))
`

const SSL_CERT_FILE_PROGRAM = String.raw`
import os
import ssl

paths = ssl.get_default_verify_paths()
for candidate in (paths.cafile, paths.openssl_cafile):
    if candidate and os.path.isfile(candidate):
        print(os.path.realpath(candidate))
        break
`

const IMPORT_SMOKE_PROGRAM = String.raw`
import dspy
import skilled_proposer
from skilled_proposer import SkilledProposer

SkilledProposer(skills=[])
`

const PUBLISH_LOCK_PROGRAM = String.raw`
import fcntl
import os
import signal
import sys
import time

descriptor = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)
try:
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("waiting", flush=True)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
    node_pid = int(sys.argv[2])
    guardian_pid = os.fork()
    if guardian_pid == 0:
        for stream_descriptor in (0, 1, 2):
            try:
                os.close(stream_descriptor)
            except OSError:
                pass
        signal.signal(signal.SIGTERM, lambda _signal, _frame: sys.exit(0))
        deadline = time.monotonic() + (25 * 60)
        while time.monotonic() < deadline:
            try:
                os.kill(node_pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        sys.exit(0)
    print(f"guardian:{guardian_pid}", flush=True)
    print("acquired", flush=True)
    sys.stdin.readline()
    try:
        os.kill(guardian_pid, signal.SIGTERM)
        os.waitpid(guardian_pid, 0)
    except ProcessLookupError:
        pass
finally:
    os.close(descriptor)
`

const MANAGER_SCHEMA_VERSION = 1
const MANIFEST_NAME = '.orizu-skilled-proposer-venv.json'
const LOCK_WAIT_MILLISECONDS = 25
// This exceeds the longest repair path while holding the lock: existing-cache
// validation (2m) + venv (2m) + install (10m) + staged validation (2m), plus
// cleanup/publication/release margin.
const LOCK_TIMEOUT_MILLISECONDS = 20 * 60 * 1000
const PYTHON_PROBE_TIMEOUT_MILLISECONDS = 15_000
const VENV_CREATE_TIMEOUT_MILLISECONDS = 2 * 60 * 1000
const VALIDATION_TIMEOUT_MILLISECONDS = 60_000
const PIP_INSTALL_TIMEOUT_MILLISECONDS = 10 * 60 * 1000
const TEST_BARRIER_TIMEOUT_MILLISECONDS = 60_000
const ABANDONED_STAGE_MAX_AGE_MILLISECONDS = 24 * 60 * 60 * 1000
const SSL_CERT_FILE_UNRESOLVED_WARNING = {
  code: 'ALI_1505_SSL_CERT_FILE_UNRESOLVED',
  message: 'no system CA bundle was resolved; pip will use its bundled trust store, but provider traffic may require SSL_CERT_FILE',
}

export class SkilledProposerVenvError extends Error {
  constructor(code, message, report = {}) {
    super(message)
    this.name = 'SkilledProposerVenvError'
    this.code = code
    this.report = report
  }
}

export function parseManagerArguments(argv) {
  const options = { json: false, noIndex: false }
  const valueOptions = new Map([
    ['--python', 'python'],
    ['--cache-root', 'cacheRoot'],
    ['--lock', 'lock'],
    ['--wheelhouse', 'wheelhouse'],
    ['--vendored-gepa-path', 'vendoredGepaPath'],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') {
      options.json = true
      continue
    }
    if (argument === '--no-index') {
      options.noIndex = true
      continue
    }
    const key = valueOptions.get(argument)
    if (!key) {
      throw new SkilledProposerVenvError('ALI_1505_INVALID_ARGUMENT', `unknown argument: ${argument}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new SkilledProposerVenvError('ALI_1505_INVALID_ARGUMENT', `${argument} requires a value`)
    }
    options[key] = value
    index += 1
  }
  for (const key of ['python', 'cacheRoot', 'lock']) {
    if (!options[key]) {
      throw new SkilledProposerVenvError('ALI_1505_INVALID_ARGUMENT', `--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required`)
    }
  }
  if (options.noIndex && !options.wheelhouse) {
    throw new SkilledProposerVenvError('ALI_1505_INVALID_ARGUMENT', '--no-index requires --wheelhouse')
  }
  return options
}

function parsePythonIdentity(stdout, configuredPython) {
  const trimmed = stdout.trim()
  try {
    const value = JSON.parse(trimmed)
    if (Array.isArray(value.version) && value.version.length >= 2) return value
  } catch {
    // The approved outer red gate uses a deliberately tiny fake executable
    // that prints only a version. This preserves mutation-free preflight.
  }
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(trimmed)
  if (match) {
    const version = match.slice(1).map(Number)
    const [major, minor] = version
    if (major !== 3 || minor < 10 || minor >= 15) {
      return {
        implementation: 'CPython',
        version,
        executable: configuredPython,
        platform: 'unsupported-version-probe',
      }
    }
  }
  throw new SkilledProposerVenvError(
    'ALI_1505_PYTHON_PREFLIGHT_FAILED',
    `unable to characterize selected Python: ${configuredPython}`,
  )
}

function versionAtLeast(actual, required) {
  const parts = String(actual).split('.').map(part => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < required.length; index += 1) {
    if ((parts[index] || 0) > required[index]) return true
    if ((parts[index] || 0) < required[index]) return false
  }
  return true
}

function assertSupportedWheelTarget(identity) {
  // `platform.libc_ver()` is not merely cache identity on Linux: it is also a
  // conservative admission check for the locked glibc wheel matrix. A bad
  // guess can refuse a compatible host (named, before mutation), but cannot
  // admit an sdist or make pip install an incompatible wheel because the
  // customer install remains hash-locked and binary-only.
  const machine = String(identity.machine).toLowerCase()
  const isSupportedMac = identity.system === 'Darwin'
    && machine === 'arm64'
    && versionAtLeast(identity.osVersion, [15])
  const [libcName, libcVersion] = Array.isArray(identity.libc) ? identity.libc : []
  const isSupportedLinux = identity.system === 'Linux'
    && ['x86_64', 'amd64'].includes(machine)
    && libcName === 'glibc'
    && versionAtLeast(libcVersion, [2, 28])
  if (!isSupportedMac && !isSupportedLinux) {
    throw new SkilledProposerVenvError(
      'ALI_1505_NO_LOCKED_BINARY_WHEEL',
      `the skilled-proposer lock has no admitted wheel target for ${identity.system} ${identity.machine} (${identity.platform}, ${libcName || 'unknown-libc'} ${libcVersion || ''})`,
    )
  }
}

function spawnPython(python, args, env, timeout = PYTHON_PROBE_TIMEOUT_MILLISECONDS) {
  return spawnSync(python, args, { encoding: 'utf8', env, timeout })
}

function isolatedPythonProbeEnv() {
  const env = { ...process.env, PYTHONNOUSERSITE: '1' }
  for (const name of Object.keys(env)) {
    if (name.startsWith('PIP_')) delete env[name]
  }
  for (const name of [
    'PYTHONHOME',
    'PYTHONPATH',
    'PYTHONUSERBASE',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
  ]) delete env[name]
  env.PIP_CONFIG_FILE = devNull
  env.PIP_DISABLE_PIP_VERSION_CHECK = '1'
  env.PIP_NO_INPUT = '1'
  return env
}

export function characterizePython(python, probeEnv = isolatedPythonProbeEnv()) {
  const result = spawnPython(python, ['-c', PYTHON_IDENTITY_PROGRAM], probeEnv)
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr || result.stdout || 'no subprocess output'
    throw new SkilledProposerVenvError(
      'ALI_1505_PYTHON_PREFLIGHT_FAILED',
      `selected Python preflight failed: ${detail.trim()}`,
    )
  }
  const identity = parsePythonIdentity(result.stdout, python)
  const [major, minor] = identity.version
  if (String(identity.implementation).toLowerCase() !== 'cpython'
      || major !== 3 || minor < 10 || minor >= 15) {
    throw new SkilledProposerVenvError(
      'ALI_1505_UNSUPPORTED_CPYTHON',
      `skilled-proposer requires CPython >=3.10,<3.15; received ${identity.implementation} ${identity.version.join('.')}`,
    )
  }
  assertSupportedWheelTarget(identity)
  return {
    ...identity,
    executable: realpathSync(identity.executable),
  }
}

function readAndValidateHashLock(lockPath) {
  let contents
  try {
    contents = readFileSync(lockPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new SkilledProposerVenvError(
        'ALI_1505_LOCK_MISSING',
        `skilled-proposer lock file does not exist: ${lockPath}`,
      )
    }
    throw error
  }

  const requirements = []
  let pending = ''
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    pending += `${pending ? ' ' : ''}${trimmed.replace(/\\$/, '').trim()}`
    if (!trimmed.endsWith('\\')) {
      requirements.push(pending)
      pending = ''
    }
  }
  if (pending) requirements.push(pending)
  if (requirements.length === 0) {
    throw new SkilledProposerVenvError(
      'ALI_1505_LOCK_UNHASHED_REQUIREMENT',
      `skilled-proposer lock file contains no requirements: ${lockPath}`,
    )
  }
  for (const requirement of requirements) {
    const isExactPin = /^[A-Za-z0-9_.-]+(?:\[[^\]]+\])?==[^\s;]+/.test(requirement)
    const hashes = [...requirement.matchAll(/(?:^|\s)--hash=([^\s]+)/g)].map(match => match[1])
    const hashTokens = [...requirement.matchAll(/(?:^|\s)(--hash(?:=[^\s]*)?)(?=\s|$)/g)]
      .map(match => match[1])
    const hasMalformedHash = hashes.some(hash => !/^sha256:[a-fA-F0-9]{64}$/.test(hash))
      || hashTokens.length !== hashes.length
    if (hasMalformedHash) {
      throw new SkilledProposerVenvError(
        'ALI_1505_LOCK_FORMAT_INVALID',
        `dependency contains a malformed sha256 hash: ${requirement}`,
      )
    }
    if (!isExactPin || hashes.length === 0) {
      throw new SkilledProposerVenvError(
        'ALI_1505_LOCK_UNHASHED_REQUIREMENT',
        `every dependency must be an exact pin with a sha256 hash: ${requirement}`,
      )
    }
  }
  return contents
}

function resolveSslCertFile(pythonIdentity, probeEnv) {
  if (process.env.SSL_CERT_FILE) return process.env.SSL_CERT_FILE
  if (testHook('ORIZU_ALI1505_TEST_FORCE_CA_UNRESOLVED') === '1') return null
  const result = spawnPython(pythonIdentity.executable, ['-c', SSL_CERT_FILE_PROGRAM], probeEnv)
  const candidate = result.status === 0 ? result.stdout.trim() : ''
  if (candidate && existsSync(candidate)) return candidate
  for (const commonPath of [
    '/etc/ssl/cert.pem',
    '/etc/ssl/certs/ca-certificates.crt',
    '/etc/pki/tls/certs/ca-bundle.crt',
  ]) {
    if (existsSync(commonPath)) return commonPath
  }
  return null
}

function buildPublishKey(pythonIdentity, lockContents) {
  const lockDigest = createHash('sha256').update(lockContents).digest('hex')
  const identity = {
    managerSchemaVersion: MANAGER_SCHEMA_VERSION,
    implementation: pythonIdentity.implementation,
    version: pythonIdentity.version,
    executable: pythonIdentity.executable,
    platform: pythonIdentity.platform,
    cacheTag: pythonIdentity.cacheTag,
    soabi: pythonIdentity.soabi,
    system: pythonIdentity.system,
    machine: pythonIdentity.machine,
    osVersion: pythonIdentity.osVersion,
    libc: pythonIdentity.libc,
    lockDigest,
  }
  return {
    lockDigest,
    publishKey: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
  }
}

function venvPython(venv) {
  return process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
}

function runChecked(
  python,
  args,
  env,
  code,
  description,
  report = {},
  timeout = VALIDATION_TIMEOUT_MILLISECONDS,
) {
  const result = spawnPython(python, args, env, timeout)
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr || result.stdout || 'no subprocess output'
    throw new SkilledProposerVenvError(code, `${description}: ${detail.trim()}`, report)
  }
}

function readValidManifest(venv, publishKey, lockDigest) {
  try {
    const manifest = JSON.parse(readFileSync(join(venv, MANIFEST_NAME), 'utf8'))
    if (manifest.managerSchemaVersion !== MANAGER_SCHEMA_VERSION) return null
    if (manifest.publishKey !== publishKey || manifest.lockDigest !== lockDigest) return null
    if (!existsSync(join(venv, 'pyvenv.cfg'))) return null
    if (!existsSync(venvPython(venv))) return null
    return manifest
  } catch {
    return null
  }
}

function smokeEnvironment(childEnv, pythonPathEntries) {
  return {
    ...childEnv,
    PYTHONPATH: pythonPathEntries.join(delimiter),
  }
}

function validatePublishedVenv(venv, manifest, childEnv, pythonPathEntries) {
  if (!manifest) return null
  try {
    const python = venvPython(venv)
    runChecked(
      python,
      ['-m', 'pip', 'check'],
      childEnv,
      'ALI_1505_PIP_CHECK_FAILED',
      'published venv failed pip check',
    )
    runChecked(
      python,
      ['-c', IMPORT_SMOKE_PROGRAM],
      smokeEnvironment(childEnv, pythonPathEntries),
      'ALI_1505_IMPORT_SMOKE_FAILED',
      'published venv failed import smoke test',
    )
    return manifest
  } catch {
    return null
  }
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function testHook(name) {
  if (process.env.ORIZU_ALI1505_TEST_HOOKS !== '1') return undefined
  return process.env[name]
}

async function waitAtTestBarrier(cacheRoot) {
  const barrier = testHook('ORIZU_ALI1505_TEST_START_BARRIER')
  if (!barrier) return
  const readyDirectory = join(cacheRoot, 'test-start-barrier-ready')
  mkdirSync(readyDirectory, { recursive: true })
  writeFileSync(join(readyDirectory, `${process.pid}-${randomUUID()}`), '')
  const startedAt = Date.now()
  while (existsSync(barrier)) {
    if (Date.now() - startedAt >= TEST_BARRIER_TIMEOUT_MILLISECONDS) {
      throw new SkilledProposerVenvError(
        'ALI_1505_TEST_START_BARRIER_TIMEOUT',
        `timed out waiting for ALI-1505 test barrier: ${barrier}`,
      )
    }
    await wait(LOCK_WAIT_MILLISECONDS)
  }
}

function acquirePublishLock(python, lockFile, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-u', '-c', PUBLISH_LOCK_PROGRAM, lockFile, String(process.pid)], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let waitedForPublishLock = false
    let acquired = false
    let guardianPid = null
    const timeout = setTimeout(() => {
      child.kill()
      reject(new SkilledProposerVenvError(
        'ALI_1505_PUBLISH_LOCK_TIMEOUT',
        `timed out waiting for publish lock: ${lockFile}`,
        { waitedForPublishLock: true },
      ))
    }, LOCK_TIMEOUT_MILLISECONDS)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdout.on('data', chunk => {
      stdout += chunk
      const lines = stdout.split(/\r?\n/)
      stdout = lines.pop() || ''
      for (const line of lines) {
        if (line === 'waiting') waitedForPublishLock = true
        if (line.startsWith('guardian:')) guardianPid = Number.parseInt(line.slice('guardian:'.length), 10)
        if (line === 'acquired' && !acquired) {
          acquired = true
          clearTimeout(timeout)
          if (!Number.isSafeInteger(guardianPid) || guardianPid <= 0) {
            child.kill()
            reject(new SkilledProposerVenvError(
              'ALI_1505_PUBLISH_LOCK_FAILED',
              'publish-lock holder did not report a guardian process',
              { waitedForPublishLock },
            ))
            return
          }
          resolve({ child, guardianPid, waitedForPublishLock })
        }
      }
    })
    child.once('error', error => {
      if (acquired) return
      clearTimeout(timeout)
      reject(new SkilledProposerVenvError(
        'ALI_1505_PUBLISH_LOCK_FAILED',
        `failed to start publish-lock holder: ${error.message}`,
        { waitedForPublishLock },
      ))
    })
    child.once('exit', (code, signal) => {
      if (acquired) return
      clearTimeout(timeout)
      reject(new SkilledProposerVenvError(
        'ALI_1505_PUBLISH_LOCK_FAILED',
        `publish-lock holder exited before acquisition (${signal || code}): ${stderr.trim() || stdout.trim() || 'no subprocess output'}`,
        { waitedForPublishLock },
      ))
    })
  })
}

async function releasePublishLock(lock) {
  if (!lock?.child) return
  if (lock.child.exitCode !== null || lock.child.signalCode !== null) {
    try {
      process.kill(lock.guardianPid, 'SIGTERM')
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
    return
  }
  const exited = new Promise(resolve => lock.child.once('exit', resolve))
  lock.child.stdin.end('release\n')
  const timeout = setTimeout(() => lock.child.kill(), PYTHON_PROBE_TIMEOUT_MILLISECONDS)
  await exited
  clearTimeout(timeout)
}

async function killPublishLockLeaderAtTestHook(lock) {
  if (testHook('ORIZU_ALI1505_TEST_KILL_PUBLISH_LOCK_LEADER') !== 'after-acquire') return
  const exited = new Promise(resolve => lock.child.once('exit', resolve))
  lock.child.kill('SIGKILL')
  await exited
}

function removeAbandonedStages(venvsRoot, publishKey) {
  const stagePrefix = `.${publishKey}-`
  for (const entry of readdirSync(venvsRoot)) {
    const stagePath = join(venvsRoot, entry)
    const isCurrentKeyStage = entry.startsWith(stagePrefix) && entry.endsWith('.tmp')
    const isManagedStage = /^\.[a-f0-9]{64}-.+\.tmp$/.test(entry)
    let isAgedOtherKeyStage = false
    if (isManagedStage) {
      try {
        isAgedOtherKeyStage = Date.now() - statSync(stagePath).mtimeMs
          >= ABANDONED_STAGE_MAX_AGE_MILLISECONDS
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
    }
    // The current publish lock makes every same-key stage abandoned. Across
    // keys, the 24-hour floor is well above the 25-minute guardian lifetime,
    // so an admitted live builder is never collected without its own lock.
    if (isCurrentKeyStage || isAgedOtherKeyStage) {
      rmSync(stagePath, { recursive: true, force: true })
    }
  }
}

function installArguments(options, stagePython) {
  const args = [
    stagePython,
    '-m', 'pip', 'install',
    '--require-hashes',
    '--only-binary=:all:',
  ]
  if (options.noIndex) args.push('--no-index', '--find-links', options.wheelhouse)
  args.push('--requirement', options.lock)
  return args
}

function installFailureCode(result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  if (/do not match the hashes|hash mismatch/i.test(output)) {
    return 'ALI_1505_ARTIFACT_HASH_MISMATCH'
  }
  if (/hashes are required/i.test(output)) return 'ALI_1505_LOCK_UNHASHED_REQUIREMENT'
  if (/no matching distribution|could not find a version|not a supported wheel/i.test(output)) {
    return 'ALI_1505_NO_LOCKED_BINARY_WHEEL'
  }
  return 'ALI_1505_PIP_INSTALL_FAILED'
}

function isolatedChildEnv(sslCertFile) {
  const env = { ...isolatedPythonProbeEnv() }
  if (sslCertFile) env.SSL_CERT_FILE = sslCertFile
  else delete env.SSL_CERT_FILE
  return env
}

export async function ensureSkilledProposerVenv(options) {
  // This must stay first: unsupported interpreters may not create cache state or
  // invoke a mutating `python -m` command.
  const probeEnv = isolatedPythonProbeEnv()
  const pythonIdentity = characterizePython(options.python, probeEnv)
  const lockContents = readAndValidateHashLock(options.lock)
  const sslCertFile = resolveSslCertFile(pythonIdentity, probeEnv)
  const childEnv = isolatedChildEnv(sslCertFile)
  const { lockDigest, publishKey } = buildPublishKey(pythonIdentity, lockContents)
  const finalVenv = join(options.cacheRoot, 'venvs', publishKey)
  const lockFile = join(options.cacheRoot, 'publish-locks', `${publishKey}.lock`)
  const pythonPathEntries = options.vendoredGepaPath ? [options.vendoredGepaPath] : []
  const baseReport = {
    venv: finalVenv,
    publishKey,
    publishedVenv: false,
    waitedForPublishLock: false,
    pythonPathEntries,
    executedPipArgv: null,
    sslCertFile,
    warnings: sslCertFile ? [] : [SSL_CERT_FILE_UNRESOLVED_WARNING],
  }

  mkdirSync(join(options.cacheRoot, 'venvs'), { recursive: true })
  mkdirSync(join(options.cacheRoot, 'publish-locks'), { recursive: true })
  await waitAtTestBarrier(options.cacheRoot)

  const existing = validatePublishedVenv(
    finalVenv,
    readValidManifest(finalVenv, publishKey, lockDigest),
    childEnv,
    pythonPathEntries,
  )
  if (existing) return baseReport

  const lock = await acquirePublishLock(pythonIdentity.executable, lockFile, childEnv)
  await killPublishLockLeaderAtTestHook(lock)
  const lockedReport = { ...baseReport, waitedForPublishLock: lock.waitedForPublishLock }

  const stage = join(options.cacheRoot, 'venvs', `.${publishKey}-${process.pid}-${randomUUID()}.tmp`)
  try {
    // Holding the per-key publish lock proves that no live builder for this key
    // can own one of these sibling staging directories.
    removeAbandonedStages(join(options.cacheRoot, 'venvs'), publishKey)
    const afterLockExisting = validatePublishedVenv(
      finalVenv,
      readValidManifest(finalVenv, publishKey, lockDigest),
      childEnv,
      pythonPathEntries,
    )
    if (afterLockExisting) {
      return lockedReport
    }
    if (existsSync(finalVenv)) rmSync(finalVenv, { recursive: true, force: true })

    runChecked(
      pythonIdentity.executable,
      ['-m', 'venv', stage],
      childEnv,
      'ALI_1505_VENV_CREATE_FAILED',
      'failed to create staged venv',
      lockedReport,
      VENV_CREATE_TIMEOUT_MILLISECONDS,
    )
    const stagePython = venvPython(stage)
    const executedPipArgv = installArguments(options, stagePython)
    const installingReport = { ...lockedReport, executedPipArgv }
    const installResult = spawnPython(
      stagePython,
      executedPipArgv.slice(1),
      childEnv,
      PIP_INSTALL_TIMEOUT_MILLISECONDS,
    )
    if (installResult.error || installResult.status !== 0) {
      const detail = installResult.error?.message || installResult.stderr || installResult.stdout || 'no subprocess output'
      throw new SkilledProposerVenvError(
        installFailureCode(installResult),
        `failed to install locked dependencies: ${detail.trim()}`,
        installingReport,
      )
    }

    if (testHook('ORIZU_ALI1505_TEST_INTERRUPT_AFTER') === 'staged-install') {
      throw new SkilledProposerVenvError(
        'ALI_1505_TEST_INTERRUPT_AFTER_STAGED_INSTALL',
        'interrupted after staged install by ALI-1505 test hook',
        { ...installingReport, publishedVenv: null },
      )
    }

    runChecked(
      stagePython,
      ['-m', 'pip', 'check'],
      childEnv,
      'ALI_1505_PIP_CHECK_FAILED',
      'staged venv failed pip check',
      installingReport,
    )
    runChecked(
      stagePython,
      ['-c', IMPORT_SMOKE_PROGRAM],
      smokeEnvironment(childEnv, pythonPathEntries),
      'ALI_1505_IMPORT_SMOKE_FAILED',
      'staged venv failed import smoke test',
      installingReport,
    )
    writeFileSync(join(stage, MANIFEST_NAME), `${JSON.stringify({
      managerSchemaVersion: MANAGER_SCHEMA_VERSION,
      publishKey,
      lockDigest,
      pythonIdentity,
      executedPipArgv,
    }, null, 2)}\n`)
    try {
      renameSync(stage, finalVenv)
    } catch (error) {
      throw new SkilledProposerVenvError(
        'ALI_1505_VENV_PUBLISH_FAILED',
        `failed to publish the validated venv atomically: ${error instanceof Error ? error.message : String(error)}`,
        installingReport,
      )
    }
    return { ...installingReport, publishedVenv: true }
  } finally {
    rmSync(stage, { recursive: true, force: true })
    await releasePublishLock(lock)
  }
}

export async function runManagerCli(argv) {
  let options = { json: argv.includes('--json') }
  try {
    options = parseManagerArguments(argv)
    const report = await ensureSkilledProposerVenv(options)
    process.stdout.write(`${JSON.stringify(report)}\n`)
    return 0
  } catch (error) {
    const managedError = error instanceof SkilledProposerVenvError
      ? error
      : new SkilledProposerVenvError('ALI_1505_VENV_MANAGER_FAILED', String(error))
    if (options.json) {
      process.stdout.write(`${JSON.stringify({
        error: managedError.code,
        message: managedError.message,
        ...managedError.report,
        publishedVenv: null,
      })}\n`)
    }
    process.stderr.write(`${managedError.code}: ${managedError.message}\n`)
    return 1
  }
}
