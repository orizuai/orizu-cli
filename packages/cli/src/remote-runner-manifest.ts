import { Data, Effect, Result, Schema, SchemaIssue } from 'effect'

// ORI-2805 (ADR-042): a remote runner is the customer's agent behind their own
// URL. It is registered as an ordinary runner version whose only file is this
// manifest. The manifest names the environment variable holding the secret,
// never the secret itself.

const DEFAULT_MAX_PARALLEL = 4
const DEFAULT_TIMEOUT_SECONDS = 900
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
// An allowlist: a registration (which comes from the server) can only ever
// name a variable made for this, never ORIZU_TOKEN or a provider key.
const SECRET_ENV = /^REMOTE_RUNNER_[A-Za-z0-9_]+$/u

export interface RemoteRunnerManifest {
  name: string
  kind: 'remote'
  url: string
  secret_env: string
  max_parallel: number
  timeout_seconds: number
}

export class RemoteRunnerManifestInvalid extends Data.TaggedError('RemoteRunnerManifestInvalid')<{ message: string }> {}

function urlProblem(value: string): true | string {
  let url: URL
  try { url = new URL(value) } catch { return 'is not a URL' }
  if (url.username || url.password) return 'must not contain a username or password; the secret travels in a header'
  if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) return true
  return 'must use https (plain http is allowed only for this machine), because every call carries the secret'
}

const StoredManifest = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literal('remote'),
  url: Schema.String.check(Schema.makeFilter(urlProblem)),
  secret_env: Schema.String.check(Schema.makeFilter((value: string) => SECRET_ENV.test(value)
    || 'must be an environment variable name starting with REMOTE_RUNNER_, so a registration can never send another credential')),
  max_parallel: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 }))),
  timeout_seconds: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 }))),
})
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1()

/**
 * Checks a remote runner manifest. `label` names a field in the message: a CLI
 * flag at registration, the stored manifest field when a run reads it back.
 */
export function decodeRemoteRunnerManifest(raw: unknown, label: (field: string) => string): Effect.Effect<RemoteRunnerManifest, RemoteRunnerManifestInvalid> {
  const decoded = Schema.decodeUnknownResult(StoredManifest)(raw)
  if (Result.isFailure(decoded)) {
    const [issue] = formatIssue(decoded.failure.issue).issues
    const field = String(issue?.path?.[0] ?? 'manifest')
    const problem = issue?.message === 'Missing key' ? 'is required' : issue?.message ?? 'is invalid'
    const guidance = field === 'timeout_seconds' ? '; use a 202 reply and callback for long runs (up to 1 hour)' : ''
    return Effect.fail(new RemoteRunnerManifestInvalid({ message: `${label(field)} ${problem}${guidance}` }))
  }
  const { max_parallel, timeout_seconds, ...manifest } = decoded.success
  return Effect.succeed({ ...manifest, max_parallel: max_parallel ?? DEFAULT_MAX_PARALLEL, timeout_seconds: timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS })
}
