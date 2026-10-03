import { authedFetch } from './http.js'
import { providerWireRecord as object } from './provider-wire-record.js'
import { credentialEnvFor, providerLookupFor } from './provider-lookup.js'
import { CREDENTIAL_ENV_PATTERN, PROVIDER_FIELD_PATTERNS, RESERVED_CREDENTIAL_ENVS, isProviderRefusalCode } from './provider-refusals.js'
import { findProvider, parseModelIdentity } from './provider-registry.js'
import { PROBE_PROTOCOLS, probeProvider, probeTarget } from './provider-probe.js'

import type { ModelConfigsCommandIo } from './model-configs-cli.js'
import type { ProviderEntry, WireProtocol } from './provider-registry.js'

const FIELD_CONTRACT = 'Anthropic Messages base URL excludes /v1; OpenAI base URLs include the version segment.'
function assertProtocol(value: unknown): asserts value is WireProtocol {
  if (typeof value !== 'string' || !Object.hasOwn(PROBE_PROTOCOLS, value)) throw new Error('provider_protocol_invalid')
}
function credentialName(name: string) {
  if (!CREDENTIAL_ENV_PATTERN.test(name)) throw new Error('provider_credential_env_invalid')
  if (RESERVED_CREDENTIAL_ENVS.has(name)) throw new Error('provider_credential_env_reserved')
}
function providerRow(value: unknown): ProviderEntry {
  const row = object(value)
  const fields: Array<{ field: string; pattern: RegExp; code: string }> = [
    { field: 'id', pattern: PROVIDER_FIELD_PATTERNS.id!, code: 'provider_id_invalid' },
    { field: 'baseUrl', pattern: PROVIDER_FIELD_PATTERNS.base_url!, code: 'provider_base_url_invalid' },
    { field: 'authHeader', pattern: PROVIDER_FIELD_PATTERNS.auth_header!, code: 'provider_auth_header_invalid' },
    { field: 'authValuePrefix', pattern: PROVIDER_FIELD_PATTERNS.auth_value_prefix!, code: 'provider_auth_value_prefix_invalid' },
  ]
  for (const { field, pattern, code } of fields) {
    if (typeof row[field] !== 'string' || !pattern.test(String(row[field]))) throw new Error(code)
  }
  if (typeof row.credentialEnv !== 'string') throw new Error('provider_credential_env_invalid')
  credentialName(row.credentialEnv)
  const baseUrl = String(row.baseUrl)
  if (Buffer.byteLength(baseUrl) > 2048 || !URL.canParse(baseUrl)) throw new Error('provider_base_url_invalid')
  const wireProtocol = row.protocol
  assertProtocol(wireProtocol)
  return { id: String(row.id), baseUrl, credentialEnv: row.credentialEnv, authHeader: String(row.authHeader), authValuePrefix: String(row.authValuePrefix), protocol: wireProtocol, builtIn: false }
}

function parseArgs(args: string[]) {
  const positional: string[] = []
  const flags = new Map<string, string>()
  const values = new Set(['--base-url', '--protocol', '--credential-env', '--auth-header', '--auth-value-prefix', '--probe-model', '--project'])
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--json' || arg === '--no-probe') flags.set(arg, '')
    else if (values.has(arg)) {
      const value = args[++index]
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
      flags.set(arg, value)
    } else if (arg.startsWith('-')) throw new Error('Unknown provider option')
    else positional.push(arg)
  }
  return { positional, flags }
}

async function runProbe(provider: ProviderEntry, model: string, io: ModelConfigsCommandIo): Promise<void> {
  // Built-ins come only from the local registry, never from server-supplied
  // builtIn flags. All customer names have passed the shared reserved guard.
  if (findProvider(provider.id) !== provider) credentialName(provider.credentialEnv)
  const target = probeTarget(provider)
  const notice = { credentialEnv: provider.credentialEnv, target, fieldContract: FIELD_CONTRACT }
  io.print(io.json ? JSON.stringify({ probeTarget: notice }) : `Probe: ${provider.credentialEnv} → ${target}. ${FIELD_CONTRACT}`)
  const credential = process.env[provider.credentialEnv]
  if (!credential) throw new Error('provider_probe_failed:credential_env_unset')
  const report = await probeProvider(provider, model, credential)
  if (io.json) io.print(JSON.stringify({ probe: report }))
  else {
    io.print(`Reached: ${report.reached}`)
    io.print(`Usage reported: ${report.usageReported}`)
    io.print(`Tool call accepted: ${report.toolCallAccepted}`)
    io.print(`Structured output accepted: ${report.structuredOutputAccepted}`)
    io.print(`Credential rejected: ${report.credentialRejected}`)
    if (report.classification) io.print(`HTTP status: ${report.status ?? 'none'}${report.errorType ? `; type: ${report.errorType}` : ''}${report.errorCode ? `; code: ${report.errorCode}` : ''}`)
  }
  if (report.classification) throw new Error(`provider_probe_failed:${report.classification}`)
}

export async function providersCommand(args: string[], io: ModelConfigsCommandIo, checkIdentity?: string): Promise<number> {
  try {
    const { positional, flags } = parseArgs(args)
    const [command, id] = positional
    let provider: ProviderEntry | undefined
    if (checkIdentity === undefined && command === 'add' && id && positional.length === 2) {
      if (findProvider(id)) throw new Error('provider_id_reserved')
      let baseUrl = flags.get('--base-url') || ''
      // Lowercase only the authority. URL serialization would normalize paths.
      baseUrl = baseUrl.replace(/^(https:\/\/)([^/]+)/, (_, scheme: string, host: string) => scheme + host.toLowerCase())
      provider = providerRow({ id, baseUrl, protocol: flags.get('--protocol') ?? 'openai-chat', credentialEnv: flags.get('--credential-env') ?? credentialEnvFor(id), authHeader: flags.get('--auth-header') ?? 'Authorization', authValuePrefix: flags.get('--auth-value-prefix') ?? 'Bearer ' })
    }
    if (checkIdentity === undefined && command === 'list' && positional.length === 1) {
      const { listProviders } = await import('./provider-list-workflow.js')
      return listProviders(flags.get('--project') || null, io)
    }
    const project = await io.resolveProjectSlug?.(flags.get('--project') || null)
    if (!project) throw new Error('Project resolver unavailable')
    const fetcher = io.fetcher ?? authedFetch
    const root = `/api/cli/providers?project=${encodeURIComponent(project)}`
    const request = async (path: string, init: RequestInit) => {
      const response = await fetcher(path, init)
      const body: unknown = response.status === 204 ? null : await response.json().catch(() => null)
      if (!response.ok) {
        const error = object(body).error
        throw new Error(typeof error === 'string' && isProviderRefusalCode(error) ? error : 'Provider request failed')
      }
      return object(body)
    }
    if (checkIdentity !== undefined) {
      const identity = parseModelIdentity(checkIdentity)
      if (!identity.provider || !identity.modelId) throw new Error('provider_not_found')
      const body = await request(root, { method: 'GET' })
      // Ignore server overrides of built-ins. Validate the selected customer
      // only: unrelated poisoned rows cannot cause an arbitrary env read.
      const builtin = findProvider(identity.provider)
      const rows = Array.isArray(body.providers) ? body.providers : []
      const selected = rows.find(row => object(row).id === identity.provider)
      if (!builtin && !selected) throw new Error('provider_not_found')
      const lookup = providerLookupFor(builtin ? [] : [providerRow(selected)])
      const entry = lookup.find(identity.provider)
      if (!entry) throw new Error('provider_not_found')
      await runProbe(entry, identity.modelId, io)
    } else if (command === 'remove' && id && positional.length === 2) {
      await request(`/api/cli/providers/${encodeURIComponent(id)}?project=${encodeURIComponent(project)}`, { method: 'DELETE' })
      io.print(io.json ? JSON.stringify({ removed: id }) : `Removed provider ${id}`)
    } else if (command === 'add' && provider) {
      const suspicious = new URL(provider.baseUrl).pathname.split('/').some(segment => segment.length > 32 || segment.includes('sk-'))
      if (suspicious) io.print(io.json ? JSON.stringify({ warning: 'Base URL path may contain a secret; project members can read it.' }) : 'Warning: base URL path may contain a secret; project members can read it.')
      if (flags.has('--no-probe')) {
        if (flags.has('--probe-model')) io.print(io.json ? JSON.stringify({ warning: '--probe-model is ignored with --no-probe.' }) : 'Warning: --probe-model is ignored with --no-probe.')
        io.print(io.json ? JSON.stringify({ warning: 'Provider is unproven (--no-probe).' }) : 'Warning: provider is unproven (--no-probe).')
      } else {
        const model = flags.get('--probe-model')
        if (!model) throw new Error('--probe-model is required unless --no-probe')
        await runProbe(provider, model, io)
      }
      const { builtIn: _builtIn, ...body } = provider
      const result = await request(root, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      io.print(io.json ? JSON.stringify(result) : `Added provider ${id}`)
    } else throw new Error('Usage: orizu providers <add|list|remove> [--project <team/project>] [--json]')
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Provider request failed'
    io.print(io.json ? JSON.stringify({ error: message }) : message)
    return 1
  }
}
