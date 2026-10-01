/**
 * The check the session coordinator makes on `/opt/orizu/prebaked.json`, the
 * first bootstrap command of a hosted optimization run. It lives here so the
 * release bake's start check (hosted-runtime-image/check-snapshot-starts.mjs)
 * rejects a snapshot on exactly the rules the coordinator would refuse it on.
 * Worker code imports this module, so it must not use Node APIs.
 */
export function isHostedOptimizationPrebakedMarker(raw: string): boolean {
  try {
    const marker: unknown = JSON.parse(raw)
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false
    const value = marker as Record<string, unknown>
    return value.builtFor === 'vercel-sandbox' &&
      typeof value.cliVersion === 'string' && value.cliVersion.length > 0 &&
      typeof value.opencodeVersion === 'string' && value.opencodeVersion.length > 0 &&
      typeof value.claudeSdkVersion === 'string' && value.claudeSdkVersion.length > 0
  } catch {
    return false
  }
}
