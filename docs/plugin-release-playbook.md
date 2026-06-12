# Plugin Release Playbook

Repeatable release process for the Orizu npm CLI and the Codex / Claude Code
plugin packages. Companion to `docs/plugins/capability-matrix.md` (runtime
boundary) and `docs/cli-skills-mirroring.md` (mirror mechanics).

## Mental model

The CLI is the runtime; the skill teaches agents to use it; plugins are
distribution. Releases therefore flow in one direction:

```
packages/cli (npm)  →  skills/orizu-cli  →  plugins/*  →  mirror repo (marketplaces)
```

Never release a plugin bundle generated against an unreleased CLI version.

## Release sequence

1. **Release the CLI** (when CLI/skill changed)
   1. Land changes on `main`; `sync-cli-and-skills.yml` mirrors source.
   2. Bump `packages/cli/package.json` version and tag `cli-vX.Y.Z`;
      `publish-cli.yml` publishes to npm (prepack vendors the skill) and
      mirrors the tag.
2. **Regenerate plugin bundles**
   1. `bun run plugins:build` — re-vendors `skills/orizu-cli` into both plugin
      roots and stamps `.orizu-skill-meta.json` with the new skill hash and
      CLI version.
   2. Bump each plugin manifest `version` when bundle content changed
      (`plugins/*/.codex-plugin/plugin.json`, `plugins/*/.claude-plugin/plugin.json`)
      and bump `.claude-plugin/marketplace.json` `metadata.version` to match.
   3. `bun run plugins:validate` — must pass (CI enforces this on the PR).
   4. Commit; merging to `main` mirrors `plugins/`, the marketplace catalogs,
      and `scripts/plugins/` to the public repo.
3. **Optional: pack artifacts** — `bun run plugins:pack` stages
   `dist/plugins/*.tgz` for attaching to releases. Not required for repo-based
   marketplace installs.

## Version compatibility

- `.orizu-skill-meta.json` in every bundle records `skillHash`, `cliVersion`,
  and `pluginVersion`. `plugins:validate` fails when any of the three is stale
  relative to the repo.
- At runtime, `orizu skills path --json` exposes the CLI's own `skillHash` and
  `cliVersion`; comparing against the bundle meta detects skill/plugin/CLI
  mismatch.

## Pre-release smoke tests (manual)

Run these from the public mirror repo (or this repo for local checks).

### Codex plugin

- [ ] Codex discovers the marketplace at `.agents/plugins/marketplace.json`
      and installs `orizu` from it.
- [ ] The `orizu-cli` skill is visible and triggers on an eval-related prompt.
- [ ] With `orizu` uninstalled, the skill's prerequisites route to
      `npm i -g orizu` / `npx orizu setup` instead of failing silently.
- [ ] `orizu skills path --json` hash matches the bundle's
      `.orizu-skill-meta.json` after a fresh CLI install.

### Claude Code plugin

- [ ] `claude --plugin-dir plugins/claude-code` loads the plugin; the skill
      appears namespaced (`orizu:orizu-cli`) and invokes correctly.
- [ ] `claude plugin validate plugins/claude-code` (or the closest available
      validation command) passes.
- [ ] `/plugin marketplace add <owner>/<mirror-repo>` then
      `/plugin install orizu@orizu` works from the public mirror.
- [ ] `/reload-plugins` picks up local edits during development.
- [ ] Missing/outdated CLI behaves as above.

### Setup flow

- [ ] `npx orizu@latest setup --dry-run` previews cleanly on a machine without
      credentials.
- [ ] `orizu skills status` reports `current` for fresh installs;
      `orizu skills update` refreshes after a CLI upgrade.

## Rollback

- npm: publish a patch release; do not unpublish.
- Plugins: revert the offending commit on `main`; the mirror sync force-pushes
  the corrected state. Repo-based marketplace installs pick up the fix on
  their next update.
