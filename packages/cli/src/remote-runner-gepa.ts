import { Effect } from 'effect'

import { sanitizeTerminalText } from './json-response.js'
import { startRemoteRunnerBridge } from './remote-runner-bridge.js'
import { createRemoteRunnerSession } from './remote-runner-call.js'
import { decodeRemoteRunnerManifest } from './remote-runner-manifest.js'

/** Local Python uses exec's HTTP owner, never another remote runner contract. */
export function configureRemoteGepaRunner(rawManifest: unknown, runnerVersionId: string, environment: NodeJS.ProcessEnv, announce: (line: string) => void,
  hosted?: { runId: string; snapshot: unknown; request: (path: string, init?: RequestInit) => Promise<Response> }) {
  return Effect.gen(function* () {
    if (environment.ORIZU_HOSTED_OPTIMIZATION_RUN_ID && !hosted) {
      return yield* Effect.fail(new Error('remote_runner_not_supported_for_hosted_optimization: hosted runs cannot call remote runners yet (ORI-2817). Run locally instead.'))
    }
    const manifest = yield* decodeRemoteRunnerManifest(rawManifest, field => `Runner version ${runnerVersionId}: stored manifest field ${field}`)
    if (hosted) {
      const snapshot = hosted.snapshot
      if (!snapshot || typeof snapshot !== 'object' || !('runnerVersionId' in snapshot) || snapshot.runnerVersionId !== runnerVersionId
        || !('url' in snapshot) || snapshot.url !== manifest.url || !('timeoutSeconds' in snapshot) || snapshot.timeoutSeconds !== manifest.timeout_seconds
        || !('maxParallel' in snapshot) || snapshot.maxParallel !== manifest.max_parallel) {
        return yield* Effect.fail(new Error('Hosted remote runner does not match the admitted version'))
      }
    }
    const session = yield* createRemoteRunnerSession({ manifest, runnerVersionId, environment: process.env, hosted, announce: line => announce(sanitizeTerminalText(line)) })
    const bridge = yield* startRemoteRunnerBridge(session)
    // Closing only after Python exits is too late: its workers may be waiting
    // on the endpoint. Stop those HTTP calls as soon as the launcher is stopped.
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const
    const handleStop = () => Effect.runSync(bridge.stopCalls)
    yield* Effect.acquireRelease(
      Effect.sync(() => { for (const signal of signals) process.on(signal, handleStop) }),
      () => Effect.sync(() => { for (const signal of signals) process.off(signal, handleStop) }),
    )
    environment.ORIZU_REMOTE_RUNNER_BRIDGE_URL = bridge.url
    for (const name of Object.keys(environment)) {
      if (name.startsWith('REMOTE_RUNNER_')) delete environment[name]
    }
  })
}
