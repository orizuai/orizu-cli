import type { ProviderEntry, WireProtocol } from './provider-registry.js'

/** Join is baseUrl.rstrip('/') + path. Messages excludes /v1 in baseUrl;
 * both OpenAI protocols include the version segment in baseUrl. */
export const PROBE_PROTOCOLS: Record<WireProtocol, { path: string; headers: Record<string, string> }> = {
  'openai-chat': { path: '/chat/completions', headers: {} },
  'openai-responses': { path: '/responses', headers: {} },
  'anthropic-messages': { path: '/v1/messages', headers: { 'anthropic-version': '2023-06-01' } },
}

export interface ProbeReport {
  reached: boolean
  usageReported: boolean
  toolCallAccepted: boolean
  structuredOutputAccepted: boolean | 'not-applicable'
  credentialRejected: boolean
  status: number | null
  latencyMs: number
  classification?: 'unreachable' | 'credentialRejected' | 'base_url_or_model_not_found' | 'provider_rejected_request'
  errorType?: string
  errorCode?: string
}

export function probeTarget(provider: ProviderEntry): string {
  return provider.baseUrl.replace(/\/+$/, '') + PROBE_PROTOCOLS[provider.protocol].path
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

function requestBody(protocol: WireProtocol, model: string, capability: 'reach' | 'tool' | 'structured'): Record<string, unknown> {
  const parameters = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
  const fn = { name: 'probe', description: 'A no-op probe.', parameters }
  const body: Record<string, unknown> = protocol === 'openai-responses'
    ? { model, input: 'Reply OK.', max_output_tokens: 32 }
    : { model, messages: [{ role: 'user', content: 'Reply OK.' }], ...(protocol === 'anthropic-messages' ? { max_tokens: 32 } : { max_completion_tokens: 32 }) }
  if (capability === 'tool') {
    body.tools = protocol === 'anthropic-messages' ? [{ name: fn.name, description: fn.description, input_schema: parameters }]
      : protocol === 'openai-responses' ? [{ type: 'function', ...fn }] : [{ type: 'function', function: fn }]
  }
  if (capability === 'structured') {
    const format = { type: 'json_schema', name: 'probe', strict: true, schema: parameters }
    if (protocol === 'openai-responses') body.text = { format }
    else body.response_format = { type: 'json_schema', json_schema: { name: 'probe', strict: true, schema: parameters } }
  }
  return body
}

/** Reports only. The command owns refusal and never persists this credential.
 * Error shapes measured in t3-probe-measurement.md; unknown 400 is NOT not-found. */
export async function probeProvider(provider: ProviderEntry, model: string, credential: string): Promise<ProbeReport> {
  // Other Effect commands lazy-load their whole module from index.ts. This
  // module imports Effect inside the function so unrelated packed CLI commands
  // do not load it before dependencies have been installed.
  const { Effect } = await import('effect')
  const started = Date.now()
  const report: ProbeReport = { reached: false, usageReported: false, toolCallAccepted: false,
    structuredOutputAccepted: provider.protocol === 'anthropic-messages' ? 'not-applicable' : false,
    credentialRejected: false, status: null, latencyMs: 0 }
  const request = (capability: 'reach' | 'tool' | 'structured') => Effect.runPromise(Effect.match(Effect.tryPromise({
    try: async () => {
      const response = await fetch(probeTarget(provider), {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json', ...PROBE_PROTOCOLS[provider.protocol].headers, [provider.authHeader]: provider.authValuePrefix + credential },
        body: JSON.stringify(requestBody(provider.protocol, model, capability)),
      })
      const body: unknown = await response.json().catch(() => null)
      return { status: response.status, ok: response.ok, body: object(body) }
    }, catch: () => null,
  }), { onFailure: () => null, onSuccess: result => result }))
  const hasResponseEnvelope = (body: Record<string, unknown>) => !body.error && Array.isArray(body[provider.protocol === 'anthropic-messages' ? 'content' : provider.protocol === 'openai-responses' ? 'output' : 'choices'])
  const first = await request('reach')
  if (!first) report.classification = 'unreachable'
  else {
    report.status = first.status
    report.reached = true
    const error = object(first.body.error)
    // Provider-controlled diagnostics must not echo a credential, even if it
    // happens to consist entirely of identifier characters.
    const safeField = (value: unknown) => typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_.-]{0,79}$/.test(value) && !value.includes(credential) ? value : undefined
    report.errorType = safeField(error.type)
    report.errorCode = safeField(error.code)
    if (first.status === 401 || first.status === 403) {
      report.credentialRejected = true
      report.classification = 'credentialRejected'
    } else if (first.status === 404 || error.code === 'model_not_found') report.classification = 'base_url_or_model_not_found'
    else if (!first.ok) report.classification = 'provider_rejected_request'
    else {
      report.usageReported = Object.values(object(first.body.usage)).some(value => typeof value === 'number' && Number.isFinite(value))
      const tool = await request('tool')
      report.toolCallAccepted = !!tool?.ok && hasResponseEnvelope(tool.body)
      if (provider.protocol !== 'anthropic-messages') {
        const structured = await request('structured')
        report.structuredOutputAccepted = !!structured?.ok && hasResponseEnvelope(structured.body)
      }
    }
  }
  report.latencyMs = Date.now() - started
  return report
}
