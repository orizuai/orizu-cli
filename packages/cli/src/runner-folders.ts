import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cause, Effect, Exit, Fiber, Scope } from 'effect'

import { ARTIFACT_MAX_BYTES } from './artifact-pull.js'
import { authedFetch } from './http.js'
import { gepaRunnerDirsToVerify, rewriteFlagValue, verifyRunnerDirRegistered, type VerifiedRunnerSnapshot } from './runner-dir-verify.js'
import { unzipRunnerArchive } from './runner-version-materialization.js'

// ORI-2429: Effect owns the lifetime of the runner copies the CLI writes to
// the temp folder (downloaded runner versions and verified snapshots). They
// hold the customer's runner code, so the scope removes them however the run
// ends: success, failure or a stop signal. Loaded with a dynamic import, so
// commands that never copy a runner do not load Effect.

export type RemovalGroup = 'downloads' | 'snapshots' | 'other'

/** Removal failures seen while a scope closes; Effect finalizers cannot fail. */
export class RemovalLedger {
  readonly failures: { group: RemovalGroup; error: unknown }[] = []
  has(group?: RemovalGroup): boolean {
    return this.failures.some(failure => !group || failure.group === group)
  }
  errors(): unknown[] {
    return this.failures.map(failure => failure.error)
  }
}

/** Remove with `remove` when the surrounding scope closes, recording a failure. */
export function removeOnClose(ledger: RemovalLedger, group: RemovalGroup, remove: () => void) {
  return Effect.addFinalizer(() => Effect.sync(() => {
    try { remove() } catch (error) { ledger.failures.push({ group, error }) }
  }))
}

function request(path: string, signal: AbortSignal) {
  return Effect.tryPromise({
    try: requestSignal => authedFetch(path, { signal: AbortSignal.any([requestSignal, signal]) }),
    catch: error => error,
  })
}

function text(response: Response) {
  return Effect.tryPromise({ try: () => response.text(), catch: error => error })
}

/**
 * Download a registered runner version into a private temp folder that the
 * caller's scope removes. A stop mid-download aborts the transfer and still
 * removes the folder. Messages match the previous Promise implementation.
 */
export function downloadedRunner(runnerVersionId: string, ledger: RemovalLedger, verifyRegisteredDigest = true) {
  return Effect.gen(function* () {
    // Aborting on close also ends a body still streaming when a stop arrives.
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      controller => Effect.sync(() => controller.abort()),
    )
    let contentSha256: string | undefined
    if (verifyRegisteredDigest) {
      const detailResponse = yield* request(`/api/cli/runner-versions/${encodeURIComponent(runnerVersionId)}`, controller.signal)
      if (!detailResponse.ok) return yield* Effect.fail(new Error(`Failed to resolve runner version: ${yield* text(detailResponse)}`))
      const detail = (yield* Effect.tryPromise({ try: () => detailResponse.json(), catch: error => error })) as Record<string, unknown>
      if (detail.runnerVersionId !== runnerVersionId || detail.status !== 'sealed'
        || typeof detail.contentSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(detail.contentSha256)) {
        return yield* Effect.fail(new Error('Runner version detail is invalid'))
      }
      contentSha256 = detail.contentSha256
    }
    const response = yield* request(`/api/cli/runner-versions/${encodeURIComponent(runnerVersionId)}/download`, controller.signal)
    if (!response.ok) return yield* Effect.fail(new Error(`Failed to download runner version: ${yield* text(response)}`))
    // The previous implementation removed the folder as soon as this runner
    // failed, naming the runner when that removal failed too. Keep both.
    let removed = false
    let tempDir = ''
    const remove = () => { if (!removed) { removed = true; rmSync(tempDir, { recursive: true, force: true }) } }
    // Created and registered for removal in one uninterruptible step.
    yield* Effect.acquireRelease(
      Effect.sync(() => { tempDir = mkdtempSync(join(tmpdir(), 'orizu-runner-version-')) }),
      () => Effect.sync(() => {
        try { remove() } catch (error) { ledger.failures.push({ group: 'downloads', error }) }
      }),
    )
    return yield* Effect.gen(function* () {
      const zipBytes = new Uint8Array(yield* Effect.tryPromise({ try: () => response.arrayBuffer(), catch: error => error }))
      if (zipBytes.byteLength > ARTIFACT_MAX_BYTES) return yield* Effect.fail(new Error(`Runner artifact exceeds ${ARTIFACT_MAX_BYTES} bytes`))
      if (contentSha256 && createHash('sha256').update(zipBytes).digest('hex') !== contentSha256) {
        return yield* Effect.fail(new Error('Runner artifact digest mismatch'))
      }
      const zipPath = join(tempDir, 'runner.zip'), runnerDir = join(tempDir, 'runner')
      yield* Effect.try({ try: () => { writeFileSync(zipPath, zipBytes); unzipRunnerArchive(zipPath, runnerDir) }, catch: error => error })
      return { runnerDir, remove }
    }).pipe(Effect.catch(error => Effect.suspend(() => {
      try { remove() } catch (cleanupError) {
        return Effect.fail(new AggregateError([error, cleanupError], `Runner ${runnerVersionId} materialization failed and cleanup also failed`))
      }
      return Effect.fail(error)
    })))
  })
}

/** A Promise-returning resource (acquired whole) whose cleanup the scope runs. */
export function heldUntilClose<A extends { cleanup: () => void }>(ledger: RemovalLedger, group: RemovalGroup, acquire: () => Promise<A>) {
  // Acquiring stays uninterruptible: a stop waits for it to finish, so a
  // half-created snapshot is never orphaned; the scope then removes it.
  return Effect.acquireRelease(
    Effect.tryPromise({ try: acquire, catch: error => error }),
    resource => Effect.sync(() => {
      try { resource.cleanup() } catch (error) { ledger.failures.push({ group, error }) }
    }),
  )
}

/**
 * Verify run-gepa's local runner folders (ALI-1159, ADR-007) and rewrite their
 * flags to the verified snapshots. Each runner-version read can be stopped: a
 * stop aborts it, and the scope removes the snapshots made so far (ORI-2732).
 */
export function verifiedGepaRunnerDirs(
  ledger: RemovalLedger,
  args: string[],
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>,
) {
  return Effect.gen(function* () {
    let rewritten = [...args]
    const verifiedDirs: string[] = []
    for (const runner of yield* Effect.try({ try: () => gepaRunnerDirsToVerify(args), catch: error => error })) {
      // Registered before the read starts, so a snapshot the read makes is
      // always removed when the scope closes.
      let snapshot: VerifiedRunnerSnapshot | undefined
      yield* removeOnClose(ledger, 'snapshots', () => snapshot?.cleanup())
      const verified = yield* Effect.suspend(() => {
        const read = new AbortController()
        const reading = verifyRunnerDirRegistered({ runnerVersionId: runner.runnerVersionId, dir: runner.dir, flag: runner.dirFlag, fetcher, signal: read.signal })
          .then(made => (snapshot = made))
        // A stop aborts the read, then waits for it to settle: a sign-in
        // refresh inside it must release the credentials lock and its own stop
        // handlers before the CLI ends by the signal, and a snapshot it still
        // made is then the scope's to remove.
        return Effect.tryPromise({ try: () => reading, catch: error => error }).pipe(
          Effect.onInterrupt(() => Effect.promise(() => {
            read.abort()
            return reading.then(() => undefined, () => undefined)
          })),
        )
      })
      verifiedDirs.push(verified.snapshotDir)
      rewritten = rewriteFlagValue(rewritten, runner.dirFlag, verified.snapshotDir)
    }
    return { args: rewritten, verifiedDirs }
  })
}

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const
// Matches the launcher's stop cap (ORI-2402): a stop never waits longer.
const STOP_CLEANUP_WAIT_MS = 15_000

export interface StopControl {
  /** Hand stop signals to the optimizer launcher; pass this as its beforeSignalExit. */
  readonly beforeSignalExit: () => Promise<void> | void
  readonly launcherOwnsStop: () => void
  readonly launcherDone: () => void
}

/**
 * Run `program` in a scope that removes the runner copies however it ends.
 * Before the optimizer starts, a stop signal interrupts the program (the scope
 * closes as it unwinds) and the CLI then ends by that signal. While the
 * launcher runs the optimizer, the launcher owns the signal and calls
 * `beforeSignalExit`, which closes the scope synchronously: the removal then
 * finishes even when the optimizer used up the whole stop cap.
 */
export async function runStoppable<A>(program: (stop: StopControl) => Effect.Effect<A, unknown, Scope.Scope>): Promise<A> {
  const { scope, close } = openScope()
  let launcherOwned = false
  let stopping = false
  // eslint-disable-next-line prefer-const -- assigned after the handlers that read it
  let fiber: Fiber.Fiber<A, unknown>
  const interrupt = () => Effect.runPromise(Fiber.interrupt(fiber))
  const removeHandlers = () => { for (const entry of handlers) process.off(entry.signal, entry.handle) }
  const handlers = STOP_SIGNALS.map(signal => ({
    signal,
    handle: () => {
      if (launcherOwned || stopping) return
      stopping = true
      let timer: ReturnType<typeof setTimeout> | undefined
      const expired = new Promise<void>(resolve => { timer = setTimeout(resolve, STOP_CLEANUP_WAIT_MS) })
      void Promise.race([interrupt(), expired]).finally(() => {
        clearTimeout(timer)
        removeHandlers()
        process.kill(process.pid, signal)
      })
    },
  }))
  const control: StopControl = {
    beforeSignalExit: () => {
      stopping = true
      // The launcher re-sends the signal next; none of ours may catch it.
      removeHandlers()
      close()
    },
    launcherOwnsStop: () => { launcherOwned = true },
    launcherDone: () => { launcherOwned = false },
  }
  for (const entry of handlers) process.on(entry.signal, entry.handle)
  fiber = Effect.runFork(Scope.provide(scope)(program(control)).pipe(Effect.ensuring(Effect.sync(close))))
  try {
    const exit = await Effect.runPromise(Effect.exit(Fiber.join(fiber)))
    // A stop ends the process by its signal; nothing more to report here.
    if (stopping) return await new Promise<never>(() => {})
    if (Exit.isSuccess(exit)) return exit.value
    throw Cause.squash(exit.cause)
  } finally {
    removeHandlers()
  }
}

/**
 * For a workflow that stays a Promise (hosted optimization): a scope that a
 * stop signal closes before the CLI ends by that signal. Before the optimizer
 * starts our handlers do it; while the launcher runs it, the launcher calls
 * `stop.beforeSignalExit`. Closing aborts an in-flight download and removes
 * every registered file, folder and server; the finalizers are synchronous.
 */
export function stopClosesScope() {
  const { scope, close } = openScope()
  let launcherOwned = false
  let stopping = false
  const removeHandlers = () => { for (const entry of handlers) process.off(entry.signal, entry.handle) }
  const handlers = STOP_SIGNALS.map(signal => ({
    signal,
    handle: () => {
      if (launcherOwned || stopping) return
      stopping = true
      close()
      removeHandlers()
      process.kill(process.pid, signal)
    },
  }))
  // Installed by the caller inside its try, so a setup throw cannot leave them behind.
  const listen = () => { for (const entry of handlers) process.on(entry.signal, entry.handle) }
  const stop: StopControl = {
    beforeSignalExit: () => { stopping = true; removeHandlers(); close() },
    launcherOwnsStop: () => { launcherOwned = true },
    launcherDone: () => { launcherOwned = false },
  }
  return { scope, close, stop, listen, removeHandlers }
}

/** Open a scope for an adapter that must hand back a synchronous cleanup. */
export function openScope() {
  const scope = Scope.makeUnsafe()
  let closed = false
  return {
    scope,
    close: () => {
      if (closed) return
      closed = true
      Effect.runSync(Scope.close(scope, Exit.void))
    },
  }
}
