// Reads the skill source and the install target it is given.
// @tia-reads: skills/orizu
// Replaces one skill folder without ever leaving a half-written one, and never
// deletes a person's files: they are moved to a backup first. Loaded only
// through `await import(...)`, so `orizu skills path` never loads Effect.
import { cp, lstat, mkdir, readdir, readlink, readFile, rename, rm, symlink, unlink, copyFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { Context, Effect, Exit, Option, Schema } from 'effect'

import { computeSkillContentHash, SKILL_META_FILENAME, shouldCopySkillPath } from './skill-installer.js'

export interface ReplaceSkillFolderInput {
  sourceRoot: string
  targetPath: string
  mode: 'link' | 'copy'
  /** Where a person's own folder is moved; no agent looks for skills there. */
  backupPath: string
  /** Writes Orizu's marker into the new copy before it is put in place. */
  writeMarker: (dir: string) => void
}

export interface ReplaceSkillFolderResult {
  /** Where a person's own folder was moved, when there was one. */
  backup: string | null
  /** Why a person's folder, or part of it, is still beside the skill. */
  warning?: string
}

/** Every rename the replacement makes. Tests swap it to make one rename fail. */
const SkillFolderRename = Context.Reference<(from: string, to: string) => Promise<void>>('orizu/SkillFolderRename', {
  defaultValue: () => rename,
})

const renameEntry = (from: string, to: string) => Effect.gen(function*() {
  const move = yield* SkillFolderRename
  yield* attempt(() => move(from, to))
})

const SkillMarker = Schema.Struct({ skillHash: Schema.String })

type Existing = 'missing' | 'link' | 'orizu' | 'person'

const attempt = <A>(run: () => Promise<A>) =>
  // One file step at a time: an interruption lands between steps, never during one.
  Effect.uninterruptible(Effect.tryPromise({ try: run, catch: cause => cause instanceof Error ? cause : new Error(String(cause)) }))

const exists = (path: string) => attempt(() => lstat(path).then(() => true, () => false))

// Orizu's own install is a link, or a copy whose files still match its marker
// or the skill being installed. Anything else may hold a person's work.
function classify(targetPath: string, sourceRoot: string): Effect.Effect<Existing, Error> {
  return Effect.gen(function*() {
    const stats = yield* attempt(() => lstat(targetPath).then(found => found, () => null))
    if (!stats) return 'missing'
    if (stats.isSymbolicLink()) return 'link'
    if (!stats.isDirectory()) return 'person'
    const marker = yield* attempt(() => readFile(join(targetPath, SKILL_META_FILENAME), 'utf8').then(text => JSON.parse(text) as unknown, () => null))
    const installedHash = computeSkillContentHash(targetPath)
    const recorded = Schema.decodeUnknownOption(SkillMarker)(marker)
    if (Option.isSome(recorded) && recorded.value.skillHash === installedHash) return 'orizu'
    return installedHash === computeSkillContentHash(sourceRoot) ? 'orizu' : 'person'
  })
}

function copyTree(root: string, from: string, to: string): Effect.Effect<void, Error> {
  return Effect.gen(function*() {
    yield* attempt(() => mkdir(to, { recursive: true }))
    const entries = yield* attempt(() => readdir(from, { withFileTypes: true }))
    for (const entry of entries) {
      const source = join(from, entry.name)
      const target = join(to, entry.name)
      if (!shouldCopySkillPath(root, source)) continue
      if (entry.isDirectory()) yield* copyTree(root, source, target)
      else if (entry.isFile()) yield* attempt(() => copyFile(source, target))
      else if (entry.isSymbolicLink()) yield* attempt(async () => symlink(await readlink(source), target))
      else yield* Effect.fail(new Error(`${source} is not a file or folder, so the skill can't be copied.`))
    }
  })
}

// Links are removed as links, never by following them.
const removeEntry = (path: string) => attempt(async () => {
  const stats = await lstat(path).catch(() => null)
  if (!stats) return
  if (stats.isSymbolicLink()) await unlink(path)
  else await rm(path, { recursive: true, force: true })
})


/**
 * Moves a person's folder to the backup. Once the copy is whole, the backup
 * is reported even when the original cannot be removed; if nothing could be
 * moved, the folder stays where it is and the warning says why.
 */
function moveToBackup(from: string, to: string): Effect.Effect<ReplaceSkillFolderResult> {
  const stayed = (cause: Error): ReplaceSkillFolderResult => ({
    backup: resolve(from),
    warning: `Could not move your earlier folder to ${to}: ${cause.message}. It is still at ${from}, where agents may load it as a second skill; move it somewhere else.`,
  })
  return Effect.gen(function*() {
    yield* attempt(() => mkdir(dirname(to), { recursive: true }))
    // A project on another disk cannot be renamed into the home folder, so it is copied.
    const renamed = yield* renameEntry(from, to).pipe(Effect.as(true), Effect.catch(error =>
      (error as { code?: string }).code === 'EXDEV' ? Effect.succeed(false) : Effect.fail(error)))
    if (renamed) return { backup: resolve(to) }
    // Our own half-made copy is removed; the person's folder is untouched.
    yield* attempt(() => cp(from, to, { recursive: true, verbatimSymlinks: true })).pipe(
      Effect.tapError(() => removeEntry(to).pipe(Effect.ignore)))
    return yield* attempt(() => rm(from, { recursive: true })).pipe(
      Effect.as<ReplaceSkillFolderResult>({ backup: resolve(to) }),
      Effect.catch(cause => Effect.succeed<ReplaceSkillFolderResult>({
        backup: resolve(to),
        warning: `Copied your earlier folder to ${to}, but could not remove it from ${from}: ${cause.message}. Agents may load it there as a second skill; remove it once you have checked the copy.`,
      })),
    )
  }).pipe(Effect.catch(cause => Effect.succeed(stayed(cause))))
}

/**
 * Stage the new skill beside the target, move the old folder aside, rename the
 * staged one into place, then drop Orizu's old copy or back up a person's.
 * On a failure or an interruption, staging is removed and the old folder is
 * put back.
 */
function replaceSkillFolder(input: ReplaceSkillFolderInput): Effect.Effect<ReplaceSkillFolderResult, Error> {
  const { sourceRoot, targetPath, mode } = input
  const id = `${process.pid}-${Date.now().toString(36)}`
  const name = basename(targetPath)
  const staging = join(dirname(targetPath), `${name}.orizu-staging-${id}`)
  const aside = join(dirname(targetPath), `${name}.orizu-previous-${id}`)

  // Set when the old folder could not be put back after a failure.
  let strandedAt: string | null = null

  // Only the copy into staging can be interrupted. Once the old folder moves
  // aside, the swap and the clean-up after it always finish, so Ctrl-C can
  // never skip putting the old folder back or moving a person's folder out.
  return Effect.uninterruptibleMask(restore => Effect.gen(function*() {
    const existing = yield* classify(targetPath, sourceRoot)
    yield* attempt(() => mkdir(dirname(targetPath), { recursive: true }))

    const swapped = yield* Effect.scoped(Effect.gen(function*() {
      // Registered before staging starts, so a copy that stops part way is removed too.
      // Gone already once it has been renamed into place.
      yield* Effect.addFinalizer(() => removeEntry(staging).pipe(Effect.ignore))
      yield* restore(mode === 'link'
        ? attempt(() => symlink(sourceRoot, staging, 'dir'))
        : copyTree(sourceRoot, sourceRoot, staging).pipe(
          Effect.andThen(Effect.try({ try: () => input.writeMarker(staging), catch: cause => cause instanceof Error ? cause : new Error(String(cause)) }))))
      if (existing !== 'missing') {
        yield* Effect.acquireRelease(
          renameEntry(targetPath, aside),
          (_, exit) => Exit.isSuccess(exit)
            ? Effect.void
            // Put the old folder back unless something already holds its place.
            : exists(targetPath).pipe(
              Effect.flatMap(taken => taken ? Effect.fail(new Error(`${targetPath} is taken`)) : renameEntry(aside, targetPath)),
              Effect.catch(() => Effect.sync(() => { strandedAt = aside })),
            ),
        )
      }
      yield* renameEntry(staging, targetPath)
      return existing
    })).pipe(Effect.mapError(error => strandedAt
      ? new Error(`${error.message} Your earlier folder could not be put back at ${targetPath}; it is at ${strandedAt}.`)
      : error))

    if (swapped === 'missing') return { backup: null }
    if (swapped !== 'person') {
      yield* removeEntry(aside).pipe(Effect.mapError(cause => new Error(`Installed ${targetPath}, but could not remove the earlier copy at ${aside}: ${cause.message}`)))
      return { backup: null }
    }
    // The person's folder is safe beside the target; move it out of agents' sight.
    return yield* moveToBackup(aside, input.backupPath)
  }))
}

/** One replacement whose renames go through `move`, so a test can make one fail. */
export async function replaceSkillFolderUsing(move: (from: string, to: string) => Promise<void>, input: ReplaceSkillFolderInput): Promise<ReplaceSkillFolderResult> {
  return await Effect.runPromise(replaceSkillFolder(input).pipe(Effect.provideService(SkillFolderRename, move)))
}

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const

/** Ends the process by the signal that stopped it, once its handlers are gone. */
async function endBy(signal: NodeJS.Signals, handlers: ReadonlyArray<readonly [NodeJS.Signals, () => void]>): Promise<never> {
  for (const [name, handler] of handlers) process.removeListener(name, handler)
  process.kill(process.pid, signal)
  // The signal ends the process; if another listener holds it, exit as a shell would.
  setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 143), 1_000)
  return await new Promise<never>(() => {})
}

/**
 * Runs one replacement. Ctrl-C or SIGTERM interrupts it; once staging is
 * removed and the old folder is back, the process ends by that same signal.
 */
export async function runSkillFolderReplacement(input: ReplaceSkillFolderInput): Promise<ReplaceSkillFolderResult> {
  const controller = new AbortController()
  const stop: { by: NodeJS.Signals | null } = { by: null }
  const handlers = STOP_SIGNALS.map(signal => [signal, () => { stop.by = signal; controller.abort() }] as const)
  for (const [signal, handler] of handlers) process.once(signal, handler)
  try {
    const result = await Effect.runPromise(replaceSkillFolder(input), { signal: controller.signal })
    // A stop that arrived as the replacement finished still stops the command.
    if (stop.by) return await endBy(stop.by, handlers)
    return result
  } catch (error: unknown) {
    if (!stop.by) throw error
    return await endBy(stop.by, handlers)
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
  }
}
