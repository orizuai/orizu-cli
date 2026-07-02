# CLI + Skills Mirroring and Release

This repo remains the source of truth.
External users consume:
- Single mirror repo (for CLI source, skills, plugin packages, marketplace
  catalogs, and release tags)
- npm package `orizu`, which bundles the `orizu-cli` skill for local install
- Codex and Claude Code plugin packages under `plugins/`, installable from the
  mirror repo's marketplace catalogs (`.agents/plugins/marketplace.json` for
  Codex, `.claude-plugin/marketplace.json` for Claude Code)

## Workflows

- `.github/workflows/validate-skills.yml`
  - Validates each folder under `skills/` has a valid `SKILL.md` frontmatter.
- `.github/workflows/validate-plugins.yml`
  - Validates plugin manifests, marketplace catalogs, and that committed
    plugin skill bundles match `skills/orizu-cli` (`bun run plugins:validate`).
- `.github/workflows/sync-cli-and-skills.yml`
  - Mirrors `packages/cli`, `packages/orizu-gepa-python`, `skills`,
    `plugins`, the marketplace catalogs, plugin scripts, and CLI docs to one
    mirror repo `main` (after skills and plugins validate).
- `.github/workflows/publish-cli.yml`
  - Triggered by tags matching `cli-vX.Y.Z` (or manual dispatch).
  - Sets `packages/cli/package.json` version from the release tag at publish time.
  - Verifies checked-in CLI build artifacts.
  - Vendors `packages/orizu-gepa-python` into the CLI package during `npm publish`.
  - Vendors `skills/orizu-cli` into the CLI package during `npm publish`.
  - Publishes `packages/cli` to npm.
  - Pushes `vX.Y.Z` tag to mirror repo.

## Required Repository Secrets

Set these in this source repo:
- `MIRROR_PUSH_TOKEN`: PAT with push access to mirror repo.
- `MIRROR_REPO`: `<owner>/<repo>` for mirror (example: `your-org/orizu-cli`).
- `NPM_TOKEN`: npm automation token for publishing `orizu`.

## Release Process

For plugin releases (Codex / Claude Code packages), follow
`docs/plugin-release-playbook.md` — CLI first, then regenerate plugin bundles.

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
   npx orizu install-skill --help
   npx orizu capabilities --json
   ```
   Confirm the published help output includes:
   - `install-skill [--target <target>]`
   - `tasks create --project <team/project> --dataset <datasetId> --app <appId> --title <title> [--assignees <userIdOrEmail1,userIdOrEmail2>] [--publish]`
   - `tasks publish --task <taskId> --assignees <userId1,userId2>`
   - `tasks report set --task <taskId>`
   - dataset mutation commands: `append`, `edit-rows`, `delete-rows`, `lock`, and `clone`

## Post-Publish Operator Checks

- Run `npx orizu --help` and confirm the published package matches the repo command surface.
- Run `npx orizu install-skill --target codex-user --dry-run` and confirm the bundled skill resolves from the npm package.
- Run `orizu teams members list --team <team>` and confirm the table shows `MEMBER ID`, `USER ID`, `EMAIL`, and `ROLE`.
- Run `orizu tasks create ...` without `--publish` and confirm it creates a draft with a task URL and manual-test guidance.
- Run `orizu tasks create ... --publish --assignees <email-or-user-id>` and confirm immediate publish still stores canonical user IDs server-side.
- Run `orizu tasks publish --task <taskId> --assignees <userId1,userId2>` and confirm an approved draft becomes active.

## External Consumption

- CLI:
  ```bash
  npx orizu --help
  ```
- Skills:
  ```bash
  npx orizu install-skill --target codex-user --yes
  ```

The mirror still publishes the raw `skills/` tree for users who want to inspect
or install skills manually, but the first-party CLI install command is the
primary supported path.
