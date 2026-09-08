import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  buildWorkbenchRepoFiles,
  type WorkbenchRepoProjectSeed,
} from './workbench-repo-contract.js'
import { gitOk, revParse, type GitRunner } from './artifacts-git-runtime.js'

export type SeedFileMode = '100644' | '100755'

export interface SeedFile {
  path: string
  mode: SeedFileMode
  bytes: Buffer
}

export interface MaterializedArtifactFile {
  path: string
  mode: SeedFileMode
  bytes: Buffer
}

export interface MaterializedArtifact {
  repoPath: string
  files: readonly MaterializedArtifactFile[]
}

export type MaterializeArtifacts = (project: {
  id: string
  slug: string
}) => Promise<readonly MaterializedArtifact[]>

export interface BootstrapTeam {
  id: string
  slug: string
  createdAt?: string | null
}

export interface BootstrapProject {
  id: string
  slug: string
  name?: string | null
}

function assertSeedPath(path: string): void {
  const segments = path.split('/')
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        segment === '.git' ||
        segment.startsWith('-')
    )
  ) {
    throw new Error(`Unsafe seed path ${JSON.stringify(path)}`)
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function assertMaterializedArtifact(artifact: MaterializedArtifact, index: number): void {
  const where = `materialized artifact #${index}`
  if (typeof artifact?.repoPath !== 'string' || artifact.repoPath === '') {
    throw new Error(`${where} has no repoPath`)
  }
  if (!Array.isArray(artifact.files)) {
    throw new Error(`${where} (${artifact.repoPath}) has no files array`)
  }
  for (const file of artifact.files) {
    if (typeof file?.path !== 'string' || file.path === '') {
      throw new Error(`${where} (${artifact.repoPath}) has a file with no path`)
    }
    if (file.mode !== '100644' && file.mode !== '100755') {
      throw new Error(
        `${where} (${artifact.repoPath}/${file.path}) has unsupported mode ${JSON.stringify(file.mode)}`
      )
    }
    if (!Buffer.isBuffer(file.bytes)) {
      throw new Error(
        `${where} (${artifact.repoPath}/${file.path}) has non-Buffer bytes (${typeof file.bytes})`
      )
    }
  }
}

export function flattenSeedFiles(
  artifacts: readonly MaterializedArtifact[],
  contractFiles: readonly SeedFile[] = []
): SeedFile[] {
  const byPath = new Map<string, SeedFile>()
  const claim = (file: SeedFile, origin: string): void => {
    assertSeedPath(file.path)
    if (byPath.has(file.path)) {
      throw new Error(`Duplicate seed path ${file.path} (${origin})`)
    }
    byPath.set(file.path, file)
  }
  for (const file of contractFiles) claim(file, 'workbench contract')
  for (const [index, artifact] of artifacts.entries()) {
    assertMaterializedArtifact(artifact, index)
    for (const file of artifact.files) {
      claim(
        {
          path: `${artifact.repoPath}/${file.path}`,
          mode: file.mode,
          bytes: file.bytes,
        },
        'team content'
      )
    }
  }
  return [...byPath.values()].sort((left, right) => compareUtf8(left.path, right.path))
}

export function totalSeedBytes(files: readonly SeedFile[]): number {
  return files.reduce((total, file) => total + file.bytes.byteLength, 0)
}

export function formatMegabytes(bytes: number): string {
  return (bytes / 1_048_576).toFixed(2)
}

export const SEED_ADMISSION_LIMIT_BYTES = 1_073_741_824

export function assertSeedWithinAdmissionLimit(
  contentBytes: number,
  limitBytes: number = SEED_ADMISSION_LIMIT_BYTES
): void {
  if (contentBytes > limitBytes) {
    throw new Error(
      `Refusing to bootstrap: the team's content measures ${contentBytes} bytes ` +
        `(${formatMegabytes(contentBytes)} MB), which exceeds the ${limitBytes}-byte ` +
        `(${formatMegabytes(limitBytes)} MB) admission limit recorded in ADR-011 and ` +
        'ADR-012. Raising it requires a reviewed envelope increase in a superseding ADR.'
    )
  }
}

const STAGE_PATHSPEC_CHUNK = 200
export const SEED_COMMIT_AUTHOR_NAME = 'Orizu Workbench Bootstrap'
export const SEED_COMMIT_AUTHOR_EMAIL = 'workbench-bootstrap@orizu.invalid'
export const SEED_COMMIT_INSTANT = '2020-01-01T00:00:00.000Z'
export const SEED_COMMIT_DATE = new Date(SEED_COMMIT_INSTANT)
  .toISOString()
  .replace(/\.\d{3}Z$/, '+0000')
export const SEED_CONTRACT_CREATED_AT = SEED_COMMIT_INSTANT

export function buildSeedContractFiles(input: {
  team: BootstrapTeam
  projects: readonly BootstrapProject[]
}): SeedFile[] {
  const projects: WorkbenchRepoProjectSeed[] = input.projects.map((project) => ({
    slug: project.slug,
    id: project.id,
    name: project.name ?? null,
  }))
  const rendered = buildWorkbenchRepoFiles(
    {
      teamSlug: input.team.slug,
      teamId: input.team.id,
      createdBy: 'orizu bootstrap-team-artifacts-repo',
      createdAt: input.team.createdAt ?? SEED_CONTRACT_CREATED_AT,
      projects,
    },
    { projectSlugMode: 'validated-raw' }
  )
  return rendered.map((file) => ({
    path: file.path,
    mode: '100644' as const,
    bytes: Buffer.from(file.content, 'utf8'),
  }))
}

export async function buildSeedWorktree(input: {
  runGit: GitRunner
  worktree: string
  files: readonly SeedFile[]
  commitMessage: string
}): Promise<string> {
  const { runGit, worktree, files } = input
  await mkdir(worktree, { recursive: true, mode: 0o700 })
  await gitOk(runGit, ['init', '-b', 'main'], { cwd: worktree }, 'git init')
  await gitOk(
    runGit,
    ['config', 'user.name', SEED_COMMIT_AUTHOR_NAME],
    { cwd: worktree },
    'git configure user name'
  )
  await gitOk(
    runGit,
    ['config', 'user.email', SEED_COMMIT_AUTHOR_EMAIL],
    { cwd: worktree },
    'git configure user email'
  )
  for (const file of files) {
    assertSeedPath(file.path)
    const destination = join(worktree, file.path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, file.bytes, {
      mode: file.mode === '100755' ? 0o755 : 0o644,
    })
  }
  for (let index = 0; index < files.length; index += STAGE_PATHSPEC_CHUNK) {
    const chunk = files.slice(index, index + STAGE_PATHSPEC_CHUNK)
    await gitOk(
      runGit,
      ['add', '--force', '--', ...chunk.map((file) => `:(literal)${file.path}`)],
      { cwd: worktree },
      'stage team artifact seed'
    )
  }
  await gitOk(
    runGit,
    ['commit', '--allow-empty', '-m', input.commitMessage],
    {
      cwd: worktree,
      commitIdentityEnv: {
        GIT_AUTHOR_NAME: SEED_COMMIT_AUTHOR_NAME,
        GIT_AUTHOR_EMAIL: SEED_COMMIT_AUTHOR_EMAIL,
        GIT_AUTHOR_DATE: SEED_COMMIT_DATE,
        GIT_COMMITTER_NAME: SEED_COMMIT_AUTHOR_NAME,
        GIT_COMMITTER_EMAIL: SEED_COMMIT_AUTHOR_EMAIL,
        GIT_COMMITTER_DATE: SEED_COMMIT_DATE,
      },
    },
    'commit team artifact seed'
  )
  await assertCommitMatchesSeed(runGit, worktree, files)
  return revParse(runGit, worktree, 'HEAD')
}

export function gitBlobId(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
}

async function assertCommitMatchesSeed(
  runGit: GitRunner,
  worktree: string,
  files: readonly SeedFile[],
  what = 'seed commit'
): Promise<void> {
  const listed = await gitOk(
    runGit,
    ['ls-tree', '-r', '-z', 'HEAD'],
    { cwd: worktree },
    'list the committed seed tree'
  )
  const committed = new Map<string, string>()
  for (const entry of listed.split('\0')) {
    if (!entry) continue
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    const [mode, , objectId] = entry.slice(0, tab).split(' ')
    committed.set(entry.slice(tab + 1), `${mode} ${objectId}`)
  }
  const expected = new Map(
    files.map((file) => [file.path, `${file.mode} ${gitBlobId(file.bytes)}`])
  )
  const missing = [...expected.keys()].filter((path) => !committed.has(path))
  if (missing.length > 0) {
    throw new Error(
      `The ${what} is missing ${missing.length} of ${expected.size} file(s) — ` +
        `refusing to create a permanent repository from an incomplete seed. ` +
        `First: ${missing.slice(0, 5).join(', ')}`
    )
  }
  const stray = [...committed.keys()].filter((path) => !expected.has(path))
  if (stray.length > 0) {
    throw new Error(
      `The ${what} contains ${stray.length} file(s) that are not team content: ` +
        `${stray.slice(0, 5).join(', ')}`
    )
  }
  for (const [path, objectId] of expected) {
    if (committed.get(path) !== objectId) {
      throw new Error(
        `The ${what} does not match ${path} (expected ${objectId}, found ${committed.get(path)}) — ` +
          'refusing to publish content that does not match the database.'
      )
    }
  }
}

export async function verifySeedClone(input: {
  runGit: GitRunner
  cloneDir: string
  files: readonly SeedFile[]
  expectedSha: string
}): Promise<void> {
  const head = await revParse(input.runGit, input.cloneDir, 'HEAD')
  if (head !== input.expectedSha) {
    throw new Error(
      `Verification clone HEAD ${head} does not match the recorded seed commit ${input.expectedSha}`
    )
  }
  await assertCommitMatchesSeed(input.runGit, input.cloneDir, input.files, 'verification clone')
}

export const SEED_PUSH_TIMEOUT_MS = 1_800_000
export const VERIFICATION_CLONE_TIMEOUT_MS = 1_800_000

export interface SyntheticWorkspaceSeed {
  team: { id: string; slug: string }
  project: { id: string; slug: string; name: string | null }
}

/** Fixed synthetic content only. Never reads a customer directory or hydrates
 * database artifacts; identifiers have already passed the admission boundary. */
export function buildSyntheticWorkspaceSeed(input: SyntheticWorkspaceSeed): SeedFile[] {
  return flattenSeedFiles(
    [
      {
        repoPath: `projects/${input.project.slug}`,
        files: [
          {
            path: 'context.md',
            mode: '100644',
            bytes: Buffer.from(
              '# Synthetic hosted workspace\n\n' +
                'This project contains fictional examples for the internal hosted workspace pilot.\n' +
                'Read README.md for the project entry point and use `orizu --help` for available tools.\n' +
                'Create reusable helpers in scripts/. Keep credentials, downloaded data and conversation state out of shared files.\n' +
                'Sharing files does not promote instructions or alter serving pointers.\n'
            ),
          },
          {
            path: 'examples/synthetic-cases.jsonl',
            mode: '100644',
            bytes: Buffer.from(
              '{"input":"Hello","expected":"greeting"}\n' +
                '{"input":"Thanks","expected":"gratitude"}\n' +
                '{"input":"Goodbye","expected":"farewell"}\n'
            ),
          },
        ],
      },
    ],
    buildSeedContractFiles({ team: input.team, projects: [input.project] })
  )
}
