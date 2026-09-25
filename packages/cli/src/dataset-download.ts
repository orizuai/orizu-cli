export interface ParsedDatasetReference {
  datasetId: string
  project?: string
}

// Keep accepting copied legacy /d/ links while new dashboard URLs omit it.
const DATASET_URL_PATH = /^\/(?:d\/)?([^/]+)\/([^/]+)\/datasets\/([^/?#]+)\/?$/

export function parseDatasetReference(input: string): ParsedDatasetReference {
  const value = input.trim()
  if (!value) {
    throw new Error('Dataset value cannot be empty')
  }

  try {
    const url = new URL(value)
    const match = DATASET_URL_PATH.exec(url.pathname)
    if (match) {
      return {
        project: `${match[1]}/${match[2]}`,
        datasetId: decodeURIComponent(match[3]),
      }
    }

    throw new Error(
      'Dataset URL must be in format https://<host>/<teamSlug>/<projectSlug>/datasets/<datasetId>'
    )
  } catch {
    if (value.startsWith('http://') || value.startsWith('https://')) {
      throw new Error(
        'Dataset URL must be in format https://<host>/<teamSlug>/<projectSlug>/datasets/<datasetId>'
      )
    }
  }

  return { datasetId: value }
}
