export const RESERVED_ROUTING_SLUGS: readonly string[] = [
  'account', 'teams', 'task', 'preview', 'api', 'auth', 'login', 'logout', 'signup', 'signin',
  'settings', 'new', 'admin', 'docs', 'learn', 'd', 'agents', 'subprocessors', 'llms.txt',
  '_next', 'robots.txt', 'sitemap.xml', 'favicon.ico',
]

export function isReservedRoutingSlug(slug: string): boolean {
  return RESERVED_ROUTING_SLUGS.includes(normalizeSlugInput(slug))
}

export function isReservedRoutingName(name: string): boolean {
  const stem = normalizeSlugInput(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return isReservedRoutingSlug(name) || isReservedRoutingSlug(stem)
}

export interface ParsedProjectSlug {
  teamSlug: string
  projectSlug: string
}

export interface SplitProjectArg {
  /** null when the caller passed a bare project slug. */
  teamSlug: string | null
  projectSlug: string
}

export function normalizeSlugInput(slug: string): string {
  return slug.trim().toLowerCase()
}

/**
 * Accept a `--project` value in either documented form: `teamSlug/projectSlug`
 * or a bare `projectSlug` (resolved within the caller's team).
 */
export function splitCliProjectArg(value: string): SplitProjectArg | null {
  if (!value.includes('/')) {
    const projectSlug = normalizeSlugInput(value)
    return projectSlug ? { teamSlug: null, projectSlug } : null
  }

  const parsed = parseCliProjectSlug(value)
  return parsed ? { teamSlug: parsed.teamSlug, projectSlug: parsed.projectSlug } : null
}

export function parseCliProjectSlug(projectSlug: string): ParsedProjectSlug | null {
  const segments = projectSlug.split('/')
  if (segments.length !== 2) return null

  const [teamSlug, project] = segments.map(normalizeSlugInput)
  if (!teamSlug || !project) return null

  return { teamSlug, projectSlug: project }
}
