import { sanitizeTerminalText } from './json-response.js'
import { errorOutputSecrets } from './last-error-record.js'
import { redactSecrets } from './secret-redaction.js'

// ORI-2744: under --json, every line a command prints on stdout hides the
// secrets this process holds, the same ones the error line on stderr hides
// (#2387). A line holding none of them is printed exactly as it was.

// sanitizeTerminalText drops raw C0, DEL and C1 (as stderr does) but keeps
// tab, newline and CR, so those are dropped here, along with every control
// character as JSON writes it inside a string, behind one backslash or several
// (a JSON reply quoted inside another JSON string).
const CONTROLS = /[\t\n\r]|\\+u00[01][0-9a-fA-F]|\\+u007[fF]|\\+u00[89][0-9a-fA-F]|\\+[bfnrt]/g

// The one control-character pass used to look for a secret and to hide it, so
// a secret split by any control character is found and hidden field by field,
// and the raw-line fallback stays a last resort.
const withoutControls = (text: string) => sanitizeTerminalText(text).replace(CONTROLS, '')

const holdsAny = (text: string, forms: readonly string[]) => {
  const stripped = withoutControls(text)
  return forms.some(form => text.includes(form) || stripped.includes(form))
}

// A secret as sent, as JSON writes it inside a string, and as JSON writes that
// again when one JSON text is quoted inside another (a server's error body
// carried in an `error` string).
function writtenForms(secret: string): string[] {
  const once = JSON.stringify(secret).slice(1, -1)
  return [...new Set([secret, once, JSON.stringify(once).slice(1, -1)])]
}

// The stderr rule: hide the secrets, drop control characters, hide them again.
// Only a string that holds a secret changes, and control characters are
// dropped only when one splits a secret, so other text keeps them.
function hideInText(text: string, forms: readonly string[]): string {
  if (!holdsAny(text, forms)) return text
  const hidden = redactSecrets(text, { secrets: forms })
  return holdsAny(hidden, forms) ? redactSecrets(withoutControls(hidden), { secrets: forms }) : hidden
}

function hideInValue(value: unknown, forms: readonly string[]): unknown {
  if (typeof value === 'string') return hideInText(value, forms)
  if (Array.isArray(value)) return value.map(item => hideInValue(item, forms))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [hideInText(key, forms), hideInValue(item, forms)]))
  }
  return value
}

// The last resort: hide every form in the raw line with its control
// characters dropped. It may no longer be valid JSON, but it holds no secret.
const hideInRawLine = (line: string, forms: readonly string[]) => redactSecrets(withoutControls(line), { secrets: forms })

/** One printed --json line with the secrets this process holds hidden. */
export function hideHeldSecrets(line: string): string {
  const secrets = errorOutputSecrets()
  if (secrets.length === 0) return line
  const forms = secrets.flatMap(writtenForms).sort((left, right) => right.length - left.length)
  if (!holdsAny(line, forms)) return line
  let rewritten: string
  try {
    const parsed: unknown = JSON.parse(line)
    // Keep a pretty-printed object's indent; anything else stays compact.
    const indent = /^[[{]\n( +)/.exec(line)?.[1].length
    rewritten = JSON.stringify(hideInValue(parsed, forms), null, indent)
  } catch {
    rewritten = hideInText(line, forms)
  }
  // Fail closed: a secret the rewrite missed (a number, a shape not handled
  // above) is hidden from the raw line instead.
  return holdsAny(rewritten, forms) ? hideInRawLine(line, forms) : rewritten
}
