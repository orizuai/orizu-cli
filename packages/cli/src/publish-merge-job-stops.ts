import { Effect } from 'effect'

import { runPublishMergeJob, type PublishMergeJobEnv } from './publish-merge-job.js'

// ORI-2373 M2: loaded only by `publishMergeJobCommand` with `await import`, so
// the job module, which hosted-session-cli.ts imports statically, keeps no
// top-level Effect import.

/**
 * Runs the job with SIGINT and SIGTERM turned into a stop: the job ends as its
 * deadline would, revokes every key it still holds and posts its result, and
 * then says which stop arrived. The fiber is not interrupted, so the revokes
 * always run. The listeners stay until the job ends, so a second signal does
 * not kill the job mid-revoke (the job's wall still bounds it), and the git
 * runtime's own listener, seeing them, leaves the process to end here.
 */
export async function runPublishMergeJobWithStops(env: PublishMergeJobEnv) {
  const controller = new AbortController()
  let stoppedBy: 130 | 143 | undefined
  const handleInterrupt = () => { stoppedBy ??= 130; controller.abort() }
  const handleTerminate = () => { stoppedBy ??= 143; controller.abort() }
  const result = await Effect.runPromise(Effect.acquireUseRelease(
    Effect.sync(() => { process.on('SIGINT', handleInterrupt); process.on('SIGTERM', handleTerminate) }),
    () => Effect.promise(() => runPublishMergeJob({ env, signal: controller.signal })),
    () => Effect.sync(() => { process.removeListener('SIGINT', handleInterrupt); process.removeListener('SIGTERM', handleTerminate) }),
  ))
  return { result, stoppedBy }
}
