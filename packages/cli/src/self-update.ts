import { spawn } from 'child_process'
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

import { parseGlobalFlags } from './global-flags.js'
import { findUnknownOption } from './option-validation.js'

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000, CHECK_TIMEOUT_MS = 5_000
// A claim file outliving this window belongs to a process that died mid-claim;
// treating it as live would silently disable the daily refresh forever.
const ABANDONED_CLAIM_MS = 60_000
export const MANUAL_INSTALL_COMMAND = 'npm i -g orizu@latest'
const UPDATE_OPTIONS = new Set(['--dry-run', '--json', '--refresh-cache'])
const UPDATE_USAGE = 'Usage: orizu update [--dry-run] [--json]'

interface UpdateCache { checkedAt: string; latest: string | null }
export interface GlobalInstall { binPath: string; prefix: string }
export interface Invocation { command: string; args: string[] }

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

export function tryWriteCache(latest: string | null): void {
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

export function resolveUpdateRegistry(): string {
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

export async function resolveLatest(registry = resolveUpdateRegistry()): Promise<string> {
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

export function npmInvocation(): Invocation {
  // Windows is refused in detectNpmGlobalInstall, so only the POSIX layout is reachable here.
  const sibling = join(dirname(process.execPath), 'npm')
  return { command: existsSync(sibling) ? sibling : 'npm', args: [] }
}

export function cliInvocation(install: GlobalInstall, args: string[]): Invocation {
  return { command: install.binPath, args }
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

export interface SelfUpdateIo {
  dryRun: boolean; installed: string; json: boolean
  printLine(message?: string): void; printError(message: string): void
}

interface UpdateCommandIo {
  getCliVersion(): string
  json: boolean
  printLine(message?: string): void
  printError(message: string): void
}

/**
 * `orizu update`. Checking the arguments, the daily background cache refresh
 * and refusing an install npm doesn't own stay plain code; only an update of
 * an npm-global install loads the Effect workflow (ORI-2424).
 */
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

  if (args.includes('--refresh-cache')) {
    const oldCache = readCache()
    try {
      writeCache(await resolveLatest())
    } catch {
      tryWriteCache(oldCache?.latest ?? null)
    }
    return 0
  }

  const installed = io.getCliVersion()
  const install = detectNpmGlobalInstall()
  if (!install) {
    io.printError(`update_unsupported_install: orizu is not installed npm-globally. Run \`${MANUAL_INSTALL_COMMAND}\`.`)
    if (io.json) io.printLine(JSON.stringify({ installed, latest: null, action: 'unsupported', prefix: null, skills: 'not-run' }))
    return 1
  }
  const { runSelfUpdate } = await import('./self-update-command.js')
  return runSelfUpdate({
    dryRun: args.includes('--dry-run'),
    installed,
    json: io.json,
    printLine: io.printLine,
    printError: io.printError,
  }, install)
}
