import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Cause, Context, Effect, Exit, Layer } from 'effect'

import { runWithStops, type Interrupted } from './cli-stops.js'
import {
  buildEntrySource,
  buildPreviewCss,
  buildPreviewHtml,
  buildRuntimeGlobalsSource,
  createPreviewSnapshotPlugin,
  findCliPackageRoot,
  findMissingPreviewRuntimeDeps,
  findNodeModuleDirs,
  findPreviewRepoRoot,
  validatePreviewInputs,
  type AppPreviewOptions,
  type AppPreviewResult,
  type PreviewBrowser,
  type PreviewPage,
  type PreviewPlaywright,
} from './preview-runtime.js'

// Loaded only through `await import(...)` from `orizu apps preview` and
// runLocalAppPreview, so CLI startup never loads Effect.

/** Where Chromium comes from: Playwright and the browser to launch. Tests swap it with Layer.succeed. */
class PreviewBrowsers extends Context.Service<PreviewBrowsers, {
  readonly playwright: Effect.Effect<PreviewPlaywright, unknown>
  readonly executablePath: string | null
}>()('PreviewBrowsers') {}

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: cause => cause })

/** The preview's own folder: entry, HTML, CSS and the bundle. Removed on every ending. */
const previewFolder = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), 'orizu-app-preview-'))),
  folder => Effect.sync(() => rmSync(folder, { recursive: true, force: true })),
)

function bundlePreview(options: AppPreviewOptions, folder: string) {
  return Effect.gen(function*() {
    const appPath = realpathSync(options.filePath)
    const repoRoot = options.forceSnapshot ? null : findPreviewRepoRoot(options.cwd || process.cwd(), appPath)
    const cliPackageRoot = findCliPackageRoot()
    const entryPath = join(folder, 'entry.tsx')
    const globalsPath = join(folder, 'runtime-globals.ts')
    writeFileSync(entryPath, buildEntrySource(appPath, options.sampleRow), 'utf8')
    writeFileSync(join(folder, 'index.html'), buildPreviewHtml(), 'utf8')
    writeFileSync(globalsPath, buildRuntimeGlobalsSource(), 'utf8')

    const esbuild = yield* Effect.promise(() => import('esbuild').catch(() => null))
    if (!esbuild) {
      return yield* Effect.fail(new Error(
        'Local preview requires esbuild. Install project dependencies with `bun install` or run from an Orizu checkout.'
      ))
    }
    const nodePaths = [
      ...(repoRoot ? [join(repoRoot, 'node_modules')] : []),
      ...(cliPackageRoot ? findNodeModuleDirs(cliPackageRoot) : []),
    ]
    const missingRuntimeDeps = findMissingPreviewRuntimeDeps(nodePaths)
    if (missingRuntimeDeps.length > 0) {
      return yield* Effect.fail(new Error(
        `Local preview requires ${missingRuntimeDeps.join(' and ')} to be installed nearby ` +
          '(run inside a project that has them, `npm install react react-dom` next to your app, ' +
          'or run from an Orizu checkout after `bun install`).'
      ))
    }
    // After the dependency checks, so their actionable errors come before a Tailwind warning.
    const css = yield* attempt(() => buildPreviewCss(repoRoot, appPath))
    writeFileSync(join(folder, 'preview.css'), css, 'utf8')
    yield* attempt(() => esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      outdir: join(folder, 'dist'),
      format: 'esm',
      platform: 'browser',
      target: 'es2020',
      jsx: 'automatic',
      jsxImportSource: 'react',
      // Only replaces names the app uses without declaring or importing them.
      inject: [globalsPath],
      loader: { '.css': 'css', '.tsx': 'tsx', '.ts': 'ts' },
      absWorkingDir: repoRoot || cliPackageRoot || process.cwd(),
      nodePaths,
      alias: repoRoot ? { '@': repoRoot } : undefined,
      plugins: repoRoot ? undefined : [createPreviewSnapshotPlugin()],
      logLevel: 'silent',
    }))
  })
}

function serveFile(root: string): Parameters<typeof createServer>[1] {
  return (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname
    const filePath = resolve(root, `.${requestedPath}`)
    const relativePath = relative(root, filePath)
    let isServable = false
    try {
      isServable = !relativePath.startsWith('..') && !isAbsolute(relativePath) && existsSync(filePath) && statSync(filePath).isFile()
    } catch {}
    if (!isServable) {
      response.statusCode = 404
      response.end('Not found')
      return
    }
    const ext = basename(filePath).split('.').pop()
    const contentType =
      ext === 'html' ? 'text/html; charset=utf-8' :
      ext === 'js' ? 'text/javascript; charset=utf-8' :
      ext === 'css' ? 'text/css; charset=utf-8' :
      'application/octet-stream'
    response.setHeader('content-type', contentType)
    try {
      response.end(readFileSync(filePath))
    } catch {
      response.statusCode = 500
      response.end('Internal server error')
    }
  }
}

/** One listen attempt on its own server, so a taken port leaves no listener behind. */
function listenOn(root: string, port: number) {
  return Effect.callback<Server, NodeJS.ErrnoException>(resume => {
    const server = createServer(serveFile(root))
    server.once('error', error => resume(Effect.fail(error)))
    server.listen(port, '127.0.0.1', () => {
      server.removeAllListeners('error')
      resume(Effect.succeed(server))
    })
    // Stopped mid-listen: don't leave a server that starts listening later.
    return Effect.sync(() => server.close())
  })
}

const closeServer = (server: Server) => Effect.sync(() => {
  server.close()
  server.closeAllConnections()
})

/** The local server on a free port from a random start in 39000–39999 (20 tries). Closed on every ending. */
function previewServer(root: string) {
  return Effect.acquireRelease(
    Effect.gen(function*() {
      const firstPort = 39000 + Math.floor(Math.random() * 1000)
      for (let offset = 0; offset < 20; offset += 1) {
        const exit = yield* Effect.exit(listenOn(root, firstPort + offset))
        if (Exit.isSuccess(exit)) return { server: exit.value, port: firstPort + offset }
        const error = Cause.squash(exit.cause) as NodeJS.ErrnoException
        if (error.code !== 'EADDRINUSE') return yield* Effect.fail(error)
      }
      return yield* Effect.fail(new Error('Unable to find an available localhost port for app preview.'))
    }),
    ({ server }) => closeServer(server),
  )
}

/**
 * Chromium, closed on every ending except one the person ended by closing it.
 * A launch stopped part-way can't be cancelled, so the browser it starts late
 * is closed when it arrives.
 */
function previewBrowser(playwright: PreviewPlaywright, launchOptions: Record<string, unknown>, lifetime: { isClosedByPerson: boolean }) {
  return Effect.acquireRelease(
    Effect.interruptible(Effect.callback<PreviewBrowser, unknown>(resume => {
      let isAbandoned = false
      playwright.chromium.launch(launchOptions).then(
        browser => {
          if (isAbandoned) void browser.close().catch(() => {})
          else resume(Effect.succeed(browser))
        },
        error => { if (!isAbandoned) resume(Effect.fail(error)) },
      )
      return Effect.sync(() => { isAbandoned = true })
    })),
    browser => lifetime.isClosedByPerson ? Effect.void : Effect.promise(() => browser.close().catch(() => {})),
  )
}

/** Fails with the page's first error; its listener goes when this ends. */
function renderFailure(page: PreviewPage) {
  return Effect.callback<never, Error>(resume => {
    const handleRenderError = (error: Error) => resume(Effect.fail(new Error(`App preview render failed: ${error.message}`)))
    page.on?.('pageerror', handleRenderError)
    return Effect.sync(() => { page.off?.('pageerror', handleRenderError) })
  })
}

/** Ends when the person closes the page or Chromium goes away. */
function previewClosed(page: PreviewPage, browser: PreviewBrowser) {
  return Effect.callback<void>(resume => {
    const done = () => resume(Effect.void)
    const cleanups: Array<() => void> = []
    const listen = (target: PreviewPage | PreviewBrowser, event: string) => {
      const listener = typeof target.once === 'function' ? target.once : target.on
      if (typeof listener !== 'function') return false
      listener.call(target, event, done)
      cleanups.push(() => target.off?.(event, done))
      return true
    }
    const isListening = [listen(page, 'close'), listen(browser, 'disconnected')].some(Boolean)
    if (!isListening) page.waitForTimeout(24 * 60 * 60 * 1000).then(done, done)
    return Effect.sync(() => { for (const cleanup of cleanups) cleanup() })
  })
}

function previewProgram(options: AppPreviewOptions, launchHandlers: Record<string, unknown>) {
  return Effect.scoped(Effect.gen(function*() {
    const issues = yield* Effect.try({ try: () => validatePreviewInputs(options), catch: cause => cause })
    const errors = issues.filter(issue => issue.level === 'error')
    if (errors.length > 0) return yield* Effect.fail(new Error(errors.map(issue => issue.message).join('\n')))

    const folder = yield* previewFolder
    yield* bundlePreview(options, folder)
    const served = yield* previewServer(folder).pipe(Effect.orElseSucceed(() => null))
    const url = served ? `http://127.0.0.1:${served.port}/index.html` : pathToFileURL(join(folder, 'index.html')).href

    const browsers = yield* PreviewBrowsers
    const playwright = yield* browsers.playwright
    const lifetime = { isClosedByPerson: false }
    const browser = yield* previewBrowser(playwright, {
      headless: !options.headed,
      ...(browsers.executablePath ? { executablePath: browsers.executablePath } : {}),
      ...launchHandlers,
    }, lifetime)
    const page = yield* attempt(() => browser.newPage({ viewport: { width: 1440, height: 1000 } }))
    // The error listener starts first: React can fail before the ready marker mounts.
    yield* Effect.raceFirst(
      renderFailure(page),
      attempt(() => page.goto(url, { waitUntil: 'networkidle' }).then(() =>
        page.waitForSelector('[data-orizu-preview-ready="true"]', { timeout: 15_000 })
      )),
    )
    if (options.screenshotPath) {
      const screenshotPath = options.screenshotPath
      yield* attempt(() => page.screenshot({ path: screenshotPath, fullPage: true }))
    }
    const result: AppPreviewResult = {
      url,
      screenshotPath: options.screenshotPath,
      warnings: issues.filter(issue => issue.level === 'warn').map(issue => issue.message),
    }
    options.onRendered?.(result)
    if (options.keepOpen) {
      yield* previewClosed(page, browser)
      lifetime.isClosedByPerson = true
    }
    return result
  }))
}

async function loadPlaywright(): Promise<PreviewPlaywright> {
  const fromTest = await import('@playwright/test').catch(() => null)
  // SAFETY: the module has a chromium launcher; the preview uses only the members PreviewPlaywright names.
  if (fromTest?.chromium) return fromTest as unknown as PreviewPlaywright
  const fromPlaywright = await import('playwright').catch(() => null)
  // SAFETY: as above, for the plain playwright package.
  if (fromPlaywright?.chromium) return fromPlaywright as unknown as PreviewPlaywright
  throw new Error(
    'Local preview requires Playwright. Install project dependencies with `bun install`, then rerun `orizu apps preview`.'
  )
}

function resolveChromiumExecutablePath(): string | null {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean) as string[]

  return candidates.find(candidate => existsSync(candidate)) || null
}

function browsersLayer(options: AppPreviewOptions) {
  return Layer.succeed(PreviewBrowsers, PreviewBrowsers.of({
    playwright: options.playwright ? Effect.succeed(options.playwright) : attempt(loadPlaywright),
    executablePath: 'chromiumExecutablePath' in options ? options.chromiumExecutablePath ?? null : resolveChromiumExecutablePath(),
  }))
}

/** Renders the preview; Ctrl-C and SIGTERM are left to Node and Playwright, as before. */
export async function runPreview(options: AppPreviewOptions): Promise<AppPreviewResult> {
  const exit = await Effect.runPromiseExit(Effect.provide(previewProgram(options, {}), browsersLayer(options)))
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}

/**
 * `orizu apps preview`: Ctrl-C and SIGTERM stop the preview and close
 * Chromium, the server and the folder before the command exits with 130 or 143.
 * Playwright's own signal handlers are off, so it can't end the process first.
 */
export async function runPreviewCommand(options: AppPreviewOptions): Promise<AppPreviewResult | Interrupted> {
  const { exit, interrupted } = await runWithStops(() => Effect.provide(
    previewProgram(options, { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }),
    browsersLayer(options),
  ))
  if (Exit.isSuccess(exit)) return exit.value
  if (interrupted !== undefined) return { interrupted }
  throw Cause.squash(exit.cause)
}
