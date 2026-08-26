function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function isChoice(value: unknown, choices: readonly string[]): boolean {
  return typeof value === 'string' && choices.includes(value)
}

function isProviderObject(value: unknown, keys: readonly string[], choices: Readonly<Record<string, readonly string[]>>): boolean {
  return isRecord(value) && hasOnlyKeys(value, keys)
    && Object.entries(value).every(([key, nested]) => isChoice(nested, choices[key] ?? []))
}

function isCredentialKey(key: string): boolean {
  const tokens = key.replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return tokens.some(token => ['auth', 'authorization', 'token', 'secret', 'password', 'passwd', 'credential', 'credentials', 'key'].includes(token))
    || /(?:authorization|authheader|bearer|token|secret|password|passwd|credential|credentials|apikey|accesskey(?:id)?|privatekey|clientkey|secretkey|connection(?:string|url)|dsn)$/.test(tokens.join(''))
}

function containsCredential(value: unknown, root = true): boolean {
  if (Array.isArray(value)) return root || value.some(nested => containsCredential(nested, false))
  if (!isRecord(value)) return root ? value !== undefined
    : typeof value === 'string' && (/(?:authorization|bearer|x-api-key|x-auth-token)\s*[: ]/i.test(value)
      || /^[a-z]+:\/\/[^/@]*:[^/@]*@/i.test(value))
  return Object.entries(value).some(([key, nested]) => isCredentialKey(key) || containsCredential(nested, false))
}

function unsupportedHostedSetting(value: unknown, model: string): string | null {
  if (value === undefined) return null
  if (!isRecord(value)) return '<root>'
  const providerKeys = model.startsWith('openai/') ? ['reasoning']
    : model.startsWith('anthropic/') ? ['thinking', 'output_config'] : []
  const unknown = Object.keys(value).find(key => !['top_p', ...providerKeys].includes(key))
  if (unknown) return unknown
  if (value.top_p !== undefined && (typeof value.top_p !== 'number'
    || !Number.isFinite(value.top_p) || value.top_p < 0 || value.top_p > 1)) return 'top_p'
  if (value.thinking !== undefined && (!isRecord(value.thinking) || value.thinking.type === undefined)) return 'thinking.type'
  for (const [key, nested, keys, choices] of [
    ['thinking', value.thinking, ['type'], { type: ['adaptive'] }],
    ['output_config', value.output_config, ['effort'], { effort: ['low', 'medium', 'high', 'max'] }],
    ['reasoning', value.reasoning, ['effort', 'summary'], { effort: ['minimal', 'low', 'medium', 'high', 'xhigh'], summary: ['auto', 'concise', 'detailed'] }],
  ] as Array<[string, unknown, readonly string[], Readonly<Record<string, readonly string[]>>]>) if (nested !== undefined && !isProviderObject(nested, keys, choices)) {
    if (!isRecord(nested)) return key
    return `${key}.${Object.keys(nested).find(child => !keys.includes(child)
      || !isChoice(nested[child], choices[child] ?? [])) ?? key}`
  }
  return null
}

export function hostedSettingsContainCredentials(value: unknown): boolean { return containsCredential(value) }

export function hostedProviderSettingsError(
  value: unknown, model = 'anthropic/', temperature?: unknown
): string | null {
  if (hostedSettingsContainCredentials(value)) {
    return 'Hosted reflection provider settings must not contain credential-bearing fields.'
  }
  const unsupported = unsupportedHostedSetting(value, model)
  if (unsupported) return `Unsupported hosted setting "${unsupported}".`
  if (model.startsWith('anthropic/') && temperature !== undefined && temperature !== null
    && isRecord(value) && value.thinking !== undefined) {
    return 'reflection_temperature cannot be combined with Anthropic thinking'
  }
  return null
}
