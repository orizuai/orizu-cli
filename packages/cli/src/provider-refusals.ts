import { providerIds, requireProvider } from './provider-registry.js'

export const CREDENTIAL_ENV_PATTERN = /^[A-Z][A-Z0-9_]{0,58}_API_KEY$/
/** The SQL CHECK patterns, drift-tested against the replayed catalog. */
export const PROVIDER_FIELD_PATTERNS: Record<string, RegExp> = {
  id: /^[a-z][a-z0-9-]{0,63}$/,
  base_url: /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~/-]*)?$/,
  credential_env: CREDENTIAL_ENV_PATTERN,
  auth_header: /^[A-Za-z0-9-]{1,64}$/,
  auth_value_prefix: /^[A-Za-z ]{0,16}$/,
}
export const RESERVED_CREDENTIAL_ENVS = new Set([
  ...providerIds().map(id => requireProvider(id).credentialEnv),
  'GEMINI_API_KEY', // Historical SQL reservation; removing local forwarding does not release this name.
  'GOOGLE_API_KEY', // Historical SQL reservation for the Google alias, independent of run providers.
  'ALI_1505_ENDPOINT_OVERRIDE_API_KEY', // hosted-optimization.ts: runner-injected secret.
  'BRAINTRUST_API_KEY', // lib/hosted-connectors.ts: workbench connector.
  'CF_API_KEY', // test/with-cloudflare-env.test.ts: Cloudflare spelling.
  'CLOUDFLARE_API_KEY', // test/with-cloudflare-env.test.ts: Cloudflare spelling.
  'DAYTONA_API_KEY', // scripts/daytona-workbench-slice.mjs: hosted sandbox.
  'INTERNAL_API_KEY', // Historical SQL reservation; the internal compile route is gone (ORI-2305).
  'LINEAR_API_KEY', // lib/services/linear-feedback.ts: issue service.
  'RESEND_API_KEY', // lib/services/email.ts: email delivery.
])

/** Shared route and local-probe refusal vocabulary. No error envelope: the
 * route sends the code itself as { error }; the CLI owns probe calls. */
export const PROVIDER_REFUSAL_CONTRACTS = {
  model_config_provider_not_found: { status: 409, remediation: 'Register the provider first with `orizu providers add <id> ...`. Provider ids must start with a lowercase letter, use only lowercase letters, digits and dashes, and be at most 64 characters (`^[a-z][a-z0-9-]{0,63}$`).' },
  provider_id_invalid: { status: 400, remediation: 'Use a lowercase provider id starting with a letter, at most 64 characters.' },
  provider_id_reserved: { status: 400, remediation: 'Choose an id that is not a built-in provider.' },
  provider_protocol_invalid: { status: 400, remediation: 'Choose openai-chat, openai-responses, or anthropic-messages.' },
  provider_base_url_invalid: { status: 400, remediation: 'Use an HTTPS base URL without credentials, query, or fragment.' },
  provider_credential_env_invalid: { status: 400, remediation: 'Use an uppercase environment name ending in _API_KEY, at most 67 characters.' },
  provider_credential_env_reserved: { status: 400, remediation: 'Choose an environment name not used by Orizu or a built-in provider.' },
  provider_auth_header_invalid: { status: 400, remediation: 'Use an auth header name with 1–64 letters, digits, or hyphens.' },
  provider_auth_value_prefix_invalid: { status: 400, remediation: 'Use an auth value prefix with at most 16 letters or spaces.' },
  provider_credential_env_collision: { status: 409, remediation: 'Choose an environment name not used by another provider in this project.' },
  provider_already_exists: { status: 409, remediation: 'Choose a different provider id for this project.' },
  provider_not_found: { status: 404, remediation: 'Check the provider id and project.' },
  provider_in_use: { status: 409, remediation: 'This provider is used by one or more model configs in this project and cannot be removed while they exist.' },
  'provider_probe_failed:provider_rejected_request': { status: 400, remediation: 'Check the provider account and request settings; inspect the reported HTTP status and error type/code.' },
  'provider_probe_failed:unreachable': { status: 400, remediation: 'Check connectivity and the provider base URL.' },
  'provider_probe_failed:base_url_or_model_not_found': { status: 400, remediation: 'Check the base URL and model id.' },
  'provider_probe_failed:credential_env_unset': { status: 400, remediation: 'Set the named credential environment variable before probing.' },
  'provider_probe_failed:credentialRejected': { status: 400, remediation: 'Use a credential accepted by the provider.' },
} satisfies Record<string, { status: 400 | 404 | 409; remediation: string }>

export type ProviderRefusalCode = keyof typeof PROVIDER_REFUSAL_CONTRACTS

export function isProviderRefusalCode(value: string): value is ProviderRefusalCode {
  return Object.hasOwn(PROVIDER_REFUSAL_CONTRACTS, value)
}
