// ADR-036: the one definition of an empty report, shared by the CLI, the web
// app's readers and upload route, and the timeline's Data API filter. The
// database writer and comment trigger use private.report_markdown_has_content,
// whose pattern is REPORT_MARKDOWN_CONTENT_PATTERN verbatim (a database test
// pins that). Before ADR-036 these sites copied PostgreSQL 15's locale answer
// while production ran 17, so the CLI accepted reports the writer rejected.

interface BlankCodePointRange {
  readonly first: number
  readonly last: number
}

/**
 * The characters a report may consist of and still be empty: Unicode's
 * White_Space property plus the four C0 information separators. Everything
 * else, including invisible format characters such as U+FEFF, is content.
 */
const REPORT_BLANK_CODE_POINTS: readonly BlankCodePointRange[] = [
  // Tab, line feed, vertical tab, form feed, carriage return.
  { first: 0x0009, last: 0x000d },
  // File, group, record and unit separators: not Unicode whitespace, but
  // invisible, and blank in production since it has run PostgreSQL 17.
  { first: 0x001c, last: 0x001f },
  // Space.
  { first: 0x0020, last: 0x0020 },
  // Next line.
  { first: 0x0085, last: 0x0085 },
  // No-break space.
  { first: 0x00a0, last: 0x00a0 },
  // Ogham space mark.
  { first: 0x1680, last: 0x1680 },
  // En quad through hair space, including figure space U+2007.
  { first: 0x2000, last: 0x200a },
  // Line separator and paragraph separator.
  { first: 0x2028, last: 0x2029 },
  // Narrow no-break space.
  { first: 0x202f, last: 0x202f },
  // Medium mathematical space.
  { first: 0x205f, last: 0x205f },
  // Ideographic space.
  { first: 0x3000, last: 0x3000 },
]

function escapeCodePoint(codePoint: number): string {
  return `\\u${codePoint.toString(16).padStart(4, '0')}`
}

/**
 * Matches any content character. `\uXXXX` names each code point, so
 * JavaScript (with the `u` flag) and PostgreSQL's `~` read it identically and
 * no locale is involved.
 */
export const REPORT_MARKDOWN_CONTENT_PATTERN = `[^${REPORT_BLANK_CODE_POINTS.map(({ first, last }) =>
  first === last ? escapeCodePoint(first) : `${escapeCodePoint(first)}-${escapeCodePoint(last)}`
).join('')}]`

const REPORT_MARKDOWN_CONTENT = new RegExp(REPORT_MARKDOWN_CONTENT_PATTERN, 'u')

export function hasCanonicalReportMarkdownContent(markdown: string): boolean {
  return REPORT_MARKDOWN_CONTENT.test(markdown)
}
