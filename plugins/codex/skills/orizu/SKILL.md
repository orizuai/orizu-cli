---
name: orizu
description: Use when the user mentions Orizu; wants measurable improvement for a specific LLM application or agent; collects human feedback on model outputs or turns failures into evals; validates judges; optimizes instruction sets; migrates an existing GEPA setup; or establishes continuous improvement. Step aside and handle directly generic instruction-writing theory or one-off edits the user explicitly will not validate with evals.
---

# Orizu

Orizu improves LLM applications with an evals-first workflow, then optimizes against the resulting evidence. Use `orizu instructions` as the primary path for customer instruction sets. Follow the applicable J0–J6 path in order and satisfy each applicable exit criterion; J4 is conditional on missing approved ground truth. Read `references/primer.md` for the methodology and `references/cli-reference.md` for the current command surface instead of relying on remembered commands.

The journey uses **datasets** for versioned rows, **apps** and **tasks** for labels, **judges**, **runners**, and **scorers** for automated evaluation, **instruction sets** for customer instruction work, and **optimization runs** for searching profile candidates.

## Critical: scorer-runner input contract

A judge runner built for flat rows will silently score every candidate 0 unless `flat_row` is selected by `--scorer-input-contract` or the runner manifest and, when needed, the candidate field is selected by flag or manifest.

# Vocabulary

Read `references/vocabulary.md` for the canonical Orizu workflow and method vocabulary.

# Journey

## J0 — Discover & evaluate

- Before installation, explain what Orizu does, inspect only the context the user has supplied, and give an honest fit assessment for the user's LLM application.
- Recommend adoption when repeated iteration would benefit from measurable evaluations. Step aside for generic instruction-writing theory or a one-off edit the user explicitly will not validate with evals.

**Exit criterion:** The human has the fit assessment and makes the adoption decision.

## J1 — Install & set up

- For local use, install Node.js 20+, run `npm i -g orizu`, then run `orizu setup` so browser login, the workbench, and skill links are initialized. The callback defaults to `127.0.0.1:43123`; after a collision, set `ORIZU_AUTH_PORT` to an available port from 1024–65535.
- Verify auth and runtime with `orizu whoami --json` and `orizu capabilities --json`. Verify skill installation and sync separately with `orizu skills status --json`; use `orizu skills update` if stale. Follow the Authority map for surface-specific setup.
- Establish the team and project with the user's naming choices as directed by the Authority map. Projects live inside teams.
- Browser login creates a user-owned personal access token. The server/UI cannot redisplay the raw token after issuance, but the local v3 credential retains it for CLI auth. The token inherits current access and loses access when the user's role or membership changes.

**Exit criterion:** The team and project exist; the skill is verified in sync by `orizu skills status` locally, or shipped and present in a hosted session; and both `orizu whoami` and `orizu capabilities` succeed.

## J2 — Assess & plan

- Read `references/assess-and-plan.md` and follow its survey, decision, conversation, and persistence workflow before moving any data.

**Exit criterion:** A human-ratified `improvement-plan.md` is committed at the plain-repo root or at `projects/<directorySlug>/improvement-plan.md` in a workbench; there, it and its `memory.md` pointer are committed together.

## J3 — Build the dataset

- Follow `references/dataset-design.md` for the ratified source choice, scenario-class coverage, three-way split and mini-batch design, the reserved final-held-out comparison split, versioning, and the pre-annotation mutation guard.

**Exit criterion:** The primary dataset's immutable version and split set cover every scenario class; golden ground truth shortcuts J4 only, while any annotation dataset is versioned, locked, and ready for labeling.

## J4 — Ground truth via annotation (conditional)

- Follow `references/eval-strategy.md` for the annotation decision, guided eval strategy, labeler-validation gate, task-version pin, and completeness check.

**Exit criterion:** Golden ground truth is recorded as the reason annotation was skipped, or labels are exported and the approved task report is published.

## J5 — Build & validate judges

- Build automated evaluators from the ground truth: use code assertions for deterministic rules and LLM judges only for nuanced criteria. A 100% pass rate is a saturation warning, not proof that the evaluator is useful.
- Validate against judge-test human labels. Track TPR and TNR per failure mode, and use Cohen's kappa alongside raw agreement when establishing the judge trust bar with the user for the decision it powers.
- Store the versioned judge and runner, then register the row or set scorer that defines how its output is displayed, compared, and used. GEPA reflection needs a row-mode scorer because it consumes per-row feedback.
- Read `references/building-judges.md` for judge trust bar agreement, submitted alignment evidence, and judge optimization; its agreed judge trust bars govern over older fixed defaults. Read `references/prompt-control-plane.md` for artifact contracts.

**Exit criterion:** Every gating judge clears its agreed judge trust bar; its scorers are registered; `runners exec` evidence, `scores submit`, and a measured `scorers exec` run are submitted; and the agent hands `orizu scores accept <score-run-id>` to a human curator, whose acceptance is required before gating decisions.

## J6 — Optimize & promote

- Optimize only against validated judges. Package candidate execution as a runner and run the optimizer against registered scorers. After selection, run one final comparison of the selected candidate against the seed on the final-held-out partition, with per-failure-mode results.
- Use `orizu instructions` for the instruction set. Each run targets one model-config profile and treats its complete component map as the candidate; promotion never moves one component independently.
- Inspect the local run logs when available, otherwise export the run. Write and attach a markdown report using `references/optimization-reports.md`; the report should explain candidate tradeoffs and regressions clearly enough for the human to make the promotion decision.

Bundled `run-gepa` flag behavior and execution semantics live in `references/optimization-with-gepa.md`.
Read that reference before configuring a run; keep this journey focused on workflow and exit criteria.

For a hosted GEPA launch, follow the eligibility, refusal, retry, and monitor
contract in `references/optimization-with-gepa.md`; surface its remediation
unchanged and treat queued as accepted rather than complete.

**Exit criterion:** The human has made a promotion decision from the optimization report; if shipping, the new profile version is live.

# Improve continuously

- Feed improved-system traces into a new dataset version and repeat from dataset building. Each report should recommend the next scenario classes or failure modes to investigate.
- Propose a cadence for fresh-trace collection, evaluation, and optimization; set it up only after the user agrees, then complete the first cycle.

The loop is established when a cadence is agreed and its first cycle is complete, with new data feeding the next J3 dataset version.

# Reference index

- `references/vocabulary.md` — canonical workflow and method vocabulary.
- `references/primer.md` — end-to-end evals-first methodology.
- `references/assess-and-plan.md` — codebase survey, user-owned decisions, plan conversation, and durable J2 artifact.
- `references/cli-reference.md` — current CLI command surface.
- `references/dataset-design.md` — golden-data import, scenario-class coverage, splits, and versioning.
- `references/eval-strategy.md` — annotation decision, eval strategy, and labeler validation before task publish.
- `references/building-apps.md` — labeler contract, design, patterns, preview, and smoke test.
- `references/building-judges.md` — judge/scorer authoring and alignment validation.
- `references/prompt-control-plane.md` — artifact contracts, score submission, optimizer behavior, and promotion endpoints.
- `references/optimization-with-gepa.md` — GEPA workflow and optional DSPy context.
- `references/migrate-existing-gepa-setup.md` — migration ending in scorer parity before optimization.
- `references/optimization-reports.md` — report structure and interpretation guidance.
- `references/instructions-after-prompts.md` — prompts-era compatibility, including the remaining session-scoped read surface; read before changing legacy material.
- `scripts/test-app.mjs` — plain-Node app contract smoke test.

# Execution facts

- `--json` may appear before or after a command. Non-streaming commands emit one JSON document, with long-running summaries on the final stdout line; streaming `orizu run tail --json` instead emits JSONL, one event object per line.
- Task creation is draft-first; publish only after the returned task URL has been tested and approved. Both `--assignees` and assignment-file rows accept user IDs or member emails.
- Dataset locks reject append, edit, and delete-row mutations, but whole-dataset deletion does not check the lock. `datasets edit-rows --file` requires every row to carry a non-empty string `id`.

# Authority map

This is the single source of truth for who runs each action. Replace placeholders with resolved values before giving a hand-off. The full per-role matrix is `docs/authorization-matrix.md`.

| Surface | Work | Agent runs | Human role or exact hand-off |
| --- | --- | --- | --- |
| All surfaces | Resolve state | Query Orizu for instruction-set defaults, profile production pointers, scorer/runner pointers, version lineage, score runs, optimization runs, and report history; for example, `orizu instructions list --project <team/project>`, `orizu instructions show <set> --project <team/project>`, and `orizu runs ...`. | Orizu is the source of truth for this state. |
| All surfaces | Edit files | Edit and commit source, configs, `App.tsx`, schemas, and local traces under `logs/<run-id>` in the repo working set. | Repo files are not canonical pointer or run state. |
| Local agent under the user's token | Workflow | Survey the customer codebase, resolve state, prepare the plan, files, manifests, diffs, and evidence, then ask the human to ratify the workflow design. | The human moments are plan ratification and execution of all production/default pointer moves. |
| Local agent under the user's token | Catalog mutations and pointer preparation | After plan ratification, pull instruction material from the customer codebase and run `orizu instructions create <manifest> --project <team/project>`, `orizu instructions push <manifest> --project <team/project> --set <slug-or-exact-name>`, shape add/remove, archive/restore itself under the user's token. For pointer changes, gather only read-only resolution and binding evidence, prepare the exact commands, then hand them off. | Per the Micro-round 3 custody ruling, a human admin or curator using a user token executes every runner default-label move, optimizer-label move, scorer production-label move, profile promote/rollback, default move, and labeled optimization promotion on every surface. |
| Hosted session | Start and scope | Use the pre-authenticated CLI from `ORIZU_TOKEN_FILE` and `ORIZU_BASE_URL`; resolve only the session's signed team with `orizu teams list`, then list or create projects only within it. Run `orizu projects create --name "<project name>" --team <signed-team>` when needed. | Team creation is platform-enforced human-only. Hand off: `orizu teams create --name "<team name>"`, then ask the human to start a new hosted session scoped to that team; the current session cannot switch teams. |
| Hosted session | Team-wide curator work | While the hosted session is active and its kill switch is clear, perform setup plus ordinary curator reads and writes within the signed team. Run `orizu instructions profiles new <set> --project <team/project> --model-config <identity>` and `orizu instructions sync <set> --out <dir> --project <team/project>`. For git-canonical judges, scorers, runners, and optimizers, write with `--session <session-id>`, keep bytes as commits on the session branch, then verify with `git ls-files <path>` and inspect the commit. | The agent executes this work; an Orizu version id alone is not proof of committed bytes. Signed-project exceptions are in the next row. |
| Hosted session | Signed-project work | Run optimization mutations only for the JWT's project, keep git-canonical draft writes on that session and project, and read diff comments only for that project. | Sibling-project optimization mutations, draft writes, and diff-comment reads are out of scope even where ordinary curator access is team-wide. |
| Hosted session | Materialize an instruction set | When the survey finds only a candidate seed, turn it into the complete manifest. | ADR-008 requires a human curator using a local CLI user token. Create/push are hosted CLI route-enforced; direct RPC remains agent-writable and is a fix-forward gap. Hand off `orizu instructions create <manifest> --project <team/project>` for a fresh set, or `orizu instructions push <manifest> --project <team/project> --set <slug-or-exact-name>` for an existing set. Their measured 403 is `Sessionless registration is not available to the hosted agent: this artifact class is git-canonical (ADR-007) and its bytes must be committed to the session branch. Re-run with --session <session-id>.` Neither create nor push accepts `--session`. |
| Hosted session | Profiles and component shape | Run `orizu instructions profiles new <set> --project <team/project> --model-config <identity>`, `orizu instructions shape add <set> --project <team/project> --key <key> --from <manifest>`, and `orizu instructions shape remove <set> --project <team/project> --key <key>` with team-scoped curator authority. Shape changes create unpromoted profile heads and do not move pointers. | A human admin or curator with `can_manage_project` runs every profile promote/rollback, instruction-set default move, and other production/default pointer move. |
| Hosted session | Instruction-set visibility | Prepare the requested visibility change. | A human admin or curator with `can_manage_project` runs `orizu instructions archive <slug-or-exact-name> --project <team/project>` or `orizu instructions restore <slug-or-exact-name> --project <team/project>`. Hosted CLI route enforcement returns `Agent sessions cannot perform this action`; direct RPC remains agent-writable. |
| Hosted session | Instruction scorers | Run `orizu instructions scorers set-headline <set> --key <component-key> --scorer-version <id> --project <team/project>` and `orizu instructions scorers add <set> --key <component-key> --scorer-version <id> --project <team/project>`; prepare scorer-pointer evidence. | A human admin or curator with `can_manage_project` runs `orizu scorers labels set <scorer-name> production --version <scorer-version-id> --project <team/project>`. The measured 403 is `Agents cannot move scorer labels; labels are human-only pointers. Propose the label change as a promotion manifest for a human to apply.` |
| Hosted session | Promotion | After report acceptance, the two-stage path materializes once with unlabeled `orizu optimizations promote <run-id> --candidate <id> --project <team/project>`; hand the exact run id, candidate id, project, and report evidence to the human. | For the staged path, a human admin or curator with `can_manage_project` re-runs the same promotion as `orizu optimizations promote <run-id> --candidate <id> --label production --project <team/project>`. The idempotent finalizer finds the existing version by run and candidate provenance, moves production to that exact materialized version, and creates no duplicate profile version or candidate-promoted event. Equivalent simpler one-shot path: without prior materialization, the human runs the same labeled command once. A human admin or curator also runs `orizu manifests approve <id>`, `orizu manifests reject <id>`, and, after approval, `orizu manifests apply <id>`. |
| Hosted session | Review instructions | Read diff comments with `orizu comments diff --run <run-id> --from <candidate-id> --to <candidate-id> --detail hunk` or `orizu comments diff --prompt <prompt-id> --from <version> --to <version> --detail hunk`; keep report-comment CLI targets inside the signed project and prepare proposed review text. | A human admin or curator adds or deletes a diff comment. To change one, delete it and re-add it; the mutation APIs expose POST and DELETE, not edit. Hand off the target, exact anchor, exact text, and named add/delete action. |
| Hosted session | Session, credentials, and administration | Use connector secrets only through environment variables resolved at boot; prepare requested values without reading credential material. | A team ADMIN runs `orizu teams members add --email <email> --team <team>`, `orizu teams members remove --email <email> --team <team>`, or `orizu teams members role --team <team> --email <email> --role <admin\|curator\|judge>`. A session owner or team admin/curator may run `orizu session end --session <id>` for manual teardown; the coordinator owns automatic lifetime and provisions session and service-internal canonical-write credentials. A human runs `orizu session start --hosted --task "<prompt>" --project <team/project>`. For provider installation, kill switch, billing, deploy keys, or credential reads, ask the human to complete the named UI action and report completion without sharing secrets. |
