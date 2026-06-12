/**
 * CSV parsing utilities with RFC 4180 compliance.
 *
 * This is the single canonical implementation shared by the web app and the
 * published CLI: lib/csv-utils.ts re-exports from here. It lives inside
 * packages/cli because the CLI is published standalone to npm and cannot
 * import files outside its package root, while the app can import anything.
 */

/**
 * Parses CSV text into a 2D array of strings, handling quoted fields, escaped
 * quotes, multiline fields, and different line endings (CRLF, LF, CR).
 * Completely empty rows are skipped.
 *
 * @example
 * ```typescript
 * const csv = 'name,age,city\nJohn,25,"New York"'
 * parseCSV(csv) // [['name', 'age', 'city'], ['John', '25', 'New York']]
 * ```
 */
export function parseCSV(csvText: string): string[][] {
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
          // Only keep rows with at least one non-whitespace field
          if (currentRow.some(field => field.trim())) {
            result.push(currentRow)
          }
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
    if (currentRow.some(field => field.trim())) {
      result.push(currentRow)
    }
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
export function parseCSVToObjects(csvText: string): Record<string, string>[] {
  const rows = parseCSV(csvText)

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
