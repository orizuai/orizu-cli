---
name: orizu-cli
description: Use when the user mentions Orizu; wants measurable improvement for a specific LLM application or agent; collects human feedback on model outputs or turns failures into evals; validates judges; optimizes instruction sets; migrates an existing GEPA setup; or establishes continuous improvement. Step aside and handle directly generic instruction-writing theory or one-off edits the user explicitly will not validate with evals.
---

# Orizu

Orizu improves LLM applications by building evals first, then optimizing against them. Use `orizu instructions` as the primary path for customer instruction sets. Follow the journey in order; each step depends on the previous step's exit criterion. Read `references/primer.md` for the methodology and `references/cli-reference.md` for the current command surface instead of relying on remembered commands.

The artifacts enter the journey where they are needed: a **dataset** holds versioned rows; an **app** and **task** collect labels; a **judge** evaluates outputs, a **runner** executes it, and a **scorer** defines its metric contract; an **instruction set** is the customer-facing identity whose model-config **profiles** own ordered **components**; an **optimization run** searches profile candidates against validated scorers.

## Critical: scorer-runner input contract

`orizu optimizations run-gepa` sends the scorer runner a GEPA-shaped row (`{source_row, candidate_id, candidate_output, …}`), not the flat-row shape used by `runners exec --scorer-version`. A judge runner built for flat rows will silently score every candidate 0 unless `flat_row` is selected by `--scorer-input-contract` or the runner manifest and, when needed, the candidate field is selected by flag or manifest. Use the official adapter rather than changing registered runner bytes. The default seed preflight raises `SeedValidationRefused` for a uniformly degenerate seed; `--allow-degenerate-seed` bypasses that refusal. Read `references/prompt-control-plane.md` under “Scorer-Runner Input Contracts” before running optimization.

# Journey

## 1. Set up

- For local use, install Node.js 20+, run `npm i -g orizu`, then run `orizu setup` so browser login, the workbench, and skill links are initialized. The callback defaults to `127.0.0.1:43123`; after a collision, set `ORIZU_AUTH_PORT` to an available port from 1024–65535.
- Verify auth and runtime with `orizu whoami --json` and `orizu capabilities --json`. Verify skill installation and sync separately with `orizu skills status --json`; use `orizu skills update` if stale. Hosted sessions start here: skip installation and login because the CLI is pre-authenticated, then continue to team/project resolution; see Where things live for authority boundaries.
- Resolve or create the team and project with the user's naming choices. Projects live inside teams.
- Browser login creates a user-owned personal access token. The server/UI cannot redisplay the raw token after issuance, but the local v3 credential retains it for CLI auth. The token inherits current access and loses access when the user's role or membership changes.

**Exit:** The team and project exist; the skill is verified in sync by `orizu skills status` locally, or shipped and present in a hosted session; and both `orizu whoami` and `orizu capabilities` succeed.

## 2. Assess & plan

- Read `references/assess-and-plan.md` and follow its survey, decision, conversation, and persistence workflow before moving any data.

**Exit:** A human-ratified `improvement-plan.md` is committed at the plain-repo root or at `projects/<directorySlug>/improvement-plan.md` in a workbench; there, it and its `memory.md` pointer are committed together.

## 3. Build the dataset

- Follow the plan's source decision. Import existing golden data where it exists; otherwise combine representative production traces, a random sample, and structured synthetic cases when real traces are scarce. Human ratification and spot-checking remain part of the source decision.
- Cover every named scenario class, design the validation split, and size mini-batches so optimization can learn each class. Create an immutable dataset version to snapshot current rows.
- Locking applies to the dataset, not the version, and rejects row mutations on that dataset. To add later data, clone to an unlocked dataset and create a new version there.

**Exit:** A versioned dataset covers every scenario class named by the plan and is ready for labeling, or already contains ratified golden ground truth.

## 4. Annotate when human labels are ground truth

- If imported golden data supplies the ground truth, record that decision and skip or shrink annotation. Otherwise, guide an eval-strategy conversation around observed failure modes: prefer one binary question per failure mode over bundled or Likert judgments.
- Author a task-specific labeler app using `references/building-apps.md`. Preview it with representative rows, inspect the rendered workflow, revise it, and ask the human for pointed feedback before labeling.
- Task creation is draft-first. Have the human test and approve the returned task URL, then publish with assignees or an assignment file. After labeling, export the labels and publish the task report.

**Exit:** Golden ground truth is recorded as the reason annotation was skipped, or labels are exported and the approved task report is published.

## 5. Judge

- Build automated evaluators from the ground truth: use code assertions for deterministic rules and LLM judges only for nuanced criteria. A 100% pass rate is a saturation warning, not proof that the evaluator is useful.
- Validate against held-out human labels. Track TPR and TNR per failure mode, and use Cohen's kappa alongside raw agreement when establishing the judge trust bar with the user for the decision it powers.
- Store the versioned judge and runner, then register the row or set scorer that defines how its output is displayed, compared, and used. GEPA reflection needs a row-mode scorer because it consumes per-row feedback.
- Read `references/building-judges.md` for authoring and alignment mechanics and `references/prompt-control-plane.md` for artifact contracts and score submission.

**Exit:** Every gating judge clears its agreed judge trust bar, and its scorers are registered.

## 6. Optimize

- Optimize only against validated judges. Package candidate execution as a runner, run the optimizer against registered scorers, and compare candidates on the same held-out eval suite with per-failure-mode results.
- Use `orizu instructions` for the instruction set. Each run targets one model-config profile and treats its complete component map as the candidate; promotion never moves one component independently.
- Inspect the local run logs when available, otherwise export the run. Write and attach a markdown report using `references/optimization-reports.md`; the report should explain candidate tradeoffs and regressions clearly enough for the human to make the promotion decision.

Bundled `run-gepa` behavior that is not safely inferred from command discovery:

- Budget controls are mutually exclusive. If none is provided, `run-gepa` uses `--budget auto`, the balanced medium preset.
- The skilled proposer prepares or reuses its managed Python environment. Its aggregate proposal token/call budgets are independent of metric-call and per-response reflection limits; it is incompatible with a reflection prompt template.
- The reflective LM's final text becomes the selected component's next value, so it must return only the complete updated component value.
- Keep provider-native reasoning controls separate from component text. Anthropic reflection requires an explicit reflection max-token limit; OpenAI may omit one unless the user requests a cap.
- Legacy GEPA logs an exhausted retryable reflection failure, charges proposal and iteration budgets, and continues. The official engine increments proposal usage only after successful `on_proposal_end`; skilled-proposer failures re-raise and stop.
- A perfect selected mini-batch skips reflection and child creation by default (`--skip-perfect-parent-reflection`); use `--no-skip-perfect-parent-reflection` to override it. Automatic row-evaluation concurrency is bounded by workload and host limits.
- Complete local logs include row inputs, outputs, scores, feedback, and reflection material; server events redact row snapshots and reflection prompts by default.

Read `references/optimization-with-gepa.md` for the full execution workflow. DSPy is relevant only when the customer already uses it or requests an external DSPy GEPA implementation.

**Exit:** The human has made a promotion decision from the optimization report; if shipping, the new profile version is live.

## 7. Improve continuously

- Feed improved-system traces into a new dataset version and repeat from dataset building. Each report should recommend the next scenario classes or failure modes to investigate.
- Propose a cadence for fresh-trace collection, evaluation, and optimization; set it up only after the user agrees, then complete the first cycle.

**Exit:** A cadence is agreed and its first cycle is complete, with new data feeding the next dataset version.

# Reference index

- `references/primer.md` — end-to-end evals-first methodology.
- `references/assess-and-plan.md` — codebase survey, user-owned decisions, plan conversation, and durable J2 artifact.
- `references/cli-reference.md` — current CLI command surface.
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

# Where things live

- **Orizu is the source of truth for run metadata and pointers**: instruction-set defaults, profile production pointers, scorer/runner pointers, version lineage, score runs, optimization runs, and report history all live in Orizu — query them with `orizu ...` commands (for example, `orizu instructions list`, `orizu instructions show`, and `orizu runs ...`), never by reading repo files.
- **The repo is the working set (files only)**: source, configs, `App.tsx`, schemas, and local traces under `logs/<run-id>`. It is the scratch space you edit and commit; it does NOT hold the canonical pointer/run state — that is in Orizu.
- **Hosted sessions ship a pre-authenticated CLI**: inside a hosted agent sandbox the `orizu` CLI is already authenticated via `ORIZU_TOKEN_FILE` (with `ORIZU_BASE_URL` pointing at the API). You do NOT run `orizu login` — just call `orizu ...`. The bearer carries **team-curator authority while your session is active**, except for the explicit human-only carveouts below (ADR-008 and the ALI-1558 instruction-write restriction). It can read and sync instruction sets and can perform ordinary curator work across the team. (The full per-role access matrix lives in the Orizu repo at `docs/authorization-matrix.md`.)
- **Hosted `--session` applies to git-canonical artifacts, not instruction sets**: instruction sets and profiles are control-plane canonical (ADR-023), and their CLI mutations do not accept `--session`.
  The agent-allowed catalog boundary is explicit: hosted agents may run
  `orizu instructions profiles new` and `orizu instructions sync`. They may also inspect instruction sets and prepare a complete manifest, but a human curator using the local CLI with a user token must run the six catalog mutations listed below and all pointer moves. Judges, scorers, runners, and optimizers remain git-canonical for teams with a workbench repository; their hosted writes must carry `--session <session-id>`, and their bytes must live as commits on the session branch. Before calling any artifact committed, run `git ls-files <path>` and inspect the commit; an Orizu version id alone does not prove the bytes exist in a branch.
- **Human-only actions will 403**: a hosted agent must hand the following commands
  to a human curator using the local CLI with a user token. Human/local CLI only:
  `orizu instructions create`, `orizu instructions push`,
  `orizu instructions shape add`, `orizu instructions shape remove`,
  `orizu instructions archive`, and `orizu instructions restore`.
  Human/local CLI only: The measured response for `orizu instructions create` and `orizu instructions push` is `Sessionless registration is not available to the hosted agent: this artifact class is git-canonical (ADR-007) and its bytes must be committed to the session branch. Re-run with --session <session-id>.` Those commands have no `--session` flag, so do not retry them.
  Human/local CLI only: The measured response for `orizu instructions shape add` and `orizu instructions shape remove` is `Agents cannot change instruction-set shapes`.
  Human/local CLI only: The measured response for `orizu instructions archive` and `orizu instructions restore` is `Agent sessions cannot perform this action`.
  Promotion-manifest **approval / apply / reject**, production and default
  pointer flips, session/credential lifecycle (starting or ending hosted
  sessions, minting tokens, deploy keys), integration/connector credential
  reads (secrets reach your sandbox only as environment variables resolved at
  boot — never via API/DB), and team/member/installation/billing management
  are also human-only. Do not attempt them from a hosted session. Prepare the
  manifest or proposal and hand it to a human curator to run, approve, or
  apply.
