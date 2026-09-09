export function datasetTransferTimeoutMs(): number {
  const configured = process.env.ORIZU_DATASET_TRANSFER_TIMEOUT_MS
  const timeoutMs = configured === undefined ? 120_000 : Number(configured)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error('DATASET_TRANSFER_CONFIG: ORIZU_DATASET_TRANSFER_TIMEOUT_MS must be an integer from 1 to 300000')
  }
  return timeoutMs
}
