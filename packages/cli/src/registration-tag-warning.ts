/**
 * ADR-009 amendment / ALI-1157 (Codex P2 finding 5): a shared, human-readable
 * warning for a registration-tag failure on a draft push.
 *
 * "Registration is publication": every draft writer plants a permanent
 * `orizu/registered/<kind>/<versionId>` tag at the row's pinned commit. That
 * tag is BEST-EFFORT — the row + commit pin are already durable, so a tag that
 * fails to plant never fails the push (exit stays 0). But the failure used to
 * be visible only under `--json`; normal output printed unconditional success.
 * This surfaces it as a one-line warning the push commands append to their
 * success message.
 *
 * Codex round-2 finding 4: the warning must NOT promise automatic retry — no
 * reconciler exists yet (it is a tracked follow-up). It states the version is
 * registered and the tag can be re-planted on the next registration or by hand.
 *
 * A tag "failed to plant" when `registration_tag.planted === false` (the tag
 * already exists at a DIFFERENT commit — never moved — or the transport/pin
 * lookup failed). `planted === true` (freshly created OR idempotent replay)
 * and a missing field (older server / no tag attempted) produce no warning.
 */

interface RegistrationTagOutcomeShape {
  tag?: unknown
  planted?: unknown
  error?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A one-line warning for a failed registration tag on a draft-push response
 * body, or null when the tag planted (or none was attempted).
 */
export function registrationTagWarning(data: Record<string, unknown>): string | null {
  const raw = data.registration_tag
  if (!isRecord(raw)) return null
  const tagOutcome = raw as RegistrationTagOutcomeShape
  if (tagOutcome.planted !== false) return null
  const tag = typeof tagOutcome.tag === 'string' ? tagOutcome.tag : 'registration tag'
  const reason = typeof tagOutcome.error === 'string' && tagOutcome.error.length > 0 ? tagOutcome.error : 'tag not planted'
  return (
    `Warning: registration tag ${tag} was not planted (${reason}). ` +
    `The version IS registered (the commit pin is durable); re-plant the tag on the next registration or manually ` +
    `(automatic reconciliation is a tracked follow-up).`
  )
}

/**
 * Append the registration-tag warning (if any) to a push success message,
 * keeping it a single trailing line. Exit stays 0 — registration succeeded.
 */
export function appendRegistrationTagWarning(message: string, data: Record<string, unknown>): string {
  const warning = registrationTagWarning(data)
  return warning ? `${message}\n${warning}` : message
}
