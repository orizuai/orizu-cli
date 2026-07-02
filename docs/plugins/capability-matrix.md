# Plugin Capability Matrix and CLI Runtime Boundary

Decision record for ALI-837. Referenced by the Codex plugin (`plugins/codex`),
the Claude Code plugin (`plugins/claude-code`), validation scripts, and the
release playbook.

## Runtime boundary

- **The Orizu CLI (`orizu` on npm) is the runtime and source of truth.** It
  owns auth, local scorers, runners, optimizers, score submission, cloud
  sandbox handoff, and the stable command/API contract
  (`orizu capabilities --json`).
- **The shared skill (`skills/orizu-cli`) is the agent workflow layer.** It
  teaches an agent how to use the CLI and how to reason through repo-specific
  Orizu adoption.
- **Plugins are thin native distribution/adaptation layers.** They improve
  install/update/discovery and namespacing through each host's plugin surface.
  A plugin may wrap or invoke `orizu`; it must never fork or re-implement
  scorer, runner, optimizer, auth, or cloud sandbox runtime logic.
- **Plugins do not enforce the installed CLI binary at runtime.** The packaged
  skill must verify `orizu --version` and `orizu capabilities --json` before
  doing real work.

## Capability matrix

| Capability | CLI + skill | Codex plugin | Claude Code plugin |
| --- | --- | --- | --- |
| Skill distribution | v1 — `orizu install-skill` copy/link | v1 — bundled `skills/orizu-cli` | v1 — bundled, namespaced `orizu:orizu-cli` |
| Install/update lifecycle | v1 — `skills status` / `skills update` | v1 — host plugin install/update | v1 — host plugin install/update, `/reload-plugins` |
| Marketplace / catalog | n/a (npm) | v1 — `.agents/plugins/marketplace.json` (repo/local) | v1 — `.claude-plugin/marketplace.json` (repo) |
| Namespacing | n/a | v1 — plugin-scoped skill | v1 — plugin-scoped skill |
| Read-only skill discovery | v1 — `orizu skills path --json` | inherits CLI | inherits CLI |
| Version/hash compatibility checks | v1 — `.orizu-skill-meta.json` + `skills status` | v1 — bundle meta validated in CI | v1 — bundle meta validated in CI |
| Install-surface metadata (icon, brand, prompts) | n/a | v1 — `interface` object | later — marketplace entry metadata only |
| MCP server | out of scope (separate project if scoped) | later — revisit if an Orizu MCP server ships | later — same trigger |
| Hooks | not planned | later — revisit when a workflow needs event-driven CLI calls (e.g. auto-score on test runs) | later — same trigger |
| Custom agents / subagents | not planned | later — revisit if SKILL.md guidance proves insufficient for multi-step eval workflows | later — same trigger |
| Apps / connectors | not planned | later — revisit alongside MCP decision | n/a |
| Plugin-provided executables (`bin/`) | n/a (CLI is the executable) | out of scope — would duplicate the runtime | out of scope — same reason |
| Settings / LSP / background monitors | n/a | not planned | later — revisit only with a concrete workflow need |

"Later" items stay deferred until their named trigger occurs; they are not a
standing backlog.

## Plugin-to-CLI contract

- Plugins resolve `orizu` via `PATH` (global install) or `npx orizu`.
- The bundled skill's prerequisites instruct the agent to verify the CLI
  (`orizu --version`, `orizu capabilities --json`) before workflows, and route
  missing/outdated installs to `npm i -g orizu` and `npx orizu setup`.
- Plugin installation/update improves distribution and discoverability, but it
  does not by itself prove the user's local `orizu` binary is present or current.
- Each bundled skill carries `.orizu-skill-meta.json` with the skill content
  hash (same algorithm as `computeSkillContentHash` in
  `packages/cli/src/skill-installer.ts`), the CLI version the bundle was
  generated against, and the plugin version. `scripts/plugins/validate.mjs`
  fails CI when a bundle drifts from `skills/orizu-cli`, the current CLI
  version, or the plugin manifest version.
- Skill/plugin/CLI mismatch at runtime is detected by comparing
  `orizu skills path --json` (`skillHash`, `cliVersion`) against the bundle's
  meta file.

## Release coupling

Release the CLI runtime first, then regenerate plugin bundles
(`bun run plugins:build`) so bundle metadata declares the CLI version it was
built against. See the release playbook in
`docs/plugin-release-playbook.md` (Phase 7).
