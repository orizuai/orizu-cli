// JavaScript's \s is broader than the database locale's POSIX [:space:]
// predicate. These four code points are content in the measured PostgreSQL
// boundary, so retain them explicitly when validating CLI report input.
export function hasCanonicalReportMarkdownContent(markdown: string): boolean {
  return /(?:[^\s]|[\u00a0\u2007\u202f\ufeff])/u.test(markdown)
}
