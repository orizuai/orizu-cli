/**
 * ORI-2609: every project of an approved team shares the team's repository,
 * but the team seed wrote only the first project's folder. A hosted session
 * for another project writes that project's folder into its own checkout at
 * boot, exactly as the team seed would have, and commits it locally. The
 * session's normal save carries the commit; nothing is pushed here.
 *
 * A folder that is already there, whole or partial, is never touched, so a
 * second session never duplicates or overwrites one. Never throws: a seed
 * failure is reported for the boot to log, and the session still starts.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  buildSeedContractFiles,
  SEED_COMMIT_AUTHOR_EMAIL,
  SEED_COMMIT_AUTHOR_NAME,
  SEED_COMMIT_DATE,
} from './workspace-bootstrap-seed.js'

export interface ProjectFolderSeedProject {
  id: string | null
  slug: string | null
  name: string | null
}

type SeedExec = (cmd: string, args: string[]) => { status: number; stdout: string; stderr: string }

// One plain folder name: no separators, no traversal, no leading dot or dash.
const SAFE_PROJECT_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function readTeamFacts(workTree: string): { id: string; slug: string } {
  // The team manifest the team seed wrote is the source of the team facts, so
  // the new project's manifest agrees with the repository it lands in.
  const manifest = JSON.parse(readFileSync(join(workTree, 'orizu.team.json'), 'utf8')) as Record<string, unknown>
  if (typeof manifest.slug !== 'string' || manifest.slug.length === 0) {
    throw new Error('orizu.team.json carries no team slug')
  }
  // The team id does not appear in project files; it is passed for completeness.
  return { id: typeof manifest.teamId === 'string' ? manifest.teamId : '', slug: manifest.slug }
}

/** Returns the one line the boot logs. */
export function seedProjectFolder(input: {
  workTree: string
  project: ProjectFolderSeedProject
  exec: SeedExec
}): string {
  const { workTree, project, exec } = input
  if (!project.id) return 'project folder skipped: the session names no project'
  // Without the slug there is no folder name; the server leaves it out when it
  // could not read the project.
  if (!project.slug) return 'project folder skipped: the server sent no project slug'
  try {
    const slug = project.slug
    if (!SAFE_PROJECT_SLUG.test(slug)) throw new Error('the project slug is not a plain folder name')
    const folder = `projects/${slug}`
    const projectsDir = join(workTree, 'projects')
    if (existsSync(projectsDir) && !lstatSync(projectsDir).isDirectory()) {
      throw new Error('projects/ is not a folder')
    }
    if (existsSync(join(workTree, folder))) return `project folder ${folder}/ already present`

    // Byte-for-byte the files the team seed writes for this project.
    const files = buildSeedContractFiles({
      team: readTeamFacts(workTree),
      projects: [{ id: project.id, slug, name: project.name }],
    }).filter(file => file.path.startsWith(`${folder}/`))
    for (const file of files) {
      const target = join(workTree, file.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.bytes, { mode: 0o644 })
    }
    // No hook the checkout's config names runs inside the boot (as in harvest).
    // The exec seam takes no `env` option, so `env` pins the commit dates.
    const git = (step: string, ...args: string[]) => {
      const result = exec('env', [
        `GIT_AUTHOR_DATE=${SEED_COMMIT_DATE}`, `GIT_COMMITTER_DATE=${SEED_COMMIT_DATE}`,
        'git', '-C', workTree, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args,
      ])
      if (result.status !== 0) throw new Error(`git ${step} failed: ${(result.stderr || result.stdout).trim()}`)
    }
    git('add', 'add', '--', folder)
    // Paths after `--` commit only this folder, whatever else is staged. A fixed
    // author, committer and date make every session that starts from the same
    // team head produce the same commit, so two sessions' publishes share it
    // rather than conflict on files neither of them touched.
    git('commit', '-c', 'commit.gpgsign=false', '-c', `user.name=${SEED_COMMIT_AUTHOR_NAME}`, '-c', `user.email=${SEED_COMMIT_AUTHOR_EMAIL}`,
      'commit', '--quiet', '--no-verify', '-m', `Add the ${slug} project folder`, '--', folder)
    return `project folder ${folder}/ seeded`
  } catch (error) {
    return `project folder seed failed: ${error instanceof Error ? error.message : String(error)}`
  }
}
