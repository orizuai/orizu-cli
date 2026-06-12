# Orizu Codex Plugin

First-class Codex distribution of the Orizu agent workflow skill. The plugin is
a thin native distribution layer over the Orizu CLI runtime: it bundles the
shared `orizu-cli` skill and presentation metadata, and nothing else. Scoring,
runners, optimizers, auth, and cloud sandbox logic live in the `orizu` npm CLI.

## Requirements

The plugin expects the Orizu CLI to be available:

```bash
npm i -g orizu
orizu login
```

If `orizu` is missing or outdated, follow the skill's prerequisites section or
run `npx orizu setup`.

## Install

From the public repo (or a local checkout — pass the path instead of
`<owner>/<repo>`):

```bash
codex plugin marketplace add <owner>/<repo>
codex plugin add orizu@orizu-plugins
```

Codex discovers the marketplace at `.agents/plugins/marketplace.json`, which
points at this plugin directory. Note the `<plugin>@<marketplace>` form —
`codex plugin add orizu` alone is rejected without `--marketplace`.

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
