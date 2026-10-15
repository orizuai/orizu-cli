import { join } from 'node:path'

import { Cause, Effect, Exit } from 'effect'

import { authedFetch } from './http.js'
import { responsePayload } from './json-response.js'
import { stageSyncPayload, type SyncDiskOptions, type SyncDiskResult, type SyncPayload, type SyncRequestPlan } from './instruction-set-sync/index.js'
import { applyUpdate, lockedProfileIdentity, makeUpdatePlan, publishNoSyncUpdate, readUpdateLock, type UpdatePlan, type UpdateResult } from './instruction-set-update/index.js'
import { attempt, holdSyncLock } from './instruction-sync-lock.js'

// Loaded only through `await import(...)` from instruction-sets-cli, so CLI
// startup and the published loader never load Effect.

export interface Interrupted { interrupted: 130 | 143 }

function readPayload(path: string, action: string) {
  return Effect.tryPromise({
    // The body stays unchecked here, as before: stageSyncPayload and makeUpdatePlan validate it.
    // SAFETY: their existing error messages for malformed bodies are part of the CLI's output.
    try: async signal => await responsePayload(await authedFetch(path, { method: 'GET', signal }), action) as unknown as SyncPayload,
    catch: cause => cause,
  })
}

// Stage the version, publish it under the lock (to completion once the lock
// is ours), and always remove an unpublished stage, including after Ctrl-C or
// SIGTERM.
function deliverPayload(...args: Parameters<typeof stageSyncPayload>): Effect.Effect<SyncDiskResult, unknown> {
  return Effect.acquireUseRelease(
    attempt(() => stageSyncPayload(...args)),
    staged => holdSyncLock(staged.appRoot, attempt(staged.publish)).pipe(
      Effect.map(warnings => ({ destination: staged.destination, wasPresent: staged.wasPresent, warnings })),
    ),
    staged => Effect.sync(staged.discard),
  )
}

/** Stages and publishes one version under the folder lock (tests and the fixture script). */
export function syncPayloadToDisk(...args: Parameters<typeof stageSyncPayload>): Promise<SyncDiskResult> {
  return runOrThrow(deliverPayload(...args), new AbortController().signal)
}

async function runOrThrow<A>(program: Effect.Effect<A, unknown>, signal: AbortSignal): Promise<A> {
  const exit = await Effect.runPromiseExit(program, { signal })
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}

/**
 * Runs the program with Ctrl-C and SIGTERM turned into an interrupt, and says
 * which stop arrived, if any. `once`: a second signal falls through to Node's
 * default kill. The handlers are removed before this returns.
 */
export async function runWithStops<A>(program: (signal: AbortSignal) => Effect.Effect<A, unknown>) {
  const controller = new AbortController()
  let interrupted: Interrupted['interrupted'] | undefined
  const handleInterrupt = () => { interrupted ??= 130; controller.abort() }
  const handleTerminate = () => { interrupted ??= 143; controller.abort() }
  process.once('SIGINT', handleInterrupt)
  process.once('SIGTERM', handleTerminate)
  try {
    const exit = await Effect.runPromiseExit(program(controller.signal), { signal: controller.signal })
    return { exit, interrupted }
  } finally {
    process.removeListener('SIGINT', handleInterrupt)
    process.removeListener('SIGTERM', handleTerminate)
  }
}

async function runDelivery<A>(program: (signal: AbortSignal) => Effect.Effect<A, unknown>): Promise<A | Interrupted> {
  const { exit, interrupted } = await runWithStops(program)
  if (Exit.isSuccess(exit)) return exit.value
  if (interrupted !== undefined) return { interrupted }
  throw Cause.squash(exit.cause)
}

export function syncInstructionSet(out: string, project: string, plan: SyncRequestPlan, options: SyncDiskOptions) {
  return runDelivery(() => Effect.gen(function*() {
    const payload = yield* readPayload(plan.path, 'Instruction sets sync')
    const result = yield* deliverPayload(out, project, plan, payload, options)
    return { payload, result }
  }))
}

export function updateInstructionSets(
  out: string,
  project: string,
  isApproved: boolean,
  noSync: boolean,
): Promise<{ plan: UpdatePlan; result: UpdateResult } | Interrupted> {
  const program = (signal: AbortSignal) => Effect.gen(function*() {
    const lock = yield* attempt(() => readUpdateLock(out, project))
    const payloads: SyncPayload[] = []
    for (const [setSlug, set] of Object.entries(lock.instructionSets)) {
      const barePath = `/api/cli/instruction-sets/${encodeURIComponent(setSlug)}/sync?project=${encodeURIComponent(project)}`
      payloads.push(yield* readPayload(barePath, 'Instruction sets update'))
      for (const profileSlugValue of Object.keys(set.profiles)) {
        const identity = yield* attempt(() => lockedProfileIdentity(out, setSlug, profileSlugValue))
        const query = new URLSearchParams({ project, profile: identity })
        const path = `/api/cli/instruction-sets/${encodeURIComponent(setSlug)}/sync?${query.toString()}`
        payloads.push(yield* readPayload(path, 'Instruction sets update'))
      }
    }
    const plan = yield* attempt(() => makeUpdatePlan(project, lock, payloads))
    if (!isApproved) return { plan, result: { absent: [], warnings: [] } }
    // --no-sync writes the Lock under the folder lock. Otherwise applyUpdate's
    // own steps are not interruptible; each version it syncs is a nested
    // delivery that the shared signal interrupts and cleans up.
    const result = noSync
      ? yield* holdSyncLock(join(out, 'orizu'), Effect.uninterruptible(Effect.tryPromise({
        try: () => publishNoSyncUpdate(out, project, plan),
        catch: cause => cause,
      })))
      : yield* Effect.uninterruptible(Effect.tryPromise({
        try: () => applyUpdate(out, project, plan, () => new Date(),
          (...args) => runOrThrow(deliverPayload(...args), signal)),
        catch: cause => cause,
      }))
    return { plan, result }
  })
  // --no-sync stages nothing to clean up, so keep Node's default signal
  // handling: a signal stops it at once instead of being held until the
  // update has already landed.
  if (noSync) {
    const signal = new AbortController().signal
    return runOrThrow(program(signal), signal)
  }
  return runDelivery(program)
}
