interface UploadedDatasetIdentity {
  id: string
  name: string
  rowCount: number
}

interface DatasetVersionSnapshot {
  datasetVersion: {
    id: string
  }
}

export async function ensureDatasetUploadSnapshot<T extends DatasetVersionSnapshot>(
  dataset: UploadedDatasetIdentity,
  jsonOutput: boolean,
  createSnapshot: (datasetId: string) => Promise<T>
): Promise<T> {
  try {
    return await createSnapshot(dataset.id)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const retryCommand = `orizu datasets versions create --dataset ${dataset.id}`

    if (jsonOutput) {
      throw new Error(JSON.stringify({
        error: 'Dataset upload completed but dataset version creation failed',
        detail,
        upload_completed: true,
        dataset_id: dataset.id,
        dataset_version_id: null,
        retry_command: retryCommand,
      }))
    }

    throw new Error(
      `Dataset upload completed but dataset version creation failed: ${detail}\n` +
      `Dataset ${dataset.name} (${dataset.id}) was created with ${dataset.rowCount} rows. ` +
      `Retry only the snapshot step with: ${retryCommand}`
    )
  }
}
