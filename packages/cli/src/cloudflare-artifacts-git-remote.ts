export const CLOUDFLARE_ARTIFACTS_HOST_PATTERN =
  /^[0-9a-f]{32}\.artifacts\.cloudflare\.net$/u

export const CLOUDFLARE_ARTIFACTS_GIT_PATH_PATTERN =
  /^\/git\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.git$/u

export function parseCanonicalCredentialFreeHttpsUrl(remote: unknown): URL | null {
  if (typeof remote !== 'string') return null
  try {
    const parsed = new URL(remote)
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password &&
      !parsed.port && !parsed.search && !parsed.hash && parsed.toString() === remote
      ? parsed
      : null
  } catch {
    return null
  }
}

export function isValidCloudflareArtifactsGitRemote(remote: unknown): remote is string {
  const parsed = parseCanonicalCredentialFreeHttpsUrl(remote)
  return parsed !== null && CLOUDFLARE_ARTIFACTS_HOST_PATTERN.test(parsed.hostname) &&
    CLOUDFLARE_ARTIFACTS_GIT_PATH_PATTERN.test(parsed.pathname)
}
