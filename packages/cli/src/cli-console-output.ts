// ORI-2044: moved from index.ts to keep cli console output together.
import { readFileSync } from 'fs'
import { stdout as output } from 'process'

import { renderBanner } from './banner.js'
import { renderRootHelp } from './help.js'
import { sanitizeTerminalText } from './json-response.js'
import { hasJsonFlag } from './command-line-arguments.js'
import { reportReplacementWarning } from './report-replacement-warning.js'

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getCliVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { version?: unknown }

  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('Unable to read orizu CLI version.')
  }

  return packageJson.version
}

function printLine(message = '') {
  output.write(`${message}\n`)
}

function printVersion() {
  printLine(`orizu ${getCliVersion()}`)
}

function printBannerIfInteractive() {
  if (!process.stdout.isTTY) {
    return
  }
  printLine(renderBanner())
  printLine('')
}

function printUsage() {
  printBannerIfInteractive()
  printLine(renderRootHelp())
}

function printError(message: string): void {
  console.error(sanitizeTerminalText(message))
}

function printLoginProgress(message: string): void {
  if (hasJsonFlag()) {
    printError(message)
    return
  }
  printLine(message)
}

function printPushDisclosures(data: Record<string, unknown>): void {
  const warning = reportReplacementWarning(data)
  if (warning) printError(warning)
  if (data.metadata_updated === true) {
    printError('Updated prompt metadata on the identical existing version')
  }
}

function printJson(value: Record<string, unknown>) {
  printLine(JSON.stringify(value))
}

export {
  getErrorMessage,
  printJson,
  printLine,
  printPushDisclosures,
  getCliVersion,
  printBannerIfInteractive,
  printVersion,
  printUsage,
  printError,
  printLoginProgress,
}
