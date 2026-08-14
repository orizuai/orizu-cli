export const CLI_LENGTH_STATS_FIELDS = [
  'tokens',
  'lines',
  'chars',
  'words',
] as const

export const CLI_LENGTH_DELTA_SPLIT_UNAVAILABLE_REASONS = [
  'diff_degraded_size_limit',
  'diff_degraded_cell_limit',
] as const
export const CLI_LENGTH_MEASUREMENT_UNAVAILABLE_REASONS = [
  'length_measurement_size_limit',
  'length_measurement_failed',
  'body_resolution_failed',
  'measurement_cap_exceeded',
  'enrichment_failed',
  'bodies_unavailable_event_cap',
] as const

export type CliLengthStatsField = typeof CLI_LENGTH_STATS_FIELDS[number]
export type CliLengthDeltaSplitUnavailableReason =
  typeof CLI_LENGTH_DELTA_SPLIT_UNAVAILABLE_REASONS[number]
export type CliLengthMeasurementUnavailableReason =
  typeof CLI_LENGTH_MEASUREMENT_UNAVAILABLE_REASONS[number]

export interface CliLengthStats {
  tokens: number
  lines: number
  chars: number
  words: number
}

export interface CliLengthStatsPair {
  from: CliLengthStats | null
  to: CliLengthStats | null
  fromUnavailableReason?: CliLengthMeasurementUnavailableReason
  toUnavailableReason?: CliLengthMeasurementUnavailableReason
}

export interface CliLengthMetricDelta {
  removed: number | null
  added: number | null
  net: number
}

export interface CliLengthDelta extends Record<
  CliLengthStatsField,
  CliLengthMetricDelta
> {
  splitUnavailableReason: CliLengthDeltaSplitUnavailableReason | null
}

export function formatFiniteLengthCount(
  value: unknown,
  signed = false
): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null

  const formatted = Math.abs(value).toLocaleString('en-US')
  if (!signed) return formatted
  if (value > 0) return `+${formatted}`
  if (value < 0) return `-${formatted}`
  return formatted
}
