/**
 * ALI-1452: a shared, human-readable warning for a replaced prompt-version
 * report on a push/draft response.
 *
 * Re-pushing an unchanged prompt with a report deliberately replaces the
 * version's existing report (reports are correctable; versions are immutable).
 * The server discloses that replacement as `report_replaced:
 * { source_name, updated_at } | null`; this turns a non-null disclosure into
 * the stderr warning line the push commands print. JSON mode prints nothing —
 * the payload already carries `report_replaced`.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A one-line warning when a push response discloses that it replaced an
 * existing report, or null when nothing was replaced (or no report was sent).
 */
export function reportReplacementWarning(data: Record<string, unknown>): string | null {
  const replaced = data.report_replaced
  if (!isRecord(replaced)) return null

  const sourceName = typeof replaced.source_name === 'string'
    ? replaced.source_name
    : 'unknown source'
  const updatedAt = typeof replaced.updated_at === 'string'
    ? replaced.updated_at
    : 'unknown time'
  return (
    'Warning: replaced the existing report for this version ' +
    `(${sourceName}, last updated ${updatedAt})`
  )
}
