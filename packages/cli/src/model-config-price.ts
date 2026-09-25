/** Current model-config price metadata; never invocation settings. */
export interface ModelConfigPrice {
  currency?: 'USD'
  input_usd_per_million_tokens: number
  output_usd_per_million_tokens: number
  cache_read_usd_per_million_tokens?: number
  cache_write_usd_per_million_tokens?: number
}

export interface ModelConfigTokenRates {
  inputUsdPerToken: number
  outputUsdPerToken: number
  cachedInputUsdPerToken?: number
  cacheWriteUsdPerToken?: number
}

const rateFields = [
  'input_usd_per_million_tokens',
  'output_usd_per_million_tokens',
  'cache_read_usd_per_million_tokens',
  'cache_write_usd_per_million_tokens',
] as const
const allowedFields = new Set<string>(['currency', ...rateFields])

function invalid(field: string): never {
  throw new Error(`model_config_price_invalid:${field}`)
}

export function parseModelConfigPrice(value: unknown): ModelConfigPrice {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('price')
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) if (!allowedFields.has(key)) invalid(key)
  if ('currency' in record && record.currency !== 'USD') invalid('currency')
  for (const field of rateFields) {
    if (field.startsWith('cache_') && !(field in record)) continue
    const rate = record[field]
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1e308) invalid(field)
  }
  return {
    ...(record.currency === 'USD' ? { currency: 'USD' } : {}),
    input_usd_per_million_tokens: record.input_usd_per_million_tokens as number,
    output_usd_per_million_tokens: record.output_usd_per_million_tokens as number,
    ...('cache_read_usd_per_million_tokens' in record ? { cache_read_usd_per_million_tokens: record.cache_read_usd_per_million_tokens as number } : {}),
    ...('cache_write_usd_per_million_tokens' in record ? { cache_write_usd_per_million_tokens: record.cache_write_usd_per_million_tokens as number } : {}),
  }
}

export function ratesFromModelConfigPrice(price: ModelConfigPrice): ModelConfigTokenRates {
  return {
    inputUsdPerToken: price.input_usd_per_million_tokens / 1_000_000,
    outputUsdPerToken: price.output_usd_per_million_tokens / 1_000_000,
    ...(price.cache_read_usd_per_million_tokens === undefined ? {} : { cachedInputUsdPerToken: price.cache_read_usd_per_million_tokens / 1_000_000 }),
    ...(price.cache_write_usd_per_million_tokens === undefined ? {} : { cacheWriteUsdPerToken: price.cache_write_usd_per_million_tokens / 1_000_000 }),
  }
}
