import { createServer } from 'http';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
export const PREVIEW_RUNTIME_REGISTRY_VERSION = 1;
// BEGIN_ORIZU_PREVIEW_IMPORT_REGISTRY
export const PREVIEW_ALLOWED_IMPORTS = {
    '@/components/ui/button': ['Button'],
    '@/components/ui/card': ['Card'],
    '@/components/ui/carousel': ['Carousel'],
    '@/components/ui/checkbox': ['Checkbox'],
    '@/components/ui/form': ['Form'],
    '@/components/ui/input': ['Input'],
    '@/components/ui/label': ['Label'],
    '@/components/ui/progress': ['Progress'],
    '@/components/ui/radio-group': ['RadioGroup', 'RadioGroupItem'],
    '@/components/ui/scroll-area': ['ScrollArea'],
    '@/components/ui/select': ['Select', 'SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue'],
    '@/components/ui/separator': ['Separator'],
    '@/components/ui/switch': ['Switch'],
    '@/components/ui/table': ['Table', 'TableBody', 'TableCell', 'TableHead', 'TableHeader', 'TableRow', 'TableCaption', 'TableFooter'],
    '@/components/ui/tabs': ['Tabs', 'TabsContent', 'TabsList', 'TabsTrigger'],
    '@/components/ui/textarea': ['Textarea'],
    '@/components/ui/toggle': ['Toggle'],
    '@/components/ui/toggle-group': ['ToggleGroup', 'ToggleGroupItem'],
    '@/components/ui/tooltip': ['Tooltip', 'TooltipContent', 'TooltipProvider', 'TooltipTrigger'],
    '@/components/base/content/TextContent': ['TextContent', 'default'],
    '@/components/base/content/CodeBlock': ['CodeBlock', 'default'],
    '@/components/base/content/ConversationView': ['AssistantMessageBlock', 'ContextMessageBlock', 'ConversationMessageBlock', 'ConversationView', 'ReasoningMessageBlock', 'SystemMessageBlock', 'ToolCallBlock', 'ToolResultBlock', 'UserMessageBlock', 'default'],
    '@/components/base/content/ContentRenderer': ['ContentRenderer', 'default'],
    '@/components/base/content/Prose': ['Prose', 'default'],
    '@/components/base/behaviors/Annotatable': ['Annotatable', 'default'],
    '@/components/base/behaviors/Reactable': ['Reactable', 'default'],
    '@/components/base/input/CommentBox': ['CommentBox'],
    '@/components/base/input/CriterionRating': ['CriterionRating'],
    '@/components/base/input/LikertScale': ['LikertScale'],
    '@/components/base/input/NumericRating': ['NumericRating'],
    '@/components/base/input/RatingSelector': ['RatingSelector'],
    '@/components/base/input/StarRating': ['StarRating'],
    '@/components/base/input/TagPicker': ['TagPicker'],
    '@/components/base/input/ThumbsRating': ['ThumbsRating'],
    '@/components/base/ui/ComparisonPanel': ['ComparisonPanel'],
    '@/components/base/ui/DraggableItem': ['DraggableItem'],
    '@/components/templates/classification/TagSelector': ['TagSelector'],
    '@/components/templates/comparison/SideBySideComparison': ['SideBySideComparison'],
    '@/components/templates/correction/CorrectionTask': ['CorrectionTask'],
    '@/components/templates/code/CodeComparison': ['CodeComparison'],
    '@/components/templates/qa/ContextualQA': ['ContextualQA'],
    '@/components/templates/ranking/RankingList': ['RankingList'],
    '@/components/templates/rating/SingleItemRater': ['SingleItemRater'],
};
const SUPPORTED_SCHEMA_KEYS = new Set(['type', 'required', 'properties', 'items', 'enum']);
export function validatePreviewInputs(options) {
    const issues = [];
    const source = readFileSync(options.filePath, 'utf8');
    validateImports(source, issues);
    validateDefaultExport(source, options.componentName, issues);
    validateSchema(options.inputSchema, 'input schema', issues);
    validateSchema(options.outputSchema, 'output schema', issues);
    validatePayload(options.inputSchema, options.sampleRow, 'sample row', issues);
    return issues;
}
export async function runLocalAppPreview(options) {
    const issues = validatePreviewInputs(options);
    const errors = issues.filter(issue => issue.level === 'error');
    if (errors.length > 0) {
        throw new Error(errors.map(issue => issue.message).join('\n'));
    }
    const tempDir = mkdtempSync(join(tmpdir(), 'orizu-app-preview-'));
    const appPath = realpathSync(options.filePath);
    const repoRoot = options.forceSnapshot
        ? null
        : findPreviewRepoRoot(options.cwd || process.cwd(), appPath);
    const cliPackageRoot = findCliPackageRoot();
    const entryPath = join(tempDir, 'entry.tsx');
    const cssPath = join(tempDir, 'preview.css');
    const htmlPath = join(tempDir, 'index.html');
    const outDir = join(tempDir, 'dist');
    writeFileSync(cssPath, await buildPreviewCss(repoRoot, appPath), 'utf8');
    writeFileSync(entryPath, buildEntrySource(appPath, options.sampleRow), 'utf8');
    writeFileSync(htmlPath, buildPreviewHtml(), 'utf8');
    let server = null;
    try {
        const esbuild = await import('esbuild').catch(() => null);
        if (!esbuild) {
            throw new Error('Local preview requires esbuild. Install project dependencies with `bun install` or run from an Orizu checkout.');
        }
        await esbuild.build({
            entryPoints: [entryPath],
            bundle: true,
            outdir: outDir,
            format: 'esm',
            platform: 'browser',
            target: 'es2020',
            jsx: 'automatic',
            jsxImportSource: 'react',
            loader: {
                '.css': 'css',
                '.tsx': 'tsx',
                '.ts': 'ts',
            },
            absWorkingDir: repoRoot || cliPackageRoot || process.cwd(),
            nodePaths: [
                ...(repoRoot ? [join(repoRoot, 'node_modules')] : []),
                ...(cliPackageRoot ? findNodeModuleDirs(cliPackageRoot) : []),
            ],
            alias: repoRoot ? { '@': repoRoot } : undefined,
            plugins: repoRoot ? undefined : [createPreviewSnapshotPlugin()],
            logLevel: 'silent',
        });
        let url = pathToFileURL(htmlPath).href;
        try {
            server = await serveDirectory(tempDir);
            url = `http://127.0.0.1:${server.port}/index.html`;
        }
        catch {
            server = null;
        }
        const playwright = options.playwright || await loadPlaywright();
        const chromiumExecutablePath = 'chromiumExecutablePath' in options
            ? options.chromiumExecutablePath
            : resolveChromiumExecutablePath();
        const browser = await playwright.chromium.launch({
            headless: !options.headed,
            ...(chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {}),
        });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        try {
            await page.goto(url, { waitUntil: 'networkidle' });
            await page.waitForSelector('[data-orizu-preview-ready="true"]', { timeout: 15_000 });
            if (options.screenshotPath) {
                await page.screenshot({ path: options.screenshotPath, fullPage: true });
            }
            if (options.keepOpen) {
                await waitForPreviewClose(page, browser);
            }
        }
        finally {
            if (!options.keepOpen) {
                await browser.close();
            }
        }
        return {
            url,
            screenshotPath: options.screenshotPath,
            warnings: issues.filter(issue => issue.level === 'warn').map(issue => issue.message),
        };
    }
    finally {
        await server?.close();
        rmSync(tempDir, { recursive: true, force: true });
    }
}
function waitForPreviewClose(page, browser) {
    return new Promise(resolveClose => {
        const cleanups = [];
        let settled = false;
        const done = () => {
            if (settled)
                return;
            settled = true;
            for (const cleanup of cleanups)
                cleanup();
            resolveClose();
        };
        const listen = (target, event) => {
            if (typeof target.once === 'function') {
                target.once(event, done);
                return true;
            }
            if (typeof target.on === 'function') {
                target.on(event, done);
                if (typeof target.off === 'function') {
                    cleanups.push(() => target.off?.(event, done));
                }
                return true;
            }
            return false;
        };
        const listening = [
            listen(page, 'close'),
            listen(browser, 'disconnected'),
        ].some(Boolean);
        if (!listening) {
            page.waitForTimeout(24 * 60 * 60 * 1000).then(done, done);
        }
    });
}
function validateImports(source, issues) {
    const importRegex = /import\s+(?:(\w+)(?:\s*,\s*)?)?(?:\{([^}]+)\})?\s+from\s+['"`]([^'"`]+)['"`]/g;
    for (const match of source.matchAll(importRegex)) {
        const defaultImport = match[1];
        const namedImports = match[2]
            ? match[2].split(',').map(name => name.trim().replace(/\s+as\s+\w+/, '')).filter(Boolean)
            : [];
        const importPath = match[3];
        if (importPath === 'react' || importPath === 'react-dom' || importPath.startsWith('react/')) {
            continue;
        }
        const allowed = PREVIEW_ALLOWED_IMPORTS[importPath];
        if (!allowed) {
            issues.push({ level: 'error', message: `Import not available in Orizu apps: ${importPath}` });
            continue;
        }
        if (defaultImport && !allowed.includes('default') && !allowed.includes(defaultImport)) {
            issues.push({
                level: 'error',
                message: `Default import '${defaultImport}' is not available from '${importPath}'.`,
            });
        }
        for (const name of namedImports) {
            if (!allowed.includes(name)) {
                issues.push({
                    level: 'error',
                    message: `Named import '${name}' is not available from '${importPath}'.`,
                });
            }
        }
    }
}
function validateDefaultExport(source, componentName, issues) {
    const resolved = resolveDefaultExport(source);
    if (!resolved) {
        issues.push({
            level: 'error',
            message: 'App must default export a named React component.',
        });
        return;
    }
    if (componentName && resolved.name !== componentName) {
        issues.push({
            level: 'error',
            message: `Component name mismatch: expected '${componentName}', found '${resolved.name}'.`,
        });
    }
    if (resolved.params === null) {
        return;
    }
    const params = resolved.params.trim();
    if (!params.startsWith('{') || !params.includes('inputData') || !params.includes('onComplete')) {
        issues.push({
            level: 'error',
            message: "Default component must destructure contract props 'inputData' and 'onComplete'.",
        });
    }
    if (/\bdata\b|\bonSubmit\b/.test(params)) {
        issues.push({
            level: 'error',
            message: "Use Orizu contract props instead of deprecated root props 'data' or 'onSubmit'.",
        });
    }
}
function resolveDefaultExport(source) {
    const directFunction = source.match(/export\s+default\s+function\s+([A-Za-z_$][\w$]*)\s*\(([\s\S]*?)\)/);
    if (directFunction?.[1]) {
        return { name: directFunction[1], params: directFunction[2] ?? '' };
    }
    const directClass = source.match(/export\s+default\s+class\s+([A-Za-z_$][\w$]*)/);
    if (directClass?.[1]) {
        return { name: directClass[1], params: null };
    }
    const exportExpression = source.match(/export\s+default\s+([^\n;]+)/);
    const identifier = exportExpression?.[1]
        ? unwrapDefaultExportExpression(exportExpression[1])
        : null;
    if (!identifier) {
        return null;
    }
    const escapedIdentifier = escapeRegExp(identifier);
    const functionDeclaration = source.match(new RegExp(`function\\s+${escapedIdentifier}(?![A-Za-z0-9_$])\\s*\\(([\\s\\S]*?)\\)`));
    if (functionDeclaration) {
        return { name: identifier, params: functionDeclaration[1] ?? '' };
    }
    const arrowDeclaration = source.match(new RegExp(`(?:const|let|var)\\s+${escapedIdentifier}(?![A-Za-z0-9_$])\\s*=\\s*(?:\\(([^)]*)\\)|([^=()\\n]+))\\s*(?::\\s*[^=\\n]+)?\\s*=>`));
    if (arrowDeclaration) {
        return { name: identifier, params: arrowDeclaration[1] ?? arrowDeclaration[2] ?? '' };
    }
    const classDeclaration = source.match(new RegExp(`class\\s+${escapedIdentifier}(?![A-Za-z0-9_$])`));
    if (classDeclaration) {
        return { name: identifier, params: null };
    }
    return null;
}
function unwrapDefaultExportExpression(expression) {
    const trimmed = expression
        .replace(/\/\*[\s\S]*?\*\/\s*$/, '')
        .replace(/\/\/.*$/, '')
        .trim();
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed)) {
        return trimmed;
    }
    const wrapperMatch = trimmed.match(/^(?:[A-Za-z_$][A-Za-z0-9_$]*\.)?[A-Za-z_$][A-Za-z0-9_$]*\(\s*(.+)\s*\)$/);
    if (!wrapperMatch?.[1]) {
        return null;
    }
    return unwrapDefaultExportExpression(wrapperMatch[1]);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function validateSchema(schema, label, issues, path = label) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        issues.push({ level: 'error', message: `${path} must be a JSON object.` });
        return;
    }
    const obj = schema;
    for (const key of Object.keys(obj)) {
        if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
            issues.push({ level: 'warn', message: `${path}.${key} is outside the supported schema subset and is ignored.` });
        }
    }
    if ('properties' in obj && (!obj.properties || typeof obj.properties !== 'object' || Array.isArray(obj.properties))) {
        issues.push({ level: 'error', message: `${path}.properties must be an object.` });
    }
    if ('required' in obj && !Array.isArray(obj.required)) {
        issues.push({ level: 'error', message: `${path}.required must be an array.` });
    }
    if (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) {
        for (const [name, child] of Object.entries(obj.properties)) {
            validateSchema(child, label, issues, `${path}.properties.${name}`);
        }
    }
    if (obj.items) {
        validateSchema(obj.items, label, issues, `${path}.items`);
    }
}
function validatePayload(schema, payload, path, issues) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema))
        return;
    const obj = schema;
    if (Array.isArray(obj.enum) && !obj.enum.includes(payload)) {
        issues.push({ level: 'error', message: `${path} must be one of: ${obj.enum.join(', ')}` });
        return;
    }
    if (obj.type === 'object') {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            issues.push({ level: 'error', message: `${path} must be an object.` });
            return;
        }
        const record = payload;
        if (Array.isArray(obj.required)) {
            for (const key of obj.required) {
                if (typeof key === 'string' && !(key in record)) {
                    issues.push({ level: 'error', message: `${path}.${key} is required.` });
                }
            }
        }
        if (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) {
            for (const [key, child] of Object.entries(obj.properties)) {
                if (key in record)
                    validatePayload(child, record[key], `${path}.${key}`, issues);
            }
        }
    }
    if (obj.type === 'array') {
        if (!Array.isArray(payload)) {
            issues.push({ level: 'error', message: `${path} must be an array.` });
            return;
        }
        if (obj.items) {
            payload.forEach((item, index) => validatePayload(obj.items, item, `${path}[${index}]`, issues));
        }
    }
    if (obj.type === 'string' && typeof payload !== 'string') {
        issues.push({ level: 'error', message: `${path} must be a string.` });
    }
    if (obj.type === 'number' && typeof payload !== 'number') {
        issues.push({ level: 'error', message: `${path} must be a number.` });
    }
    if (obj.type === 'integer' && (!Number.isInteger(payload))) {
        issues.push({ level: 'error', message: `${path} must be an integer.` });
    }
    if (obj.type === 'boolean' && typeof payload !== 'boolean') {
        issues.push({ level: 'error', message: `${path} must be a boolean.` });
    }
}
function findPreviewRepoRoot(cwd, appPath) {
    for (const start of [cwd, dirname(appPath), dirname(fileURLPath())]) {
        let current = resolve(start);
        while (true) {
            if (existsSync(join(current, 'components')) &&
                existsSync(join(current, 'app', 'globals.css')) &&
                existsSync(join(current, 'lib', 'available-components.ts'))) {
                return current;
            }
            const parent = dirname(current);
            if (parent === current)
                break;
            current = parent;
        }
    }
    return null;
}
function fileURLPath() {
    return fileURLToPath(new URL('.', import.meta.url));
}
function findCliPackageRoot() {
    let current = resolve(dirname(fileURLPath()));
    while (true) {
        if (existsSync(join(current, 'package.json')) &&
            (existsSync(join(current, 'dist', 'index.js')) || existsSync(join(current, 'src', 'index.ts')))) {
            return current;
        }
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return null;
}
function findNodeModuleDirs(start) {
    const dirs = [];
    let current = resolve(start);
    while (true) {
        const candidate = join(current, 'node_modules');
        if (existsSync(candidate)) {
            dirs.push(candidate);
        }
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return dirs;
}
function buildEntrySource(appPath, sampleRow) {
    return `
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from ${JSON.stringify(appPath)}
import ${JSON.stringify('./preview.css')}

const inputData = ${JSON.stringify(sampleRow)}
const root = createRoot(document.getElementById('root'))

function PreviewShell() {
  const [submissions, setSubmissions] = React.useState([])
  const onComplete = React.useCallback((payload) => {
    window.__orizuSubmissions = [...(window.__orizuSubmissions || []), payload]
    setSubmissions(window.__orizuSubmissions)
  }, [])
  return React.createElement(
    'main',
    { className: 'orizu-preview-shell', 'data-orizu-preview-ready': 'true' },
    React.createElement(
      'div',
      { className: 'orizu-preview-app' },
      React.createElement(App, { inputData, initialValues: {}, onComplete })
    ),
    React.createElement(
      'aside',
      { className: 'orizu-preview-submissions', 'aria-label': 'Preview submissions' },
      React.createElement('h2', null, 'Submissions'),
      React.createElement('pre', null, JSON.stringify(submissions, null, 2))
    )
  )
}

root.render(React.createElement(PreviewShell))
`;
}
function buildPreviewHtml() {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Orizu app preview</title>
    <link rel="stylesheet" href="./dist/entry.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./dist/entry.js"></script>
  </body>
</html>
`;
}
export async function buildPreviewCss(repoRoot, appPath) {
    const fallbackCss = buildPreviewChromeCss();
    try {
        const postcss = (await import('postcss')).default;
        const tailwind = (await import('@tailwindcss/postcss')).default;
        const cliPackageRoot = findCliPackageRoot();
        const globalsPath = repoRoot
            ? join(repoRoot, 'app', 'globals.css')
            : join(cliPackageRoot || dirname(appPath), 'preview-runtime.css');
        const globalsCss = repoRoot
            ? readFileSync(globalsPath, 'utf8')
            : buildSnapshotTailwindCss();
        const sourceCss = [
            `@source ${JSON.stringify(appPath)};`,
            ...(repoRoot
                ? [
                    `@source ${JSON.stringify(join(repoRoot, 'components/**/*.{ts,tsx}'))};`,
                    `@source ${JSON.stringify(join(repoRoot, 'app/**/*.{ts,tsx}'))};`,
                ]
                : []),
            globalsCss,
            fallbackCss,
        ].join('\n');
        const result = await postcss([tailwind()]).process(sourceCss, { from: globalsPath });
        return result.css;
    }
    catch {
        return fallbackCss;
    }
}
function buildPreviewChromeCss() {
    return `
:root {
  color-scheme: light;
  --background: #fbfaf8;
  --foreground: #1f1a17;
  --card: #ffffff;
  --border: #e7ded6;
  --muted: #f2eeea;
  --muted-foreground: #756b62;
  --primary: #d95f2b;
  --primary-foreground: #fffaf7;
  --radius: 10px;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--background); color: var(--foreground); }
button, input, textarea, select { font: inherit; }
.orizu-preview-shell { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; min-height: 100vh; padding: 24px; }
.orizu-preview-app { min-width: 0; padding: 24px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); }
.orizu-preview-submissions { border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); padding: 16px; }
.orizu-preview-submissions h2 { margin: 0 0 12px; font-size: 14px; }
.orizu-preview-submissions pre { overflow: auto; margin: 0; color: var(--muted-foreground); font-size: 12px; white-space: pre-wrap; }
@media (max-width: 900px) { .orizu-preview-shell { grid-template-columns: 1fr; padding: 12px; } }
`;
}
function buildSnapshotTailwindCss() {
    return `
@import 'tailwindcss';

@theme {
  --color-background: #fbfaf8;
  --color-foreground: #1f1a17;
  --color-card: #ffffff;
  --color-card-foreground: #1f1a17;
  --color-popover: #ffffff;
  --color-popover-foreground: #1f1a17;
  --color-primary: #d95f2b;
  --color-primary-foreground: #fffaf7;
  --color-secondary: #f2eeea;
  --color-secondary-foreground: #1f1a17;
  --color-muted: #f2eeea;
  --color-muted-foreground: #756b62;
  --color-accent: #f5c15b;
  --color-accent-foreground: #1f1a17;
  --color-destructive: #c8442a;
  --color-destructive-foreground: #ffffff;
  --color-border: #e7ded6;
  --color-input: #f2eeea;
  --color-ring: #d95f2b;
  --font-sans: Inter, ui-sans-serif, system-ui, sans-serif;
  --font-mono: "Geist Mono", Menlo, Monaco, Consolas, monospace;
  --font-serif: Lora, Georgia, serif;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 10px;
  --radius-xl: 14px;
}
`;
}
function createPreviewSnapshotPlugin() {
    const modules = buildPreviewSnapshotModules();
    return {
        name: 'orizu-preview-runtime-snapshot',
        setup(build) {
            build.onResolve({ filter: /^@\/components\// }, (args) => {
                if (modules[args.path]) {
                    return { path: args.path, namespace: 'orizu-preview-snapshot' };
                }
                return null;
            });
            build.onLoad({ filter: /.*/, namespace: 'orizu-preview-snapshot' }, (args) => {
                const contents = modules[args.path];
                if (!contents) {
                    return null;
                }
                return {
                    contents,
                    loader: 'tsx',
                    resolveDir: findCliPackageRoot() || process.cwd(),
                };
            });
        },
    };
}
function buildPreviewSnapshotModules() {
    const primitiveSource = `
import React from 'react'

function cn(...values) {
  return values.filter(Boolean).join(' ')
}

function primitive(tag, baseClass = '') {
  return React.forwardRef(function SnapshotPrimitive({ children, className, asChild, ...props }, ref) {
    const element = asChild && React.isValidElement(children)
      ? React.cloneElement(children, {
          ...props,
          ref,
          className: cn(baseClass, children.props?.className, className),
        })
      : React.createElement(tag, { ...props, ref, className: cn(baseClass, className) }, children)
    return element
  })
}

function field(tag, baseClass = '') {
  return React.forwardRef(function SnapshotField({ className, ...props }, ref) {
    return React.createElement(tag, { ...props, ref, className: cn(baseClass, className) })
  })
}
`;
    const contentSource = `
import React from 'react'
function cn(...values) { return values.filter(Boolean).join(' ') }
export function TextContent({ content, children, className, ...props }) {
  return <div {...props} className={cn('whitespace-pre-wrap text-sm leading-relaxed', className)}>{children ?? content}</div>
}
export default TextContent
`;
    const codeBlockSource = `
import React from 'react'
function cn(...values) { return values.filter(Boolean).join(' ') }
export function CodeBlock({ code, children, className, ...props }) {
  return <pre {...props} className={cn('overflow-auto rounded-md border bg-muted p-3 font-mono text-xs', className)}><code>{children ?? code}</code></pre>
}
export default CodeBlock
`;
    const proseSource = `
import React from 'react'
function cn(...values) { return values.filter(Boolean).join(' ') }
export function Prose({ children, className, ...props }) {
  return <div {...props} className={cn('prose prose-sm max-w-none text-foreground', className)}>{children}</div>
}
export default Prose
`;
    const contentRendererSource = `
import React from 'react'
function cn(...values) { return values.filter(Boolean).join(' ') }
export function ContentRenderer({ content, children, className, ...props }) {
  return <div {...props} className={cn('whitespace-pre-wrap text-sm leading-relaxed', className)}>{children ?? content}</div>
}
export default ContentRenderer
`;
    const conversationSource = `
import React from 'react'
function cn(...values) { return values.filter(Boolean).join(' ') }
function MessageBlock({ children, className, role, message, ...props }) {
  return <div {...props} className={cn('rounded-md border bg-card p-3 text-sm', className)}><div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{role}</div>{children ?? message?.content ?? message}</div>
}
export function ConversationView({ messages = [], children, className, ...props }) {
  return <div {...props} className={cn('space-y-3', className)}>{children ?? messages.map((message, index) => <MessageBlock key={index} message={message} role={message?.role ?? 'message'} />)}</div>
}
export const ConversationMessageBlock = MessageBlock
export const AssistantMessageBlock = (props) => <MessageBlock {...props} role="assistant" />
export const UserMessageBlock = (props) => <MessageBlock {...props} role="user" />
export const SystemMessageBlock = (props) => <MessageBlock {...props} role="system" />
export const ContextMessageBlock = (props) => <MessageBlock {...props} role="context" />
export const ReasoningMessageBlock = (props) => <MessageBlock {...props} role="reasoning" />
export const ToolCallBlock = (props) => <MessageBlock {...props} role="tool call" />
export const ToolResultBlock = (props) => <MessageBlock {...props} role="tool result" />
export default ConversationView
`;
    const behaviorSource = `
import React from 'react'
function cn(...values) { return values.filter(Boolean).join(' ') }
export function Annotatable({ children, className, ...props }) {
  return <span {...props} className={cn('rounded-sm bg-yellow-50 ring-1 ring-yellow-200', className)}>{children}</span>
}
export function Reactable({ children, className, reactions, ...props }) {
  return <span {...props} className={cn('inline-flex items-center gap-1', className)}>{children}{Array.isArray(reactions) ? reactions.map((reaction, index) => <span key={index} className="rounded-full border px-1 text-xs">{reaction?.emoji ?? reaction}</span>) : null}</span>
}
`;
    const inputSource = `
import React from 'react'
function cn(...values) { return values.filter(Boolean).join(' ') }
export function CommentBox({ value, onChange, placeholder, className, ...props }) {
  return <textarea {...props} value={value} placeholder={placeholder} onChange={(event) => onChange?.(event.target.value)} className={cn('min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm', className)} />
}
export function NumericRating({ value, onChange, max = 5, className, ...props }) {
  return <div {...props} className={cn('inline-flex gap-1', className)}>{Array.from({ length: max }, (_, i) => i + 1).map(n => <button key={n} type="button" onClick={() => onChange?.(n)} className={cn('rounded-md border px-3 py-1 text-sm', value === n && 'bg-primary text-primary-foreground')}>{n}</button>)}</div>
}
export const StarRating = NumericRating
export const LikertScale = NumericRating
export const RatingSelector = NumericRating
export function ThumbsRating({ value, onChange, className, ...props }) {
  return <div {...props} className={cn('inline-flex gap-2', className)}><button type="button" onClick={() => onChange?.('up')} className={cn('rounded-md border px-3 py-1', value === 'up' && 'bg-primary text-primary-foreground')}>Up</button><button type="button" onClick={() => onChange?.('down')} className={cn('rounded-md border px-3 py-1', value === 'down' && 'bg-primary text-primary-foreground')}>Down</button></div>
}
export function CriterionRating({ criteria = [], value = {}, onChange, className, ...props }) {
  return <div {...props} className={cn('space-y-2', className)}>{criteria.map((criterion) => <label key={criterion} className="flex items-center justify-between gap-3 text-sm"><span>{criterion}</span><NumericRating value={value[criterion]} onChange={(rating) => onChange?.({ ...value, [criterion]: rating })} /></label>)}</div>
}
export function TagPicker({ options = [], value = [], onChange, className, ...props }) {
  return <div {...props} className={cn('flex flex-wrap gap-2', className)}>{options.map(option => { const selected = value.includes(option); return <button key={option} type="button" onClick={() => onChange?.(selected ? value.filter(v => v !== option) : [...value, option])} className={cn('rounded-full border px-3 py-1 text-sm', selected && 'bg-primary text-primary-foreground')}>{option}</button> })}</div>
}
`;
    const templateSource = `
import React from 'react'
function cn(...values) { return values.filter(Boolean).join(' ') }
function Template({ title, children, className, inputData, onComplete, ...props }) {
  return <section {...props} className={cn('rounded-lg border bg-card p-4 text-card-foreground', className)}><h2 className="mb-3 text-lg font-semibold">{title ?? inputData?.title ?? 'Preview template'}</h2>{children}<button type="button" onClick={() => onComplete?.({ reviewed: true })} className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Submit</button></section>
}
export const TagSelector = Template
export const SideBySideComparison = Template
export const CorrectionTask = Template
export const CodeComparison = Template
export const ContextualQA = Template
export const RankingList = Template
export const SingleItemRater = Template
`;
    return {
        '@/components/ui/button': `${primitiveSource}\nexport const Button = primitive('button', 'inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-50')`,
        '@/components/ui/card': `${primitiveSource}\nexport const Card = primitive('div', 'rounded-lg border bg-card text-card-foreground shadow-sm')`,
        '@/components/ui/carousel': `${primitiveSource}\nexport const Carousel = primitive('div', 'relative overflow-hidden')`,
        '@/components/ui/checkbox': `${primitiveSource}\nexport const Checkbox = field('input', 'h-4 w-4 rounded border border-input')`,
        '@/components/ui/form': `${primitiveSource}\nexport const Form = primitive('form', 'space-y-4')`,
        '@/components/ui/input': `${primitiveSource}\nexport const Input = field('input', 'h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm')`,
        '@/components/ui/label': `${primitiveSource}\nexport const Label = primitive('label', 'text-sm font-medium leading-none')`,
        '@/components/ui/progress': `${primitiveSource}\nexport const Progress = field('progress', 'h-2 w-full overflow-hidden rounded-full')`,
        '@/components/ui/radio-group': `${primitiveSource}\nexport const RadioGroup = primitive('div', 'grid gap-2')\nexport const RadioGroupItem = field('input', 'h-4 w-4')`,
        '@/components/ui/scroll-area': `${primitiveSource}\nexport const ScrollArea = primitive('div', 'overflow-auto')`,
        '@/components/ui/select': `${primitiveSource}\nexport const Select = primitive('select', 'h-10 rounded-md border border-input bg-background px-3 py-2 text-sm')\nexport const SelectTrigger = primitive('button', 'inline-flex h-10 items-center justify-between rounded-md border px-3 py-2 text-sm')\nexport const SelectValue = primitive('span')\nexport const SelectContent = primitive('div', 'rounded-md border bg-popover p-1')\nexport const SelectItem = primitive('option')`,
        '@/components/ui/separator': `${primitiveSource}\nexport const Separator = primitive('hr', 'border-border')`,
        '@/components/ui/switch': `${primitiveSource}\nexport const Switch = field('input', 'h-5 w-9 rounded-full')`,
        '@/components/ui/table': `${primitiveSource}\nexport const Table = primitive('table', 'w-full caption-bottom text-sm')\nexport const TableHeader = primitive('thead')\nexport const TableBody = primitive('tbody')\nexport const TableFooter = primitive('tfoot')\nexport const TableRow = primitive('tr', 'border-b')\nexport const TableHead = primitive('th', 'h-10 px-2 text-left font-medium')\nexport const TableCell = primitive('td', 'p-2 align-middle')\nexport const TableCaption = primitive('caption', 'mt-4 text-sm text-muted-foreground')`,
        '@/components/ui/tabs': `${primitiveSource}\nexport const Tabs = primitive('div')\nexport const TabsList = primitive('div', 'inline-flex rounded-md bg-muted p-1')\nexport const TabsTrigger = primitive('button', 'rounded-sm px-3 py-1 text-sm')\nexport const TabsContent = primitive('div', 'mt-2')`,
        '@/components/ui/textarea': `${primitiveSource}\nexport const Textarea = field('textarea', 'min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm')`,
        '@/components/ui/toggle': `${primitiveSource}\nexport const Toggle = primitive('button', 'inline-flex items-center rounded-md border px-3 py-2 text-sm')`,
        '@/components/ui/toggle-group': `${primitiveSource}\nexport const ToggleGroup = primitive('div', 'inline-flex rounded-md border')\nexport const ToggleGroupItem = primitive('button', 'px-3 py-2 text-sm')`,
        '@/components/ui/tooltip': `${primitiveSource}\nexport const TooltipProvider = primitive('div')\nexport const Tooltip = primitive('span')\nexport const TooltipTrigger = primitive('span')\nexport const TooltipContent = primitive('span', 'rounded-md border bg-popover px-2 py-1 text-xs')`,
        '@/components/base/content/TextContent': contentSource,
        '@/components/base/content/CodeBlock': codeBlockSource,
        '@/components/base/content/ConversationView': conversationSource,
        '@/components/base/content/ContentRenderer': contentRendererSource,
        '@/components/base/content/Prose': proseSource,
        '@/components/base/behaviors/Annotatable': `${behaviorSource}\nexport default Annotatable`,
        '@/components/base/behaviors/Reactable': `${behaviorSource}\nexport default Reactable`,
        '@/components/base/input/CommentBox': inputSource,
        '@/components/base/input/CriterionRating': inputSource,
        '@/components/base/input/LikertScale': inputSource,
        '@/components/base/input/NumericRating': inputSource,
        '@/components/base/input/RatingSelector': inputSource,
        '@/components/base/input/StarRating': inputSource,
        '@/components/base/input/TagPicker': inputSource,
        '@/components/base/input/ThumbsRating': inputSource,
        '@/components/base/ui/ComparisonPanel': `${primitiveSource}\nexport const ComparisonPanel = primitive('div', 'grid gap-4 rounded-lg border bg-card p-4 md:grid-cols-2')`,
        '@/components/base/ui/DraggableItem': `${primitiveSource}\nexport const DraggableItem = primitive('div', 'cursor-grab rounded-md border bg-card p-3')`,
        '@/components/templates/classification/TagSelector': templateSource,
        '@/components/templates/comparison/SideBySideComparison': templateSource,
        '@/components/templates/correction/CorrectionTask': templateSource,
        '@/components/templates/code/CodeComparison': templateSource,
        '@/components/templates/qa/ContextualQA': templateSource,
        '@/components/templates/ranking/RankingList': templateSource,
        '@/components/templates/rating/SingleItemRater': templateSource,
    };
}
export function getPreviewSnapshotModulePaths() {
    return Object.keys(buildPreviewSnapshotModules()).sort();
}
async function serveDirectory(root) {
    const server = createServer((request, response) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
        const filePath = resolve(root, `.${requestedPath}`);
        const relativePath = relative(root, filePath);
        if (relativePath.startsWith('..') || isAbsolute(relativePath) || !existsSync(filePath)) {
            response.statusCode = 404;
            response.end('Not found');
            return;
        }
        try {
            if (!statSync(filePath).isFile()) {
                response.statusCode = 404;
                response.end('Not found');
                return;
            }
        }
        catch {
            response.statusCode = 404;
            response.end('Not found');
            return;
        }
        const ext = basename(filePath).split('.').pop();
        const contentType = ext === 'html' ? 'text/html; charset=utf-8' :
            ext === 'js' ? 'text/javascript; charset=utf-8' :
                ext === 'css' ? 'text/css; charset=utf-8' :
                    'application/octet-stream';
        response.setHeader('content-type', contentType);
        try {
            response.end(readFileSync(filePath));
        }
        catch {
            response.statusCode = 500;
            response.end('Internal server error');
        }
    });
    const port = await listenOnAvailablePort(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Unable to start local preview server.');
    }
    return {
        port,
        close: () => new Promise(resolveClose => server.close(() => resolveClose())),
    };
}
async function listenOnAvailablePort(server) {
    const firstPort = 39000 + Math.floor(Math.random() * 1000);
    for (let offset = 0; offset < 20; offset += 1) {
        const port = firstPort + offset;
        try {
            await new Promise((resolveListen, reject) => {
                server.once('error', reject);
                server.listen(port, '127.0.0.1', () => {
                    server.off('error', reject);
                    resolveListen();
                });
            });
            return port;
        }
        catch (error) {
            server.removeAllListeners('error');
            if (error?.code !== 'EADDRINUSE')
                throw error;
        }
    }
    throw new Error('Unable to find an available localhost port for app preview.');
}
async function loadPlaywright() {
    const fromTest = await import('@playwright/test').catch(() => null);
    if (fromTest?.chromium)
        return fromTest;
    const fromPlaywright = await import('playwright').catch(() => null);
    if (fromPlaywright?.chromium)
        return fromPlaywright;
    throw new Error('Local preview requires Playwright. Install project dependencies with `bun install`, then rerun `orizu apps preview`.');
}
function resolveChromiumExecutablePath() {
    const candidates = [
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ].filter(Boolean);
    return candidates.find(candidate => existsSync(candidate)) || null;
}
