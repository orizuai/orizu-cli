import { Data, Effect } from 'effect'

import { authedFetch } from './http.js'
import { sanitizeTerminalText } from './json-response.js'
import type { RemoteRunnerAddContext } from './remote-runner-cli.js'

class Failed extends Data.TaggedError('HostedRemoteRunnerFailed')<{ message: string }> {}
function attempt<T>(run: () => PromiseLike<T>) {
  return Effect.tryPromise({ try: async () => await run(), catch: () => new Failed({ message: 'Hosted runner credential request failed' }) })
}
export function runSetHostedRunnerSecret(ctx: RemoteRunnerAddContext): Promise<void> {
  return Effect.runPromise(Effect.gen(function* () {
    const version = ctx.getPositionalArg(2)
    const host = ctx.getArg('--host')
    const variable = ctx.getArg('--secret-env')
    if (!version || !host || !variable || !/^REMOTE_RUNNER_[A-Za-z0-9_]+$/u.test(variable) || ctx.hasFlag('--session')) {
      return yield* new Failed({ message: 'Use runners set-hosted-secret <version-id> --host <registered-host> --secret-env <REMOTE_RUNNER_…> --project <team/project>' })
    }
    const project = ctx.getArg('--project') || (yield* attempt(() => ctx.resolveProjectSlug(null)))
    const path = `/api/cli/runner-versions/${encodeURIComponent(version)}/hosted-credential?project=${encodeURIComponent(project)}`
    const response = yield* attempt(() => authedFetch(path))
    if (!response.ok) return yield* new Failed({ message: `Cannot resolve hosted runner credential destination (status ${response.status})` })
    const value: unknown = yield* attempt(() => response.json())
    if (!value || typeof value !== 'object' || !('host' in value) || value.host !== host
      || !('secret_env' in value) || value.secret_env !== variable) return yield* new Failed({ message: 'Explicit host and secret environment name must match the registered version' })
    // Only explicit consent to this exact destination permits reading a local value.
    const credential = process.env[variable]
    if (!credential) return yield* new Failed({ message: `${variable} is not set` })
    const saved = yield* attempt(() => authedFetch(path, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host, credential }),
    }))
    if (!saved.ok) return yield* new Failed({ message: `Hosted runner credential upload failed (status ${saved.status})` })
    if (ctx.hasJsonFlag()) ctx.printJson({ runner_version_id: version, host, has_credential: true })
    else ctx.printLine(`Saved hosted credential for runner version ${sanitizeTerminalText(version)} at ${sanitizeTerminalText(host)}. The receiver must not reflect Authorization.`)
  }))
}
