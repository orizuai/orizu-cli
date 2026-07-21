import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, isAbsolute, join, normalize } from 'path'

import {
  archiveArtifactEntries,
  expandHomePath,
  readArtifactEntries,
  shouldExcludeArtifactPath,
} from './artifact-archive.js'
import { authedFetch } from './http.js'

/**
 * ALI-1159 (ADR-007): ad-hoc `--runner-dir` bytes may only execute when they
 * ARE a registered runner version. Runs that execute local runner bytes stamp
 * a registered `runner_version_id` into every result record; before this
 * guard, nothing tied those bytes to that version — a run could produce live
 * Orizu records from runner bytes that were never registered or committed
 * anywhere (the GEPA-adapter loss on orizu-workbench-demo). The check is the
 * same deterministic-zip content sha the push paths record: identical
 * directory bytes hash to the registered version's `content_sha256`.
 *
 * Lives outside index.ts per the CLI line ratchet (ALI-976).
 */

/** Test seam; defaults to the authenticated CLI fetcher. */
export interface VerifyRunnerDirInput {
  runnerVersionId: string
  dir: string
  /** The CLI flag the dir arrived on (for the error message). */
  flag: string
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>
}

/**
 * The deterministic zip EXCLUDES two kinds of entries the runtime can still
 * reach, so a hash-matching dir could execute unregistered inputs while its
 * records claim the registered version:
 *   - `.env`/`.env.*` files (secrets must never ship — runners get
 *     configuration at exec time);
 *   - SYMLINKS — collectArtifactFiles keeps only real files
 *     (`Dirent.isFile()`), so `runner.js -> /tmp/unregistered.js` is absent
 *     from the hash while execution follows it; a materialized registered
 *     version would not contain the link at all (codex round 3 on #1447).
 *     The refusal happens before spawn, so there is no hash-then-swap
 *     TOCTOU window to reason about.
 * Both are refused outright. The remaining exclusions (.git, __pycache__,
 * .DS_Store, .pytest_cache, .orizu) are caches/metadata a runner has no
 * business reading and stay ignorable (their subtrees are not scanned).
 */
interface RunnerDirScan {
  envFiles: string[]
  symlinks: string[]
}

function scanRunnerDir(dir: string, relativeDir = ''): RunnerDirScan {
  const absoluteDir = relativeDir ? join(dir, relativeDir) : dir
  const result: RunnerDirScan = { envFiles: [], symlinks: [] }
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) {
      result.symlinks.push(relativePath)
      continue
    }
    if (entry.isFile()) {
      if (entry.name === '.env' || entry.name.startsWith('.env.')) {
        result.envFiles.push(relativePath)
      }
      continue
    }
    if (entry.isDirectory() && !shouldExcludeArtifactPath(relativePath)) {
      const nested = scanRunnerDir(dir, relativePath)
      result.envFiles.push(...nested.envFiles)
      result.symlinks.push(...nested.symlinks)
    }
  }
  return result
}

function scanSnapshotSymlinks(dir: string, relativeDir = ''): string[] {
  const absoluteDir = relativeDir ? join(dir, relativeDir) : dir
  const symlinks: string[] = []
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) {
      symlinks.push(relativePath)
    } else if (entry.isDirectory()) {
      symlinks.push(...scanSnapshotSymlinks(dir, relativePath))
    }
  }
  return symlinks
}

export interface VerifiedRunnerSnapshot {
  /**
   * Temp directory holding EXACTLY the verified file set, materialized from
   * the same in-memory bytes the hash covered (codex round 4 on #1447):
   * execution from here is immune to post-hash mutation of the original dir,
   * and hash-excluded entries (.env, .git, .orizu, caches, symlinks) simply
   * do not exist at runtime.
   */
  snapshotDir: string
  cleanup: () => void
}

export async function verifyRunnerDirRegistered(input: VerifyRunnerDirInput): Promise<VerifiedRunnerSnapshot> {
  const fetcher = input.fetcher ?? authedFetch
  // Resolve the SAME path the archive hash and the runner execution resolve
  // (codex round 3: the literal `~/...` was scanned and ENOENT'd).
  const dir = expandHomePath(input.dir)

  const { envFiles, symlinks } = scanRunnerDir(dir)
  if (symlinks.length > 0) {
    throw new Error(
      `Runner directory ${dir} contains symlinks (${symlinks.join(', ')}) — symlinks are excluded ` +
      'from the registered content hash but execution would follow them, so the run could execute ' +
      'unregistered bytes under a registered runner_version_id (ADR-007). Replace them with real ' +
      'files (a materialized registered version contains no symlinks).'
    )
  }
  if (envFiles.length > 0) {
    throw new Error(
      `Runner directory ${dir} contains env files (${envFiles.join(', ')}) that are excluded ` +
      'from the registered content hash but would be read at runtime — the run would execute ' +
      'unregistered inputs under a registered runner_version_id (ADR-007). Remove them and pass ' +
      'configuration at exec time instead.'
    )
  }

  // Read the entry set ONCE: these exact bytes are hashed AND (on success)
  // materialized as the execution snapshot, so verify-vs-execute cannot
  // diverge.
  const entries = readArtifactEntries(dir)
  const { contentSha256: localSha } = archiveArtifactEntries(entries)

  const response = await fetcher(`/api/cli/runner-versions/${encodeURIComponent(input.runnerVersionId)}`)
  if (response.status === 404) {
    throw new Error(
      `Runner version ${input.runnerVersionId} is not registered (or is not visible to you), ` +
      `so ${input.flag} bytes cannot be attributed to it. Register the directory first with ` +
      '`orizu runners push` and re-run against the returned version id.'
    )
  }
  if (!response.ok) {
    // Bounded echo: an HTML error page or proxy body should not flood the
    // terminal (claude-review on #1447).
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`Failed to fetch runner version ${input.runnerVersionId} (HTTP ${response.status}): ${detail}`)
  }

  const data = await response.json() as { contentSha256?: string | null }
  const registeredSha = typeof data.contentSha256 === 'string' ? data.contentSha256 : null
  if (!registeredSha) {
    throw new Error(
      `Runner version ${input.runnerVersionId} has no recorded content sha, so ${input.flag} bytes ` +
      'cannot be verified against it. Drop the flag to execute the registered bytes.'
    )
  }

  if (registeredSha.toLowerCase() !== localSha.toLowerCase()) {
    throw new Error(
      `Local runner bytes at ${dir} are not registered runner version ${input.runnerVersionId} ` +
      `(content sha ${localSha} != ${registeredSha}). Runs may only execute registered runner bytes ` +
      '(ADR-007): register the directory first with `orizu runners push` ' +
      '(use --session <session-id> inside a workspace session) and re-run against the new version, ' +
      `or drop ${input.flag} to execute the registered bytes.`
    )
  }

  const snapshotDir = mkdtempSync(join(tmpdir(), 'orizu-verified-runner-'))
  try {
    for (const entry of entries) {
      const target = join(snapshotDir, entry.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, entry.data)
      if (entry.mode !== undefined) {
        // chmod (not writeFileSync's mode option, which the umask masks):
        // an executable `./run.sh` runner must keep its +x in the snapshot
        // (codex round 7). The mode is NOT part of the content hash.
        chmodSync(target, entry.mode & 0o777)
      }
    }
    // Codex round-6 P1: an absolute or `..`-escaping command entry in the
    // (verified) manifest would execute bytes OUTSIDE the snapshot — the
    // registered hash covers the manifest text, not what an out-of-snapshot
    // path resolves to at spawn time. Validate against the snapshot's own
    // manifest bytes before anything can execute.
    assertSnapshotManifestConfined(snapshotDir, input.flag)
  } catch (error) {
    rmSync(snapshotDir, { recursive: true, force: true })
    throw error
  }

  return {
    snapshotDir,
    cleanup: () => rmSync(snapshotDir, { recursive: true, force: true }),
  }
}

/**
 * Known loader/preload-style interpreter options that make their NEXT argv
 * token executable (codex round 7 / claude-review on #1447). A DENYLIST
 * heuristic by nature — option-space is open-ended — kept for targeted
 * diagnostics on the separated form; the generic per-token/per-segment
 * confinement checks are what actually hold the line.
 */
const LOADER_STYLE_OPTIONS = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader',
  '--experimental-preload', '-X', '-m', '--preload',
])

// Audited against Node 24's getCLIOptionsInfo metadata. These options accept
// a separate value, which must not be mistaken for Node's script boundary.
const NODE_OPTION_OPERANDS = new Set([
  '-C', '--conditions',
  '-r', '--require', '--import', '--loader', '--experimental-loader',
  '--allow-fs-read', '--allow-fs-write',
  '--build-snapshot-config',
  '--cpu-prof-dir', '--cpu-prof-interval', '--cpu-prof-name',
  '--debug-port', '--diagnostic-dir', '--disable-proto', '--disable-warning', '--dns-result-order',
  '--env-file', '--env-file-if-exists',
  '--experimental-config-file', '--experimental-sea-config',
  '--heap-prof-dir', '--heap-prof-interval', '--heap-prof-name',
  '--heapsnapshot-near-heap-limit', '--heapsnapshot-signal',
  '--icu-data-dir', '--input-type',
  '--inspect-port', '--inspect-publish-uid',
  '--localstorage-file', '--max-http-header-size',
  '--max-old-space-size', '--max-old-space-size-percentage', '--max-semi-space-size',
  '--network-family-autoselection-attempt-timeout',
  '--openssl-config', '--redirect-warnings',
  '--report-dir', '--report-directory', '--report-filename', '--report-signal',
  '--secure-heap', '--secure-heap-min', '--security-revert', '--snapshot-blob', '--stack-trace-limit',
  '--test-concurrency', '--test-coverage-branches', '--test-coverage-exclude',
  '--test-coverage-functions', '--test-coverage-include', '--test-coverage-lines',
  '--test-global-setup', '--test-isolation', '--test-name-pattern', '--test-reporter',
  '--test-reporter-destination', '--test-rerun-failures', '--test-shard',
  '--test-skip-pattern', '--test-timeout',
  '--title', '--tls-cipher-list', '--tls-keylog',
  '--trace-event-categories', '--trace-event-file-pattern', '--trace-require-module',
  '--unhandled-rejections', '--use-largepages', '--v8-pool-size',
  '--watch-kill-signal', '--watch-path',
])

const COMMAND_STRING_OPTIONS: ReadonlyArray<{
  executables: RegExp
  options: ReadonlySet<string>
  caseInsensitive?: boolean
  clusteredOptions?: ReadonlySet<string>
  optionOperands?: ReadonlySet<string>
  programFileOptions?: ReadonlySet<string>
  scriptBoundaryOptions?: ReadonlySet<string>
  powershellPrefixes?: boolean
  commandStrings?: ReadonlySet<string>
  positionalCommandString?: boolean
}> = [
  {
    executables: /^(?:(?:ba|da|a|k|z)?sh)(?:\.exe)?$/i,
    options: new Set(['-c']),
    clusteredOptions: new Set(['c']),
    optionOperands: new Set(['-O', '-o', '--rcfile', '--init-file']),
  },
  { executables: /^fish(?:\.exe)?$/i, options: new Set(['-c', '--command', '-C', '--init-command']) },
  {
    executables: /^node(?:js)?(?:\.exe)?$/i,
    options: new Set(['-e', '--eval', '-p', '--print', '--run']),
    clusteredOptions: new Set(['e', 'p']),
    optionOperands: NODE_OPTION_OPERANDS,
  },
  {
    executables: /^bun(?:\.exe)?$/i,
    options: new Set(['-e', '--eval', '-p', '--print']),
    clusteredOptions: new Set(['e', 'p']),
    commandStrings: new Set(['exec']),
  },
  {
    executables: /^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i,
    options: new Set(['-c']),
    clusteredOptions: new Set(['c']),
    optionOperands: new Set(['-W', '-X', '--check-hash-based-pycs']),
  },
  {
    executables: /^ruby(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i,
    options: new Set(['-e']),
    clusteredOptions: new Set(['e']),
    optionOperands: new Set(['-C', '-E']),
  },
  {
    executables: /^perl(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i,
    options: new Set(['-e', '-E']),
    clusteredOptions: new Set(['e', 'E']),
    optionOperands: new Set(['-I']),
  },
  {
    executables: /^php(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i,
    options: new Set(['-r', '-B', '-R', '-E']),
    clusteredOptions: new Set(['r', 'B', 'R', 'E']),
    optionOperands: new Set(['-d', '--define']),
  },
  {
    executables: /^(?:awk|gawk|mawk|nawk)(?:\.exe)?$/i,
    options: new Set(['-e', '--source']),
    optionOperands: new Set([
      '-F', '--field-separator',
      '-v', '--assign',
      '-W',
      '-i', '--include',
      '-l', '--load',
    ]),
    programFileOptions: new Set(['-f', '--file']),
    scriptBoundaryOptions: new Set(['-E', '--exec']),
    positionalCommandString: true,
  },
  {
    executables: /^(?:pwsh|powershell)(?:\.exe)?$/i,
    options: new Set(),
    caseInsensitive: true,
    powershellPrefixes: true,
    optionOperands: new Set(['-ExecutionPolicy']),
    scriptBoundaryOptions: new Set(['-File']),
  },
  { executables: /^cmd(?:\.exe)?$/i, options: new Set(['/c', '/k']), caseInsensitive: true },
]

function commandStringError(flag: string, entry: string, executable: string): Error {
  return new Error(
    `Runner manifest command for ${flag} uses ${JSON.stringify(entry)} with ${JSON.stringify(executable)} — ` +
    'shell/eval command-string payloads can execute paths that are not visible to snapshot confinement ' +
    '(ADR-007). Put executable code in a registered snapshot file and invoke that file instead.'
  )
}

function normalizePolicyEntry(
  policy: (typeof COMMAND_STRING_OPTIONS)[number],
  entry: string
): string {
  return policy.caseInsensitive ? entry.toLowerCase() : entry
}

function optionOperandMatch(
  policy: (typeof COMMAND_STRING_OPTIONS)[number],
  entry: string,
  options: ReadonlySet<string> | undefined
): 'separate' | 'attached' | null {
  const normalizedEntry = normalizePolicyEntry(policy, entry)
  for (const option of options ?? []) {
    const normalizedOption = normalizePolicyEntry(policy, option)
    if (normalizedEntry === normalizedOption) {
      return 'separate'
    }
    if (
      normalizedEntry.startsWith(`${normalizedOption}=`) ||
      (normalizedOption.length === 2 && normalizedEntry.startsWith(normalizedOption) && normalizedEntry.length > 2)
    ) {
      return 'attached'
    }
  }
  return null
}

function isEnvAssignment(entry: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(entry)
}

function isPathResolvedExecutable(entry: string): boolean {
  return !entry.includes('/') && !entry.includes('\\')
}

function isEnvSplitStringOption(entry: string): boolean {
  if (entry === '-S' || entry.startsWith('-S') || entry.startsWith('--split-string')) {
    return true
  }
  return entry.startsWith('-') && !entry.startsWith('--') && entry.slice(1).includes('S')
}

function nextEnvCommandIndex(command: unknown[], executableIndex: number, flag: string): number | null {
  const executable = command[executableIndex]
  if (typeof executable !== 'string') {
    return null
  }
  for (let index = executableIndex + 1; index < command.length; index += 1) {
    const entry = command[index]
    if (typeof entry !== 'string') {
      continue
    }
    if (entry === '--') {
      return index + 1 < command.length ? index + 1 : null
    }
    if (isEnvSplitStringOption(entry)) {
      throw new Error(
        `Runner manifest command for ${flag} uses ${JSON.stringify(entry)} with ${JSON.stringify(executable)} — ` +
        'wrapper split-string payloads can hide shell/eval commands from snapshot confinement (ADR-007).'
      )
    }
    if (entry === '-' || entry === '-i' || entry === '--ignore-environment' || entry === '-0' || entry === '--null') {
      continue
    }
    if (entry === '-u' || entry === '--unset' || entry === '-C' || entry === '--chdir') {
      index += 1
      continue
    }
    if (entry.startsWith('--unset=') || entry.startsWith('--chdir=')) {
      continue
    }
    if (entry.startsWith('-')) {
      continue
    }
    if (isEnvAssignment(entry)) {
      continue
    }
    return index
  }
  return null
}

function nextOptionWrappedCommandIndex(command: unknown[], executableIndex: number): number | null {
  for (let index = executableIndex + 1; index < command.length; index += 1) {
    const entry = command[index]
    if (typeof entry !== 'string') {
      continue
    }
    if (entry === '--') {
      return index + 1 < command.length ? index + 1 : null
    }
    if (
      entry === '-n' || entry === '--adjustment' ||
      entry === '-k' || entry === '--kill-after' || entry === '-s' || entry === '--signal'
    ) {
      index += 1
      continue
    }
    if (
      entry.startsWith('-n') ||
      entry.startsWith('--adjustment=') ||
      entry.startsWith('--signal=') ||
      entry.startsWith('--kill-after=') ||
      entry.startsWith('-k') ||
      entry.startsWith('-s')
    ) {
      continue
    }
    if (entry.startsWith('-')) {
      continue
    }
    return index
  }
  return null
}

function nextTimeoutCommandIndex(command: unknown[], executableIndex: number): number | null {
  const durationIndex = nextOptionWrappedCommandIndex(command, executableIndex)
  return durationIndex === null || durationIndex + 1 >= command.length ? null : durationIndex + 1
}

function nextStdbufCommandIndex(command: unknown[], executableIndex: number): number | null {
  for (let index = executableIndex + 1; index < command.length; index += 1) {
    const entry = command[index]
    if (typeof entry !== 'string') {
      continue
    }
    if (entry === '--') {
      return index + 1 < command.length ? index + 1 : null
    }
    if (
      entry === '-i' || entry === '--input' ||
      entry === '-o' || entry === '--output' ||
      entry === '-e' || entry === '--error'
    ) {
      index += 1
      continue
    }
    if (
      entry.startsWith('-i') ||
      entry.startsWith('-o') ||
      entry.startsWith('-e') ||
      entry.startsWith('--input=') ||
      entry.startsWith('--output=') ||
      entry.startsWith('--error=')
    ) {
      continue
    }
    if (entry.startsWith('-')) {
      continue
    }
    return index
  }
  return null
}

function nextFlagOnlyWrappedCommandIndex(command: unknown[], executableIndex: number): number | null {
  for (let index = executableIndex + 1; index < command.length; index += 1) {
    const entry = command[index]
    if (typeof entry !== 'string') {
      continue
    }
    if (entry === '--') {
      return index + 1 < command.length ? index + 1 : null
    }
    if (entry.startsWith('-')) {
      continue
    }
    return index
  }
  return null
}

function nextFindCommandIndexes(command: unknown[], executableIndex: number): number[] {
  const commandIndexes: number[] = []
  const executionActions = new Set(['-exec', '-execdir', '-ok', '-okdir'])
  for (let index = executableIndex + 1; index < command.length; index += 1) {
    const entry = command[index]
    if (typeof entry !== 'string' || !executionActions.has(entry)) {
      continue
    }
    if (typeof command[index + 1] === 'string') {
      commandIndexes.push(index + 1)
    }
    // The launched command ends at find's required ';' or '+' action
    // delimiter. Resume after it so multiple execution actions are checked
    // without mistaking arguments to the launched program for find actions.
    while (index + 1 < command.length) {
      index += 1
      if (command[index] === ';' || command[index] === '+') {
        break
      }
    }
  }
  return commandIndexes
}

function nextXargsCommandIndex(command: unknown[], executableIndex: number): number | null {
  const separateOperandOptions = new Set([
    '-a', '--arg-file',
    '-d', '--delimiter',
    '-E',
    '-I', '--replace',
    '-L', '--max-lines',
    '-n', '--max-args',
    '-P', '--max-procs',
    '-s', '--max-chars',
    '--process-slot-var',
  ])
  const attachedOperandPrefixes = [
    '-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s',
    '--arg-file=',
    '--delimiter=',
    '--eof=',
    '--replace=',
    '--max-lines=',
    '--max-args=',
    '--max-procs=',
    '--max-chars=',
    '--process-slot-var=',
  ]
  for (let index = executableIndex + 1; index < command.length; index += 1) {
    const entry = command[index]
    if (typeof entry !== 'string') {
      continue
    }
    if (entry === '--') {
      return index + 1 < command.length ? index + 1 : null
    }
    if (separateOperandOptions.has(entry)) {
      index += 1
      continue
    }
    if (attachedOperandPrefixes.some(prefix => entry.startsWith(prefix) && entry.length > prefix.length)) {
      continue
    }
    if (entry.startsWith('-')) {
      continue
    }
    return index
  }
  return null
}

function nextWrappedCommandIndex(command: unknown[], executableIndex: number, flag: string): number | null {
  const executable = command[executableIndex]
  if (typeof executable !== 'string' || !isPathResolvedExecutable(executable)) {
    return null
  }
  const name = basename(executable).toLowerCase()
  if (/^env(?:\.exe)?$/.test(name)) {
    return nextEnvCommandIndex(command, executableIndex, flag)
  }
  if (/^(?:nice|nohup)(?:\.exe)?$/.test(name)) {
    return nextOptionWrappedCommandIndex(command, executableIndex)
  }
  if (/^timeout(?:\.exe)?$/.test(name)) {
    return nextTimeoutCommandIndex(command, executableIndex)
  }
  if (/^stdbuf(?:\.exe)?$/.test(name)) {
    return nextStdbufCommandIndex(command, executableIndex)
  }
  if (/^setsid(?:\.exe)?$/.test(name)) {
    return nextFlagOnlyWrappedCommandIndex(command, executableIndex)
  }
  if (/^busybox(?:\.exe)?$/.test(name)) {
    return executableIndex + 1 < command.length ? executableIndex + 1 : null
  }
  if (/^xargs(?:\.exe)?$/.test(name)) {
    return nextXargsCommandIndex(command, executableIndex)
  }
  return null
}

function executableCandidateIndexes(command: unknown[], flag: string): number[] {
  const indexes: number[] = []
  const seen = new Set<number>()
  const pending = [0]
  while (pending.length > 0) {
    const index = pending.shift() as number
    if (index >= command.length || seen.has(index)) {
      continue
    }
    const entry = command[index]
    if (typeof entry !== 'string') {
      continue
    }
    indexes.push(index)
    seen.add(index)
    const name = basename(entry).toLowerCase()
    if (isPathResolvedExecutable(entry) && /^find(?:\.exe)?$/.test(name)) {
      pending.push(...nextFindCommandIndexes(command, index))
      continue
    }
    const next = nextWrappedCommandIndex(command, index, flag)
    if (next !== null && next > index) {
      pending.push(next)
    }
  }
  return indexes
}

function isNpmCommandStringOption(entry: string): boolean {
  return entry === '-c' || entry.startsWith('-c') ||
    entry === '--call' || entry.startsWith('--call=')
}

function assertNpmExecHasNoCommandStringPayload(
  command: unknown[],
  executableIndex: number,
  flag: string
): void {
  const executable = command[executableIndex] as string
  const globalOptionsWithOperands = new Set([
    '-w', '--workspace',
    '--cache', '--globalconfig', '--location', '--loglevel', '--prefix',
    '--registry', '--scope', '--script-shell', '--userconfig',
  ])
  let subcommandIndex: number | null = null
  for (let index = executableIndex + 1; index < command.length; index += 1) {
    const entry = command[index]
    if (typeof entry !== 'string') {
      continue
    }
    if (entry === '--') {
      return
    }
    if (globalOptionsWithOperands.has(entry)) {
      index += 1
      continue
    }
    if (entry.startsWith('-')) {
      continue
    }
    if (entry === 'exec' || entry === 'x') {
      subcommandIndex = index
    }
    break
  }
  if (subcommandIndex === null) {
    return
  }
  for (let optionIndex = subcommandIndex + 1; optionIndex < command.length; optionIndex += 1) {
    const entry = command[optionIndex]
    if (typeof entry !== 'string') {
      continue
    }
    if (entry === '--') {
      break
    }
    if (isNpmCommandStringOption(entry)) {
      throw commandStringError(flag, entry, executable)
    }
  }
}

function assertNpxHasNoCommandStringPayload(
  command: unknown[],
  executableIndex: number,
  flag: string
): void {
  const executable = command[executableIndex] as string
  const optionsWithOperands = new Set([
    '-p', '--package',
    '-w', '--workspace',
    '--cache', '--globalconfig', '--location', '--loglevel', '--prefix',
    '--registry', '--scope', '--script-shell', '--userconfig',
  ])
  for (let optionIndex = executableIndex + 1; optionIndex < command.length; optionIndex += 1) {
    const entry = command[optionIndex]
    if (typeof entry !== 'string') {
      continue
    }
    if (entry === '--') {
      break
    }
    if (isNpmCommandStringOption(entry)) {
      throw commandStringError(flag, entry, executable)
    }
    if (optionsWithOperands.has(entry)) {
      optionIndex += 1
      continue
    }
    if (!entry.startsWith('-')) {
      break
    }
  }
}

function assertPolicyHasNoCommandStringPayload(
  command: unknown[],
  executableIndex: number,
  policy: (typeof COMMAND_STRING_OPTIONS)[number],
  flag: string
): void {
  const executable = command[executableIndex] as string
  const executableName = basename(executable)
  let hasProgramFile = false
  for (let optionIndex = executableIndex + 1; optionIndex < command.length; optionIndex += 1) {
    const entry = command[optionIndex]
    if (typeof entry !== 'string') {
      continue
    }
    // Interpreter option parsing ends at the script operand. Flags after
    // that point belong to registered runner code, not the interpreter.
    const isCmdOption = /^cmd(?:\.exe)?$/i.test(executableName) && entry.startsWith('/')
    const normalizedEntry = normalizePolicyEntry(policy, entry)
    if (entry === '--') {
      if (policy.positionalCommandString) {
        if (hasProgramFile) {
          break
        }
        continue
      }
      break
    }
    if (policy.commandStrings?.has(normalizedEntry)) {
      throw new Error(
        `Runner manifest command for ${flag} uses command-string entrypoint ${JSON.stringify(entry)} with ` +
        `${JSON.stringify(executable)} — opaque shell commands bypass snapshot confinement (ADR-007).`
      )
    }
    if (!entry.startsWith('-') && !isCmdOption) {
      if (policy.positionalCommandString) {
        if (hasProgramFile) {
          break
        }
        throw commandStringError(flag, entry, executable)
      }
      break
    }
    const programFileMatch = optionOperandMatch(policy, entry, policy.programFileOptions)
    if (programFileMatch) {
      hasProgramFile = true
      if (programFileMatch === 'separate') {
        optionIndex += 1
      }
      continue
    }
    if (optionOperandMatch(policy, entry, policy.scriptBoundaryOptions)) {
      break
    }
    const operandMatch = optionOperandMatch(policy, entry, policy.optionOperands)
    if (operandMatch) {
      if (operandMatch === 'separate') {
        optionIndex += 1
      }
      continue
    }
    const matched = [...policy.options].some(option => {
      const normalizedOption = normalizePolicyEntry(policy, option)
      return normalizedEntry === normalizedOption ||
        normalizedEntry.startsWith(`${normalizedOption}=`) ||
        (normalizedOption.length === 2 && normalizedEntry.startsWith(normalizedOption))
    }) || (
      entry.startsWith('-') && !entry.startsWith('--') &&
      [...(policy.clusteredOptions ?? [])].some(option => entry.slice(1).includes(option))
    ) || Boolean(policy.powershellPrefixes && (() => {
      const optionName = normalizedEntry.split('=', 1)[0]
      return optionName.length >= 2 && (
        '-command'.startsWith(optionName) || '-encodedcommand'.startsWith(optionName)
      )
    })())
    if (matched) {
      throw commandStringError(flag, entry, executable)
    }
  }
}

function assertNoCommandStringPayload(command: unknown[], flag: string): void {
  for (const executableIndex of executableCandidateIndexes(command, flag)) {
    const executable = command[executableIndex]
    if (typeof executable !== 'string') {
      continue
    }
    if (!isPathResolvedExecutable(executable)) {
      continue
    }
    const executableName = basename(executable)
    if (/^npm(?:\.cmd|\.exe)?$/i.test(executableName)) {
      assertNpmExecHasNoCommandStringPayload(command, executableIndex, flag)
    }
    if (/^npx(?:\.cmd|\.exe)?$/i.test(executableName)) {
      assertNpxHasNoCommandStringPayload(command, executableIndex, flag)
    }
    const policy = COMMAND_STRING_OPTIONS.find(candidate => candidate.executables.test(executableName))
    if (!policy) {
      continue
    }
    assertPolicyHasNoCommandStringPayload(command, executableIndex, policy, flag)
  }
}

/**
 * The runner contract executes `manifest.json`'s `command` with cwd at the
 * artifact root. Every command entry must stay INSIDE the snapshot: absolute
 * entries and `..` escapes are refused (a bare program name like `node` is
 * PATH-resolved — interpreters are environment, not artifact bytes). Missing
 * or malformed manifests are refused here too, so no snapshot can outlive a
 * runner that could never execute.
 */
export function assertSnapshotManifestConfined(snapshotDir: string, flag: string): void {
  const symlinks = scanSnapshotSymlinks(snapshotDir)
  if (symlinks.length > 0) {
    throw new Error(
      `Verified runner bytes for ${flag} contain symlinks (${symlinks.join(', ')}) — ` +
      'symlinks can resolve to executable or loaded bytes outside the verified snapshot (ADR-007).'
    )
  }
  const manifestPath = join(snapshotDir, 'manifest.json')
  let raw: string
  try {
    raw = readFileSync(manifestPath, 'utf8')
  } catch {
    throw new Error(`Verified runner bytes for ${flag} do not contain a manifest.json at the artifact root.`)
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(raw)
  } catch {
    throw new Error(`Verified runner manifest.json for ${flag} is not valid JSON.`)
  }
  const command = (manifest as { command?: unknown } | null)?.command
  if (!Array.isArray(command)) {
    return
  }
  assertNoCommandStringPayload(command, flag)
  for (let index = 0; index < command.length; index += 1) {
    const entry = command[index]
    if (typeof entry !== 'string') {
      continue
    }
    // DENYLIST HEURISTIC (documented as such — interpreter option-space is
    // open-ended, so this cannot be exhaustive; the PRIMARY defense is the
    // snapshot + relative-command posture, this is diagnostics-grade depth):
    // a known loader-style option whose SEPARATED next token is absolute or
    // escaping gets a targeted refusal naming the option. The generic
    // whole-token check below refuses the same next token anyway.
    if (LOADER_STYLE_OPTIONS.has(entry)) {
      const next = command[index + 1]
      if (typeof next === 'string' && (isAbsolute(next) || normalize(next).startsWith('..'))) {
        throw new Error(
          `Runner manifest loader option ${JSON.stringify(entry)} points at ${JSON.stringify(next)} — an ` +
          'absolute or snapshot-escaping path would load bytes outside the verified snapshot (ADR-007). ' +
          'Use snapshot-relative paths in manifest.json.'
        )
      }
    }
    // Check the whole token AND every option-attached value segment (codex
    // round 7: `--require=/tmp/evil.js` passed the whole-token check while
    // node still loaded the external file). Splitting on `=` covers the
    // option form; `,`/`:` cover common list-valued options. Over-rejecting
    // an exotic-but-legit value is the safe side — runners receive
    // configuration at exec time, not baked into command argv.
    const pieces = [entry, ...entry.split(/[=,:]/)]
    for (const piece of pieces) {
      if (!piece) {
        continue
      }
      if (isAbsolute(piece)) {
        throw new Error(
          `Runner manifest command entry ${JSON.stringify(entry)} carries an absolute path — it would ` +
          'execute or load bytes outside the verified snapshot (ADR-007). Use PATH-resolved program ' +
          'names and snapshot-relative paths in manifest.json.'
        )
      }
      const normalized = normalize(piece)
      if (normalized === '..' || normalized.startsWith(`..${'/'}`) || normalized.startsWith('..\\')) {
        throw new Error(
          `Runner manifest command entry ${JSON.stringify(entry)} escapes the verified snapshot via '..' ` +
          '(ADR-007). Use snapshot-relative paths in manifest.json.'
        )
      }
    }
  }
}

/** The run-gepa (version-id, runner-dir) flag pairs the wrapper must verify. */
const GEPA_RUNNER_FLAG_PAIRS = [
  { versionFlag: '--runner-version-id', dirFlag: '--candidate-runner-dir' },
  { versionFlag: '--scorer-runner-version-id', dirFlag: '--scorer-runner-dir' },
] as const

function flagOccurrences(args: string[], flag: string): number {
  return args.filter(arg => arg === flag || arg.startsWith(`${flag}=`)).length
}

/** Extract a flag value accepting BOTH argparse forms: `--flag value` and
 * `--flag=value` (codex P1 on #1447 — the equals form bypassed `getArg`). */
export function extractFlagValue(args: string[], flag: string): string | null {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const value = args[index + 1]
      return typeof value === 'string' && value.trim() ? value : null
    }
    if (args[index].startsWith(`${flag}=`)) {
      const value = args[index].slice(flag.length + 1)
      return value.trim() ? value : null
    }
  }
  return null
}

/**
/** Replace the single occurrence of a dir flag's VALUE (either argparse form)
 * with the verified snapshot path. Duplicates were refused before this runs. */
function rewriteFlagValue(args: string[], flag: string, newValue: string): string[] {
  const rewritten = [...args]
  for (let index = 0; index < rewritten.length; index += 1) {
    if (rewritten[index] === flag) {
      rewritten[index + 1] = newValue
      return rewritten
    }
    if (rewritten[index].startsWith(`${flag}=`)) {
      rewritten[index] = `${flag}=${newValue}`
      return rewritten
    }
  }
  return rewritten
}

export interface GepaVerifiedArgs {
  /** The forwarded argv with each runner-dir flag REWRITTEN to its verified
   * snapshot path — Python executes the hashed bytes, not the mutable dir. */
  args: string[]
  /** The snapshot dirs, for the ORIZU_VERIFIED_RUNNER_DIRS handshake. */
  verifiedDirs: string[]
  cleanup: () => void
}

/**
 * Verify the run-gepa wrapper's two ad-hoc runner dirs (candidate + scorer)
 * against the FORWARDED argv before the Python optimizer is spawned —
 * scanning the same tokens Python will parse, in both argparse forms, so no
 * spelling of the flags can slip past verification. FAIL-CLOSED: if either
 * half of a pair is present but the pair is incomplete, the wrapper refuses
 * here rather than forwarding an unverified pair to argparse. A pair that is
 * entirely absent is left to the Python CLI's required-argument validation —
 * it cannot execute without both. On success each dir flag is REWRITTEN to
 * the verified snapshot (codex round 4): the optimizer runs the exact hashed
 * bytes, immune to post-hash mutation of the original dirs.
 */
export async function verifyGepaRunnerDirsFromArgs(
  args: string[],
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>
): Promise<GepaVerifiedArgs> {
  let rewritten = [...args]
  const verifiedDirs: string[] = []
  const cleanups: Array<() => void> = []
  const cleanup = () => {
    for (const dispose of cleanups) dispose()
  }

  try {
    for (const pair of GEPA_RUNNER_FLAG_PAIRS) {
      // Duplicate flags are refused outright (codex round 3, P1): argparse
      // honors the LAST occurrence, so verifying any single occurrence can
      // diverge from what Python executes. Refusing beats replicating argparse
      // resolution — duplicates have no legitimate use here, and last-wins is
      // exactly the shape an override attack takes.
      for (const flag of [pair.dirFlag, pair.versionFlag]) {
        if (flagOccurrences(args, flag) > 1) {
          throw new Error(
            `Duplicate ${flag}: pass each runner flag exactly once — the Python optimizer honors the ` +
            'last occurrence, which could execute a different runner dir than the one verified (ADR-007).'
          )
        }
      }
      const anyPresent = flagOccurrences(args, pair.dirFlag) > 0 || flagOccurrences(args, pair.versionFlag) > 0
      if (!anyPresent) {
        continue
      }
      const dir = extractFlagValue(args, pair.dirFlag)
      const runnerVersionId = extractFlagValue(args, pair.versionFlag)
      if (!dir || !runnerVersionId) {
        throw new Error(
          `${pair.dirFlag} and ${pair.versionFlag} must both be provided so the runner bytes can be ` +
          'verified against the registered version (ADR-007) — refusing to launch with an unverified runner dir.'
        )
      }
      const verified = await verifyRunnerDirRegistered({
        runnerVersionId,
        dir,
        flag: pair.dirFlag,
        fetcher,
      })
      cleanups.push(verified.cleanup)
      verifiedDirs.push(verified.snapshotDir)
      rewritten = rewriteFlagValue(rewritten, pair.dirFlag, verified.snapshotDir)
    }
  } catch (error) {
    cleanup()
    throw error
  }

  return { args: rewritten, verifiedDirs, cleanup }
}
