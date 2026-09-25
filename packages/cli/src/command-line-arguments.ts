// ORI-2044: moved from index.ts to keep command line arguments together.

let cliArgs = process.argv.slice(2)
let cliJsonOutput = false

function getArg(name: string): string | null {
  const index = cliArgs.indexOf(name)
  if (index === -1 || index + 1 >= cliArgs.length) {
    return null
  }

  return cliArgs[index + 1]
}

function getArchiveListStatus(command: string): string {
  const status = getArg('--status') || 'active'
  if (!['active', 'archived', 'all'].includes(status)) {
    throw new Error(
      `Usage: orizu ${command} list [--project <team/project>] ` +
      '[--status active|archived|all]'
    )
  }
  return status
}

function getArgs(name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < cliArgs.length; index += 1) {
    if (cliArgs[index] !== name) {
      continue
    }

    const value = cliArgs[index + 1]
    if (!value || value.startsWith('-')) {
      throw new Error(`Usage: ${name} <value>`)
    }

    values.push(value)
    index += 1
  }

  return values
}

function getOptionalArgValue(name: string): string | null {
  const index = cliArgs.indexOf(name)
  if (index === -1 || index + 1 >= cliArgs.length) {
    return null
  }

  const value = cliArgs[index + 1]
  if (!value || value.startsWith('-')) {
    return null
  }

  return value
}

function rejectDashPrefixedOptionValue(name: string, value: string | null) {
  if (value && value.startsWith('-')) {
    throw new Error(`Invalid value for ${name}: option values cannot start with a dash`)
  }
}

export function normalizeSlugInput(slug: string): string {
  return slug.trim().toLowerCase()
}

function isInteractiveTerminal() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

function hasArg(name: string): boolean {
  return cliArgs.includes(name)
}

export function expandHomePath(path: string): string {
  if (path.startsWith('~/')) {
    const home = process.env.HOME || ''
    return `${home}/${path.slice(2)}`
  }

  return path
}

function getPositionalArg(index: number): string | null {
  const value = cliArgs[index]
  return value && !value.startsWith('--') ? value : null
}

function hasJsonFlag(): boolean {
  return cliJsonOutput || hasArg('--json')
}

export {
  cliArgs,
  getArg,
  hasJsonFlag,
  getArchiveListStatus,
  getPositionalArg,
  hasArg,
  isInteractiveTerminal,
  getArgs,
  getOptionalArgValue,
  rejectDashPrefixedOptionValue,
}

export function setCommandLineArguments(args: string[], jsonOutput: boolean): void {
  cliArgs = args
  cliJsonOutput = jsonOutput
}
