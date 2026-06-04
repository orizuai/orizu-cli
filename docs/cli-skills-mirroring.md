# CLI + Skills Mirroring and Release

This repo remains the source of truth.
External users consume:
- Single mirror repo (for CLI source, skills, and release tags)
- npm package `orizu`

## Workflows

- `.github/workflows/validate-skills.yml`
  - Validates each folder under `skills/` has a valid `SKILL.md` frontmatter.
- `.github/workflows/sync-cli-and-skills.yml`
  - Mirrors `packages/cli`, `packages/orizu-gepa-python`, `skills`, and CLI docs to one mirror repo `main`.
- `.github/workflows/publish-cli.yml`
  - Triggered by tags matching `cli-vX.Y.Z` (or manual dispatch).
  - Sets `packages/cli/package.json` version from the release tag at publish time.
  - Verifies checked-in CLI build artifacts.
  - Vendors `packages/orizu-gepa-python` into the CLI package during `npm publish`.
  - Publishes `packages/cli` to npm.
  - Pushes `vX.Y.Z` tag to mirror repo.

## Required Repository Secrets

Set these in this source repo:
- `MIRROR_PUSH_TOKEN`: PAT with push access to mirror repo.
- `MIRROR_REPO`: `<owner>/<repo>` for mirror (example: `your-org/orizu-cli`).
- `NPM_TOKEN`: npm automation token for publishing `orizu`.

## Release Process

1. Merge to `main` (auto-sync mirrors runs).
2. Create tag:
   ```bash
   git tag cli-v0.0.3
   git push origin cli-v0.0.3
   ```
3. `publish-cli.yml` publishes npm and pushes `v0.0.3` to CLI mirror.
4. Verify the published CLI surface:
   ```bash
   npx orizu --help
   ```
   Confirm the published help output includes:
   - `tasks create --assignees <userIdOrEmail1,userIdOrEmail2>`
   - dataset mutation commands: `append`, `edit-rows`, `delete-rows`, `lock`, and `clone`

## Post-Publish Operator Checks

- Run `npx orizu --help` and confirm the published package matches the repo command surface.
- Run `orizu teams members list --team <team>` and confirm the table shows `MEMBER ID`, `USER ID`, `EMAIL`, and `ROLE`.
- Run `orizu tasks create --assignees <email-or-user-id>` and confirm task creation still stores canonical user IDs server-side.

## External Consumption

- CLI:
  ```bash
  npx orizu --help
  ```
- Skills:
  ```bash
  npx skills add <owner>/<mirror-repo>
  ```
