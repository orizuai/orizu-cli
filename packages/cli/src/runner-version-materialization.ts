import { spawnSync } from 'node:child_process'
import { sanitizeTerminalText } from './json-response.js'
export function unzipRunnerArchive(zipPath: string, runnerDir: string): void {
  const listing = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
  if (listing.error) throw listing.error
  if (listing.status !== 0) throw new Error(`unzip listing failed: ${sanitizeTerminalText(listing.stderr || listing.stdout || '')}`)
  const unsafe = listing.stdout.split(/\r?\n/u).filter(Boolean).find(name => {
    const normalized = name.replaceAll('\\', '/')
    return normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)
      || normalized.split('/').some(part => part === '..')
  })
  if (unsafe) throw new Error('Runner archive contains an unsafe path')
  const result = spawnSync('unzip', ['-q', zipPath, '-d', runnerDir], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`unzip failed: ${sanitizeTerminalText(result.stderr || result.stdout || '')}`)
}
export async function materializeRunnerVersion(runnerVersionId: string, verifyRegisteredDigest = true): Promise<{
  runnerDir: string; cleanup: () => void
}> {
  // ORI-2429: the download runs on Effect (runner-folders.ts); this adapter
  // keeps the { runnerDir, cleanup } shape for the existing Promise callers.
  const { downloadedRunner, openScope, RemovalLedger } = await import('./runner-folders.js')
  const { Effect, Scope } = await import('effect')
  const ledger = new RemovalLedger()
  const { scope, close } = openScope()
  try {
    const { runnerDir } = await Effect.runPromise(
      downloadedRunner(runnerVersionId, ledger, verifyRegisteredDigest).pipe(Effect.provideService(Scope.Scope, scope))
    )
    return {
      runnerDir,
      cleanup: () => {
        close()
        const [failure] = ledger.errors()
        if (failure !== undefined) throw failure
      },
    }
  } catch (error) {
    // downloadedRunner already removed this runner's folder on its own failure.
    close()
    throw error
  }
}
