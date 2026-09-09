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
