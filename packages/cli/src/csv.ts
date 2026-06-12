/**
 * CSV parsing utilities with RFC 4180 compliance.
 *
 * This is the single canonical implementation shared by the web app and the
 * published CLI: lib/csv-utils.ts re-exports from here. It lives inside
 * packages/cli because the CLI is published standalone to npm and cannot
 * import files outside its package root, while the app can import anything.
 *
 * Resource limits are enforced while parsing so a hostile CSV cannot exhaust
 * memory. The numeric defaults are inlined here (this package cannot import
 * @/lib/resource-limits) and mirror RESOURCE_LIMITS.CSV_* in that module —
 * keep the two in sync.
 */

export class CSVResourceLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CSVResourceLimitError'
  }
}

export interface CSVParseOptions {
  maxBytes?: number
  maxRows?: number
  maxFields?: number
  maxFieldBytes?: number
}

// Mirrors RESOURCE_LIMITS.CSV_* in lib/resource-limits.ts.
const DEFAULT_CSV_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_CSV_MAX_ROWS = 5_000
const DEFAULT_CSV_MAX_FIELDS = 200
const DEFAULT_CSV_MAX_FIELD_BYTES = 128 * 1024

function getUtf8ByteLength(value: string): number {
  let bytes = 0

  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index)

    if (codePoint <= 0x7f) {
      bytes += 1
    } else if (codePoint <= 0x7ff) {
      bytes += 2
    } else if (
      codePoint >= 0xd800 &&
      codePoint <= 0xdbff &&
      index + 1 < value.length
    ) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }

  return bytes
}

function enforceCsvTextLimit(csvText: string, options: CSVParseOptions): void {
  const maxBytes = options.maxBytes ?? DEFAULT_CSV_MAX_BYTES
  if (getUtf8ByteLength(csvText) > maxBytes) {
    throw new CSVResourceLimitError(`CSV data is too large (max ${maxBytes} bytes)`)
  }
}

function enforceRowLimit(rowCount: number, options: CSVParseOptions): void {
  const maxRows = options.maxRows ?? DEFAULT_CSV_MAX_ROWS
  if (rowCount > maxRows) {
    throw new CSVResourceLimitError(`CSV has too many rows (max ${maxRows})`)
  }
}

function enforceFieldLimits(row: string[], options: CSVParseOptions): void {
  const maxFields = options.maxFields ?? DEFAULT_CSV_MAX_FIELDS
  if (row.length > maxFields) {
    throw new CSVResourceLimitError(`CSV row has too many fields (max ${maxFields})`)
  }

  const maxFieldBytes = options.maxFieldBytes ?? DEFAULT_CSV_MAX_FIELD_BYTES
  for (const field of row) {
    if (getUtf8ByteLength(field) > maxFieldBytes) {
      throw new CSVResourceLimitError(`CSV field is too large (max ${maxFieldBytes} bytes)`)
    }
  }
}

function addCsvRow(result: string[][], row: string[], options: CSVParseOptions): void {
  // Only keep rows with at least one non-whitespace field
  if (!row.some(field => field.trim())) {
    return
  }

  enforceFieldLimits(row, options)
  result.push(row)
  enforceRowLimit(result.length, options)
}

/**
 * Parses CSV text into a 2D array of strings, handling quoted fields, escaped
 * quotes, multiline fields, and different line endings (CRLF, LF, CR).
 * Completely empty rows are skipped.
 *
 * Resource limits (size, rows, fields, field size) are enforced during
 * parsing; pass `options` to override the defaults. A violation throws
 * {@link CSVResourceLimitError}.
 *
 * @example
 * ```typescript
 * const csv = 'name,age,city\nJohn,25,"New York"'
 * parseCSV(csv) // [['name', 'age', 'city'], ['John', '25', 'New York']]
 * ```
 */
export function parseCSV(csvText: string, options: CSVParseOptions = {}): string[][] {
  enforceCsvTextLimit(csvText, options)

  const result: string[][] = []
  let currentRow: string[] = []
  let currentField = ''
  let inQuotes = false
  let i = 0

  while (i < csvText.length) {
    const char = csvText[i]
    const nextChar = csvText[i + 1]

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote - convert "" to "
        currentField += '"'
        i += 2
        continue
      }

      inQuotes = !inQuotes
      i++
      continue
    }

    if (!inQuotes) {
      if (char === ',') {
        currentRow.push(currentField)
        currentField = ''
        i++
        continue
      }

      if (char === '\n' || char === '\r') {
        if (currentField || currentRow.length > 0) {
          currentRow.push(currentField)
          addCsvRow(result, currentRow, options)
          currentRow = []
          currentField = ''
        }

        if (char === '\r' && nextChar === '\n') {
          i += 2
        } else {
          i++
        }

        continue
      }
    }

    currentField += char
    i++
  }

  // CSV might not end with a newline
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField)
    addCsvRow(result, currentRow, options)
  }

  return result
}

/**
 * Parses CSV data into an array of objects using the first row as headers.
 *
 * @example
 * ```typescript
 * const csv = 'name,age\nJohn,25'
 * parseCSVToObjects(csv) // [{ name: 'John', age: '25' }]
 * ```
 */
export function parseCSVToObjects(
  csvText: string,
  options: CSVParseOptions = {}
): Record<string, string>[] {
  const rows = parseCSV(csvText, options)

  if (rows.length < 2) {
    return []
  }

  const headers = rows[0].map(header => header.trim())
  const dataRows = rows.slice(1)

  return dataRows.map(row => {
    const obj: Record<string, string> = {}
    headers.forEach((header, index) => {
      obj[header] = row[index]?.trim() || ''
    })
    return obj
  })
}
