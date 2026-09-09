import { spawn, spawnSync } from 'child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { stderr as errorOutput, stdout as output } from 'process'

import { parseGlobalFlags } from './global-flags.js'
import { sanitizeTerminalText } from './json-response.js'
import { findUnknownOption } from './option-validation.js'

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000, CHECK_TIMEOUT_MS = 5_000, CHILD_TIMEOUT_MS = 60_000
// A claim file outliving this window belongs to a process that died mid-claim;
// treating it as live would silently disable the daily refresh forever.
const ABANDONED_CLAIM_MS = 60_000
const STDERR_TAIL_CHARS = 4_000
const MANUAL_INSTALL_COMMAND = 'npm i -g orizu@latest'
const UPDATE_OPTIONS = new Set(['--dry-run', '--json', '--refresh-cache'])
const UPDATE_USAGE = 'Usage: orizu update [--dry-run] [--json]'

interface UpdateCache { checkedAt: string; latest: string | null }
interface GlobalInstall { binPath: string; prefix: string }
interface CommandResult { status: number; stderr: string; stdout?: string; timedOut: boolean }
interface Invocation { command: string; args: string[] }
interface UpdateResult { installed: string; latest: string | null; action: string; prefix: string | null; skills: string }

export interface SelfUpdateIo {
  dryRun: boolean; installed: string; json: boolean; refreshCache: boolean
  printLine(message?: string): void; printError(message: string): void
}

interface UpdateCommandIo {
  getCliVersion(): string
  json: boolean
  printLine(message?: string): void
  printError(message: string): void
}

export interface PassiveUpdateState { cache: UpdateCache | null; install: GlobalInstall; installed: string }
export interface PassiveUpdateIo { exit(code: number): void; spawn: typeof spawn }
export const defaultPassiveUpdateIo: PassiveUpdateIo = { exit: process.exit, spawn }
interface Semver { core: [bigint, bigint, bigint]; prerelease: string[] }

function parseSemver(value: string): Semver {
  const match = value.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
  )
  if (!match) throw new Error(`invalid semantic version '${value}'`)
  return {
    core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    prerelease: match[4]?.split('.') ?? [],
  }
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left)
  const b = parseSemver(right)
  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index]! > b.core[index]!) return 1
    if (a.core[index]! < b.core[index]!) return -1
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const aPart = a.prerelease[index]
    const bPart = b.prerelease[index]
    if (aPart === undefined || bPart === undefined) return aPart === undefined ? -1 : 1
    if (aPart === bPart) continue
    const aNumeric = /^\d+$/u.test(aPart)
    const bNumeric = /^\d+$/u.test(bPart)
    if (aNumeric && bNumeric) return BigInt(aPart) > BigInt(bPart) ? 1 : -1
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return aPart > bPart ? 1 : -1
  }
  return 0
}

export function detectNpmGlobalInstall(entry = process.argv[1]): GlobalInstall | null {
  if (process.platform === 'win32') return null
  if (!entry) return null
  let current: string
  try {
    current = dirname(realpathSync(entry))
  } catch {
    return null
  }
  while (dirname(current) !== current) {
    const nodeModules = dirname(current)
    if (basename(current) === 'orizu' && basename(nodeModules) === 'node_modules') {
      const lib = dirname(nodeModules)
      if (basename(lib) === 'lib') {
        const prefix = dirname(lib)
        if (existsSync(join(prefix, 'bin', 'node'))) {
          return { prefix, binPath: join(prefix, 'bin', 'orizu') }
        }
      }
    }
    current = dirname(current)
  }
  return null
}

function cachePath(): string {
  return join(process.env.ORIZU_CONFIG_DIR || join(homedir(), '.config', 'orizu'), 'update-check.json')
}

function readCache(): UpdateCache | null {
  try {
    const value = JSON.parse(readFileSync(cachePath(), 'utf8')) as Partial<UpdateCache>
    if (typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))) return null
    if (value.latest !== null && typeof value.latest !== 'string') return null
    if (value.latest !== null) parseSemver(value.latest)
    return { checkedAt: value.checkedAt, latest: value.latest }
  } catch {
    return null
  }
}

function writeCache(latest: string | null): void {
  const path = cachePath()
  const directory = dirname(path)
  const temporary = `${path}.${process.pid}.tmp`
  mkdirSync(directory, { recursive: true })
  writeFileSync(temporary, `${JSON.stringify({ checkedAt: new Date().toISOString(), latest }, null, 2)}\n`)
  renameSync(temporary, path)
}

function tryWriteCache(latest: string | null): void {
  try {
    writeCache(latest)
  } catch {
    // Update checks must not make an otherwise working CLI fail.
  }
}

function removeAbandonedClaim(claimPath: string): boolean {
  try {
    if (Date.now() - statSync(claimPath).mtimeMs < ABANDONED_CLAIM_MS) return false
    unlinkSync(claimPath)
    return true
  } catch {
    return false
  }
}

function claimPassiveRefresh(previousCache: UpdateCache | null): boolean {
  const path = cachePath()
  mkdirSync(dirname(path), { recursive: true })
  const claimPath = `${path}.claim`
  let claim: number
  try {
    claim = openSync(claimPath, 'wx')
  } catch {
    if (!removeAbandonedClaim(claimPath)) return false
    try {
      claim = openSync(claimPath, 'wx')
    } catch {
      return false
    }
  }
  try {
    const currentCache = readCache()
    if (
      currentCache
      && Date.now() - Date.parse(currentCache.checkedAt) < CHECK_INTERVAL_MS
    ) return false
    writeCache(currentCache?.latest ?? previousCache?.latest ?? null)
    return true
  } catch {
    return false
  } finally {
    closeSync(claim)
    try {
      unlinkSync(claimPath)
    } catch {
      // The cache reservation already determines whether a refresh can start.
    }
  }
}

function resolveUpdateRegistry(): string {
  const registry = process.env.ORIZU_UPDATE_REGISTRY ?? 'https://registry.npmjs.org'
  let parsed: URL
  try {
    parsed = new URL(registry)
  } catch {
    throw new Error('ORIZU_UPDATE_REGISTRY must be an http: or https: URL without credentials')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('ORIZU_UPDATE_REGISTRY must be an http: or https: URL without credentials')
  }
  return registry.replace(/\/+$/u, '')
}

async function resolveLatest(registry = resolveUpdateRegistry()): Promise<string> {
  const response = await fetch(`${registry}/orizu/latest`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`)
  const body = await response.json() as { version?: unknown }
  if (typeof body.version !== 'string') throw new Error('registry response did not contain a version')
  parseSemver(body.version)
  return body.version
}

function npmInvocation(): Invocation {
  // Windows is refused in detectNpmGlobalInstall, so only the POSIX layout is reachable here.
  const sibling = join(dirname(process.execPath), 'npm')
  return { command: existsSync(sibling) ? sibling : 'npm', args: [] }
}

function cliInvocation(install: GlobalInstall, args: string[]): Invocation {
  return { command: install.binPath, args }
}

function verifyTimeoutMs(): number {
  const override = process.env.ORIZU_UPDATE_TEST_VERIFY_TIMEOUT_MS
  if (override === undefined) return CHILD_TIMEOUT_MS
  const parsed = Number(override)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : CHILD_TIMEOUT_MS
}

type SkillsRefreshStatus = 'none' | 'refreshed' | 'already-current'

interface SkillsRefreshResult { status: number; timedOut: boolean; skills: SkillsRefreshStatus }

/**
 * Refresh managed skills through the given CLI binary and classify the outcome
 * from the child's --json report, never from its human text: an install with
 * no skill targets reports 'none', the one state a caller of `update --json`
 * most needs to see (ADR-001 coupling).
 */
async function refreshManagedSkills(command: string, args: string[], io: SelfUpdateIo): Promise<SkillsRefreshResult> {
  const child = await runStreaming(command, [...args, 'skills', 'update', '--json'], io, CHILD_TIMEOUT_MS, undefined, true)
  if (child.status !== 0) return { status: child.status, timedOut: child.timedOut, skills: 'none' }
  let updates: Array<{ path?: unknown; action?: unknown }>
  try {
    const parsed = JSON.parse(child.stdout || '') as { updates?: unknown }
    if (!Array.isArray(parsed.updates)) throw new Error('missing updates')
    updates = parsed.updates as Array<{ path?: unknown; action?: unknown }>
  } catch {
    return { status: 1, timedOut: false, skills: 'none' }
  }
  if (!io.json) {
    if (updates.length === 0) io.printLine('No Orizu skill installs found. Run `orizu install-skill` first.')
    for (const update of updates) {
      const path = sanitizeTerminalText(String(update.path ?? ''))
      if (update.action === 'already-current') io.printLine(`Current ${path}`)
      else if (update.action === 'relinked') io.printLine(`Relinked ${path}`)
      else io.printLine(`Updated ${path}`)
    }
  }
  if (updates.length === 0) return { status: 0, timedOut: false, skills: 'none' }
  const refreshed = updates.some(update => update.action !== 'already-current')
  return { status: 0, timedOut: false, skills: refreshed ? 'refreshed' : 'already-current' }
}

function runStreaming(
  command: string,
  args: string[],
  io: SelfUpdateIo,
  timeoutMs?: number,
  onStdout?: (text: string) => void,
  captureStdout = false
): Promise<CommandResult> {
  return new Promise(resolve => {
    let stderr = ''
    let stdout = ''
    let settled = false
    let timedOut = false
    let timer: NodeJS.Timeout | undefined
    const finish = (status: number): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ status, stderr: stderr.slice(-STDERR_TAIL_CHARS), stdout, timedOut })
    }
    const child = spawn(command, args, {
      env: { ...process.env, ORIZU_NO_UPDATE_CHECK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)
    }
    child.stdout?.on('data', chunk => {
      const text = sanitizeTerminalText(chunk)
      onStdout?.(text)
      if (captureStdout) {
        stdout = `${stdout}${text}`
        return
      }
      if (io.json) errorOutput.write(text)
      else output.write(text)
    })
    child.stderr?.on('data', chunk => {
      const text = sanitizeTerminalText(chunk)
      stderr = `${stderr}${text}`.slice(-STDERR_TAIL_CHARS)
      errorOutput.write(text)
    })
    child.once('error', error => {
      stderr = `${stderr}${sanitizeTerminalText(error.message)}`
      finish(1)
    })
    child.once('close', code => finish(code ?? 1))
  })
}

function emit(io: SelfUpdateIo, result: UpdateResult): void {
  if (io.json) io.printLine(JSON.stringify(result))
}

function fail(io: SelfUpdateIo, code: string, detail: string, result: UpdateResult): number {
  io.printError(`${code}: ${detail}`)
  emit(io, result)
  return 1
}

export async function selfUpdateCommand(io: SelfUpdateIo): Promise<number> {
  if (io.refreshCache) {
    const oldCache = readCache()
    try {
      writeCache(await resolveLatest())
    } catch {
      tryWriteCache(oldCache?.latest ?? null)
    }
    return 0
  }

  const install = detectNpmGlobalInstall()
  if (!install) {
    return fail(io, 'update_unsupported_install', `orizu is not installed npm-globally. Run \`${MANUAL_INSTALL_COMMAND}\`.`, {
      installed: io.installed, latest: null, action: 'unsupported', prefix: null, skills: 'not-run',
    })
  }

  let latest: string
  let registry: string
  try {
    registry = resolveUpdateRegistry()
    latest = await resolveLatest(registry)
    tryWriteCache(latest)
  } catch (error) {
    return fail(io, 'update_check_failed', sanitizeTerminalText(error instanceof Error ? error.message : error), {
      installed: io.installed, latest: null, action: 'check-failed', prefix: install.prefix, skills: 'not-run',
    })
  }

  if (compareSemver(io.installed, latest) >= 0) {
    if (!io.json) io.printLine(`orizu ${io.installed} is already the latest.`)
    if (io.dryRun) {
      emit(io, { installed: io.installed, latest, action: 'already-latest', prefix: install.prefix, skills: 'not-run' })
      return 0
    }
    const skills = await refreshManagedSkills(install.binPath, [], io)
    if (skills.status !== 0) {
      const detail = skills.timedOut
        ? 'orizu is already the latest, but its managed skills refresh timed out.'
        : 'orizu is already the latest, but its managed skills could not be refreshed.'
      return fail(io, 'update_skills_refresh_failed', detail, {
        installed: io.installed, latest, action: 'already-latest', prefix: install.prefix, skills: 'refresh-failed',
      })
    }
    emit(io, { installed: io.installed, latest, action: 'already-latest', prefix: install.prefix, skills: skills.skills })
    return 0
  }

  if (io.dryRun) {
    if (!io.json) io.printLine(`Would update orizu ${io.installed} → ${latest} in ${install.prefix}.`)
    emit(io, { installed: io.installed, latest, action: 'would-update', prefix: install.prefix, skills: 'would-refresh' })
    return 0
  }

  const npmCommand = npmInvocation()
  const registryArgs = process.env.ORIZU_UPDATE_REGISTRY !== undefined
    ? ['--registry', registry]
    : []
  const npm = await runStreaming(npmCommand.command, [...npmCommand.args,
    'install', '-g', `orizu@${latest}`, '--prefix', install.prefix, '--no-audit', '--no-fund',
    ...registryArgs,
  ], io)
  if (npm.status !== 0) {
    const tail = npm.stderr.trim() ? ` npm stderr tail: ${npm.stderr.trim()}` : ''
    return fail(io, 'update_install_failed', `${tail} Run \`${MANUAL_INSTALL_COMMAND}\`.`, {
      installed: io.installed, latest, action: 'install-failed', prefix: install.prefix, skills: 'not-run',
    })
  }

  const verifyCommand = cliInvocation(install, ['--version'])
  const verificationTimeoutMs = verifyTimeoutMs()
  const verified = spawnSync(verifyCommand.command, verifyCommand.args, {
    encoding: 'utf8',
    env: { ...process.env, ORIZU_NO_UPDATE_CHECK: '1' },
    killSignal: 'SIGKILL',
    timeout: verificationTimeoutMs,
  })
  const observed = sanitizeTerminalText(verified.stdout || '').trim()
  if ((verified.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    return fail(io, 'update_verify_mismatch', `verification timed out after ${verificationTimeoutMs} ms.`, {
      installed: io.installed, latest, action: 'verify-mismatch', prefix: install.prefix, skills: 'not-run',
    })
  }
  if (verified.status !== 0 || observed !== `orizu ${latest}`) {
    const launchError = verified.error ? ` launch error: ${sanitizeTerminalText(verified.error.message)}.` : ''
    const exit = verified.status === null ? `signal ${verified.signal ?? 'unknown'}` : `exit ${verified.status}`
    const errorTail = sanitizeTerminalText(verified.stderr || '').trim().split('\n').slice(-3).join(' ')
    const detail = `expected orizu ${latest}, observed ${observed || '<no version>'} (${exit}).${launchError}${errorTail ? ` ${errorTail}` : ''}`
    return fail(io, 'update_verify_mismatch', `${detail} Run \`${MANUAL_INSTALL_COMMAND}\` to reinstall.`, {
      installed: io.installed, latest, action: 'verify-mismatch', prefix: install.prefix, skills: 'not-run',
    })
  }

  if (!io.json) io.printLine(`orizu ${latest} installed.`)
  const skillsCommand = cliInvocation(install, [])
  const skills = await refreshManagedSkills(skillsCommand.command, skillsCommand.args, io)
  if (skills.status !== 0) {
    const detail = skills.timedOut
      ? 'the CLI was updated, but its managed skills refresh timed out.'
      : 'the CLI was updated, but its managed skills could not be refreshed.'
    return fail(io, 'update_skills_refresh_failed', detail, {
      installed: io.installed, latest, action: 'updated', prefix: install.prefix, skills: 'refresh-failed',
    })
  }
  emit(io, { installed: io.installed, latest, action: 'updated', prefix: install.prefix, skills: skills.skills })
  return 0
}

export async function runUpdateCommand(rawArgs: string[], io: UpdateCommandIo): Promise<number> {
  const commandIndex = rawArgs.indexOf('update')
  const args = commandIndex === -1
    ? rawArgs
    : [...rawArgs.slice(0, commandIndex), ...rawArgs.slice(commandIndex + 1)]
  const unknownOption = findUnknownOption(args, UPDATE_OPTIONS)
  if (unknownOption) {
    io.printError(`unknown option ${unknownOption}\n${UPDATE_USAGE}`)
    return 1
  }
  const positional = args.find(argument => argument === '-' || !argument.startsWith('-'))
  if (positional) {
    io.printError(`unexpected argument ${positional}\n${UPDATE_USAGE}`)
    return 1
  }
  return selfUpdateCommand({
    dryRun: args.includes('--dry-run'),
    installed: io.getCliVersion(),
    json: io.json,
    printLine: io.printLine,
    printError: io.printError,
    refreshCache: args.includes('--refresh-cache'),
  })
}

function isPassiveUpdateDisabled(): boolean {
  return process.env.ORIZU_NO_UPDATE_CHECK !== undefined || process.env.CI !== undefined ||
    process.env.NO_UPDATE_NOTIFIER !== undefined
}

export function preparePassiveUpdate(
  rawArgs: string[],
  command: string | undefined,
  installed: string
): PassiveUpdateState | null {
  if (
    rawArgs.includes('--json') || command === 'update' || command === 'git-credential' || command === 'internal' ||
    isPassiveUpdateDisabled()
  ) return null
  const install = detectNpmGlobalInstall()
  if (!install) return null
  try {
    parseSemver(installed)
    return { cache: readCache(), install, installed }
  } catch {
    return null
  }
}

export function withPassiveUpdateNotice(
  rawArgs: string[],
  getInstalledVersion: () => string,
  printError: (message: string) => void,
  run: (args: string[]) => Promise<unknown>,
  io: PassiveUpdateIo = defaultPassiveUpdateIo
): void {
  let state: PassiveUpdateState | null = null
  let didReject = false
  try {
    let startupCommand: string | undefined
    try {
      const startupArgs = parseGlobalFlags(rawArgs).args
      startupCommand = startupArgs[0] === '--json' ? startupArgs[1] : startupArgs[0]
    } catch {
      startupCommand = rawArgs[0]
    }
    if (startupCommand !== 'update') {
      const installed = getInstalledVersion()
      state = preparePassiveUpdate(rawArgs, startupCommand, installed)
    }
  } catch {
    // Passive update preparation never affects the command about to run.
  }
  void run(rawArgs).catch(error => {
    printError(error instanceof Error ? error.message : 'Unknown error')
    didReject = true
  }).finally(() => {
    finishPassiveUpdate(state, printError, io)
    if (didReject) io.exit(1)
  })
}

export function finishPassiveUpdate(
  state: PassiveUpdateState | null,
  printError: (message: string) => void,
  io: PassiveUpdateIo = defaultPassiveUpdateIo
): void {
  if (!state) return
  try {
    if (isPassiveUpdateDisabled()) return
    if (state.cache?.latest && compareSemver(state.cache.latest, state.installed) > 0) {
      printError(`A newer orizu is available: ${state.installed} → ${state.cache.latest}. Run \`orizu update\`.`)
    }
    if (claimPassiveRefresh(state.cache)) {
      const refreshCommand = cliInvocation(state.install, ['update', '--refresh-cache'])
      const child = io.spawn(refreshCommand.command, refreshCommand.args, {
        detached: true,
        env: process.env,
        stdio: 'ignore',
      })
      child.once('error', () => {})
      child.unref()
    }
  } catch {
    // Passive update checks never affect the command that just completed.
  }
}
