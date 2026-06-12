# Orizu Claude Code Plugin

First-class Claude Code distribution of the Orizu agent workflow skill. The
plugin is a thin native distribution layer over the Orizu CLI runtime: it
bundles the shared `orizu-cli` skill (namespaced as `orizu:orizu-cli`) and
plugin metadata, and nothing else. Scoring, runners, optimizers, auth, and
cloud sandbox logic live in the `orizu` npm CLI.

## Requirements

The plugin expects the Orizu CLI to be available:

```bash
npm i -g orizu
orizu login
```

If `orizu` is missing or outdated, follow the skill's prerequisites section or
run `npx orizu setup`.

## Local development install

```bash
claude --plugin-dir /path/to/repo/plugins/claude-code
```

Then use `/plugin` to inspect it, and `/reload-plugins` after edits. To install
from the repo as a marketplace instead:

```bash
/plugin marketplace add <owner>/<public-repo>
/plugin install orizu@orizu
```

Validate the package with `claude plugin validate plugins/claude-code` (or the
closest available validation command in your Claude Code version).

## Regenerating bundled content

`skills/orizu-cli/` is generated from the repo's shared `skills/orizu-cli`
source — do not edit it here. To refresh after skill or CLI changes:

```bash
bun run plugins:build
bun run plugins:validate
```

CI fails if the bundled skill drifts from the shared source. The bundle's
`.orizu-skill-meta.json` records the skill content hash and compatible CLI
version for drift detection.
