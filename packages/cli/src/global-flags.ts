const LOCALHOST_BASE_URL = 'http://localhost:3000'

export interface GlobalFlags {
  local: boolean
  server: string | null
}

export interface ParsedGlobalFlags {
  flags: GlobalFlags
  args: string[]
}

export function normalizeBaseUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid server URL: '${url}'`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Server URL must use http or https.')
  }

  if (parsed.username || parsed.password) {
    throw new Error('Server URL must not contain credentials.')
  }

  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Server URL must be an origin only (no path, query, or hash).')
  }

  return parsed.origin
}

// Only exact production origins are aliases. Custom servers keep their identity.
export function canonicalServerUrl(url: string): string {
  const origin = normalizeBaseUrl(url)
  return origin === 'https://orizu.ai' || origin === 'https://www.orizu.ai'
    ? 'https://app.orizu.ai'
    : origin
}

export function parseGlobalFlags(argv: string[]): ParsedGlobalFlags {
  const args: string[] = []
  const flags: GlobalFlags = {
    local: false,
    server: null,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--local') {
      flags.local = true
      continue
    }

    if (value === '--server') {
      const next = argv[index + 1]
      if (!next || next.startsWith('--')) {
        throw new Error('Usage: --server <url>')
      }

      flags.server = normalizeBaseUrl(next)
      index += 1
      continue
    }

    args.push(value)
  }

  if (flags.local && flags.server) {
    throw new Error('Use either --local or --server <url>, not both.')
  }

  return { flags, args }
}

export function getFlagBaseUrl(flags: GlobalFlags): string | null {
  if (flags.local) {
    return LOCALHOST_BASE_URL
  }

  if (flags.server) {
    return flags.server
  }

  return null
}
