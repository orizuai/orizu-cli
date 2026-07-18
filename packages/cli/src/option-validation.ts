function optionName(arg: string): string {
  const equalsIndex = arg.indexOf('=')
  return equalsIndex === -1 ? arg : arg.slice(0, equalsIndex)
}

function isNegativeNumericValue(arg: string): boolean {
  return arg.length > 1 && !arg.startsWith('--') && Number.isFinite(Number(arg))
}

function isUnambiguouslySingleDashValue(arg: string): boolean {
  // A short option cannot contain whitespace immediately after its dash. This
  // keeps Markdown-list prompts such as `--task "- fix the test"` available
  // without letting a misspelled option such as `--task -taks` get swallowed.
  return /^-\s/.test(arg) || isNegativeNumericValue(arg)
}

function followsValueOption(
  args: readonly string[],
  index: number,
  valueOptions: ReadonlySet<string>
): boolean {
  if (index === 0) return false
  const previous = args[index - 1]
  return previous.startsWith('--') && !previous.includes('=') && valueOptions.has(previous)
}

/**
 * Return the first dash-prefixed option that is not in a command's explicit
 * allowlist. An unambiguously value-like single-dash token immediately
 * following a value-taking option is data: this keeps inputs such as
 * `--duration -5` and `--task "- fix the test"` available without allowing a
 * stray token or mistyped short option.
 *
 * `valueOptions` permits the unambiguous `--option=value` form. A separate
 * token beginning with `--`, or an option-like single-dash word, is parsed as
 * an option so a missing value cannot swallow a typo. Callers whose value is
 * itself option-like can use the inline form; Markdown list markers and finite
 * negative numbers remain safe as separate values.
 */
export function findUnknownOption(
  args: readonly string[],
  allowedOptions: ReadonlySet<string>,
  valueOptions: ReadonlySet<string> = new Set()
): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('-') || arg === '-') continue
    if (!arg.startsWith('--')) {
      if (isUnambiguouslySingleDashValue(arg) && followsValueOption(args, index, valueOptions)) continue
      return arg
    }

    const name = optionName(arg)
    if (!allowedOptions.has(name)) return name

    const hasInlineValue = arg.length > name.length
    if (hasInlineValue) {
      if (!valueOptions.has(name)) return arg
      continue
    }
  }
  return null
}
