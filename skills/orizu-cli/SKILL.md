---
name: orizu-cli
description: Use when the user wants to improve an LLM application's performance in a measurable way, or mentions Orizu by name. Triggers include improving model or agent performance, collecting human feedback on model outputs, converting feedback into evals, building or crafting evals, running prompt optimization (including one-off prompt tweaks the user is willing to validate with evals), working with Orizu datasets, tasks, apps, prompts, judges, scorers, runners, score runs, or optimization runs, hill-climbing on metrics, or building "continually learning" agents. Orizu is a platform for building evals first, then improving LLM applications by optimizing against them. The CLI handles human feedback collection, eval creation, versioned prompt and scorer artifacts, local runner execution, score submission, and prompt optimization. Do NOT use for prompt advice when the user has explicitly said they don't want to set up evals.
---

# Orizu

Orizu improves LLM applications by building evals first, then optimizing against them. The end-to-end loop has four steps: **Upload → Annotate → Judge → Optimize**. The CLI covers human-eval collection plus the Phase 0 prompt control plane: prompts, judges, scorers, runners, local runner execution, score submission, packaged GEPA-style text optimization, and live optimization logging.

For end-to-end methodology and rationale, read `references/primer.md`. The reference docs below cover specific stages in depth.

## When to step aside

Skip this skill when:
- The user wants a one-off prompt tweak they explicitly won't validate with evals.
- The user has already said they don't want to set up evals.
- The request is generic prompt-engineering theory unrelated to a specific app.

# Orizu CLI basics

## Prerequisites

- Node.js 20+ installed.
- Install the CLI: `npm i -g orizu`.
- Install this skill from the CLI package: `orizu install-skill --target agent-user --yes`.
- Rediscover the command surface any time with `orizu --help`, `orizu <group> --help`, or `orizu capabilities --json`.
- Login callback requires `127.0.0.1:43123`.
- Credentials are stored at `~/.config/orizu/credentials.json`.
- Current `orizu login` creates a user-owned personal access token for the CLI and stores it as a v3 API-key credential. The raw token is not recoverable after creation.

## Login

- Verify auth: `orizu whoami`.
- Start the login flow: `orizu login` (opens a browser tab).
- Approving login in the browser creates a personal access token for that Orizu user. The token inherits the user's current team/project access and loses access if the user's role or membership changes.
- Clear local credentials and revoke the current CLI token: `orizu logout`.
- Revoke other CLI tokens from the Personal Tokens page in Orizu.
- Auth failure loop: `orizu login` → `orizu whoami` → rerun the original command.

## Teams and projects

Projects live inside teams. Resolve or create both before any workflow command.

- `orizu teams list` — list teams the user belongs to.
- `orizu teams create --name "<team name>"` — create a team.
- `orizu projects list [--team <teamSlug>]` — list projects (optionally scoped to a team).
- `orizu projects create --name "<project name>" --team <teamSlug>` — create a project.

For team membership, app, dataset, and task command surfaces, see `references/cli-reference.md`.

# Evals best practices

Walk through the four steps in order — each depends on the output of the previous. Methodology and rationale: `references/primer.md`.

## 1. Upload — gather diverse traces

Principles:
- Mix production traces with a **random sample**. Thumbs-down feedback alone is biased toward extreme failures and misses subtle ones.
- Aim for **~100+ diverse traces**. Stop adding when you stop discovering new failure modes (theoretical saturation).
- Synthetic data is fine when real traces are scarce — vary structured inputs (feature × persona × scenario), seed from real logs, and filter for difficulty. Don't ask "generate 50 test cases" cold.

CLI:
```bash
orizu datasets upload --project <teamSlug>/<projectSlug> --file <traces.jsonl> --name "<batch>"
orizu datasets append --dataset <datasetId> --file <more.jsonl>
orizu datasets lock --dataset <datasetId> --reason "Freeze for labeling"
```

Deeper: `references/primer.md` (Step 1, Step 0 error analysis); `references/cli-reference.md` (datasets surface).

## 2. Annotate — binary labels per failure mode

Principles:
- **Binary, not Likert.** Pass/fail forces a ship/no-ship decision; 3/5 doesn't.
- **One question per failure mode.** Don't bundle correctness, tone, and helpfulness.
- **Annotate failures you've actually observed.** Hypothetical-failure labels are low-value.
- **Custom UI per task** — generic annotation interfaces collapse signal. The labeler should feel like an app annotators want to use, not a form they tolerate.

CLI:
```bash
orizu apps create --project <teamSlug>/<projectSlug> --name "<labeler>" --dataset <datasetId> \
  --file <App.tsx> --input-schema <input.json> --output-schema <output.json>

orizu tasks create --project <teamSlug>/<projectSlug> --dataset <datasetId> --app <appId> \
  --title "<round>" --labels-per-item 2

# Open the returned task URL and test the draft manually before assigning.
orizu tasks publish --task <taskId> --assignees <userId1,userId2>

orizu tasks status --task <taskId>
orizu tasks report set --task <taskId> --report-file ./task-report.md
orizu tasks export --task <taskId> --format jsonl --out ./labels.jsonl
```

Authoring the labeler: **`references/building-apps.md`** covers the component contract, design principles, common patterns (trace exploration, side-by-side, text annotation, etc.), the offline smoke test at `scripts/test-app.mjs` (runs on plain `node`), and `orizu apps preview`. When you generate or modify an app, run the preview command with a representative sample row, inspect the screenshot, and revise the app until the rendered workflow appears to match the user's intended review task before `orizu apps create`.

Deeper: `references/primer.md` (Step 2); `references/cli-reference.md` (apps + tasks surface).

## 3. Judge — turn labels into automated evaluators

Use the Phase 0 prompt control plane when the user wants judges stored in Orizu as versioned prompt artifacts, runner zips, scorer definitions, and submitted score results. Read **`references/prompt-control-plane.md`** before using those commands. When the user mentions prompt feedback, prompt comments, or asks what to focus on for the next prompt version, inspect comment threads with `orizu prompts comments <prompt-id-or-name> --project <team>/<project>` before editing or pushing.

Judge construction details are still useful when authoring the evaluator itself.

A judge is the evaluator prompt artifact. A scorer is the metric contract that names what score is being produced and how it should be displayed, compared, and used in optimizations. For UI-visible prompt performance, register a scorer and submit score runs; do not rely only on raw `runs submit`.

Set scorers are aggregate metric contracts. Use `orizu scorers exec` for builtin set metrics such as Cohen's kappa, accuracy, precision, recall, and F1; it consumes subject results or dependency row-scorer results, computes one aggregate, stores row evidence, and submits a canonical score run by default. If you already computed an aggregate locally, use `orizu scores submit --aggregate` with explicit `scoreValue`, `diagnostics`, `feedbackSummary`, and optional `rowEvidence`. `runners exec --scorer-version` remains a low-level row-runner compatibility command. Use a row-mode scorer, not a set scorer, for GEPA reflection because reflection needs per-row feedback.

Principles:
- **Code assertions first.** If a failure is a rule (keyword present, tool called, format valid), write a code check. Fast, free, deterministic.
- **LLM-as-a-judge for nuanced criteria only.** Always validate against your human labels.
- **TPR > 90% and TNR > 90%** before trusting a judge. Track each separately — accuracy is misleading on imbalanced data.
- **A 100% pass rate is a smell.** Your evals are saturated; add harder cases.

Authoring workflow:
1. Export labels: `orizu tasks export --task <id> --format jsonl --out labels.jsonl`.
2. For each failure mode, choose code assertion or LLM-judge.
3. Build the judge.
4. Validate: split labels train/dev/test (20/40/40), measure TPR + TNR on test, target both > 90%.
5. Run the validated judge over future outputs.

Detailed walkthrough — code assertion patterns, LLM-judge prompt scaffold, train/dev/test split, TPR/TNR computation, saturation: **`references/building-judges.md`**.

## 4. Optimize — hill-climb against validated judges

Use the Phase 0 prompt control plane when the user wants an optimizer run to appear in Orizu, stream live events, or promote accepted candidates into the prompt timeline. For text-candidate GEPA-style optimization, prefer the bundled `orizu optimizations run-gepa` flow. Read **`references/prompt-control-plane.md`** before wiring those endpoints.

GEPA details below are still useful for local optimizer implementation. DSPy is only relevant when the customer already uses DSPy or asks for an external DSPy GEPA implementation.

Principles:
- Only optimize against judges you've validated. Otherwise you Goodhart your way to a worse system.
- Compare before/after on the **same held-out eval suite**. Don't trust vibes.
- Read **per-failure-mode metrics**, not just combined — averages hide regressions.
- Improved-system traces feed back into step 1; the loop continues.

Local execution workflow:
1. Package the candidate execution as an Orizu runner.
2. Register validated row/set scorers.
3. Run the bundled GEPA-style optimizer or a custom optimizer against the scorer set.
4. Inspect `logs/<optimization_run_id>` for full local optimization traces, especially `evaluations.jsonl`, `reflections.jsonl`, `events.jsonl`, and `result.json`.
5. If the local log is unavailable or the run happened remotely, use `orizu optimizations export <run-id> --out <run-id>.optimization.json`.
6. Write a markdown optimization report from the logs/export and attach it with `--report-file <path>` when finishing, failing, or cancelling the run.
7. Diff before/after on a held-out set; ship if it holds.

Bundled `run-gepa` reflection behavior:
- The reflective LM's final text is used verbatim as the next candidate prompt. It should return only the complete updated prompt body, not analysis, labels, XML tags, or markdown fences.
- Keep provider-native reasoning controls separate from the prompt text with `--reflection-provider-settings <json|@file>`.
- Reflection max-token limits are explicit config, not implicit defaults. Use `--reflection-max-tokens <n>` when a provider requires an output cap; this maps to Anthropic `max_tokens` and OpenAI `max_output_tokens`.
- Anthropic native Messages reflection requires `max_tokens`, so `run-gepa` with an `anthropic/...` reflection model must receive `--reflection-max-tokens <n>` and should fail fast if it is omitted. OpenAI reflection may omit `max_output_tokens` unless the user explicitly wants a cap.
- By default, `run-gepa` skips reflection and child creation when every row in the selected parent mini-batch is already perfect (`1.0` for higher-is-better scorers, `0.0` for lower-is-better scorers). This saves reflection tokens because the child cannot beat a saturated mini-batch. Use `--no-skip-perfect-parent-reflection` to force reflection anyway, or `--skip-perfect-parent-reflection` to make the default explicit in scripted runs.
- By default, `run-gepa` sets `--num-threads auto` for row evaluations. Auto uses mini-batch size, validation-set size, CPU count, memory estimate, file-descriptor limit, and an 8-thread hard cap to avoid launching too many runner subprocesses at once. Use `--num-threads <n>` only when the runner/provider capacity is known.
- `run-gepa` writes complete local logs by default under `logs/<optimization_run_id>`; override with `--log-dir <dir>` or disable with `--no-local-log`.
- Server optimization events redact row snapshots and reflection prompts by default; the local log keeps full row inputs, outputs, scores, feedback, reflection prompts, and reflection responses for later agent analysis.
- OpenAI example: `--reflection-model openai/gpt-5 --reflection-provider-settings '{"reasoning":{"effort":"medium","summary":"auto"}}'`.
- Anthropic example: `--reflection-model anthropic/claude-opus-4-7 --reflection-max-tokens 4096 --reflection-provider-settings '{"thinking":{"type":"adaptive","display":"omitted"},"output_config":{"effort":"medium"}}'`.

Detailed walkthrough — GEPA mechanics, Orizu-tracked optimization, optional DSPy context for customers already using it, and before/after comparison: **`references/optimization-with-gepa.md`**. Report-writing structure and interpretation guidance: **`references/optimization-reports.md`**.

# Reference index

- `references/primer.md` — methodology end-to-end (read first when in doubt about *why*).
- `references/cli-reference.md` — full CLI command surface.
- `references/prompt-control-plane.md` — Phase 0 prompts, judges, scorers, runners, score submission, optimizer event logging, bundled GEPA, and promotion endpoints.
- `references/building-apps.md` — labeler app contract, design principles, common patterns, offline smoke test.
- `references/building-judges.md` — judge/scorer authoring + TPR/TNR validation.
- `references/optimization-with-gepa.md` — GEPA optimization loop, with DSPy only as external context.
- `references/optimization-reports.md` — report template, GEPA diagnostics, kappa/confusion-matrix guidance, and next-step recommendations.
- `scripts/test-app.mjs` — smoke test for `App.tsx` + schemas before `orizu apps create` (runs on plain `node`).

# Execution rules

- Prefer explicit flags in non-TTY contexts; reserve interactive fallback for TTY.
- Canonical selectors: `--team`, `--project`, `--app`, `--task`, `--dataset`, `--assignees`.
- `tasks create` creates drafts by default. Test the returned task URL manually, then use `tasks publish --task <taskId> --assignees <userId1,userId2>` after approval.
- `tasks assign` and `tasks publish` take user IDs, not emails.
- `datasets edit-rows` requires a non-empty string `id` on each row in `--file`.
- `datasets delete-rows` uses `--row-ids` as the canonical selector.
- `datasets delete` requires interactive terminal confirmation; there is no non-interactive confirmation option.
- Locked datasets reject append/edit/delete row mutations.
- `--output-schema` JSON Schema validation surface is restricted to `type`, `required`, `properties`, `items`, `enum`.
- Export defaults: `--format jsonl`, output `<taskId>.<format>`.
- Task reports can be uploaded only after the task is `paused` or `completed`; rerun `tasks report set` or `tasks report upload` to replace the markdown report.
- Prompt control-plane commands should use ids for dataset versions, split sets, prompt versions, scorer versions, runner versions, optimizer versions, and optimization runs.
- Optimization exports default to `<run-id>.optimization.json`; prefer the existing `logs/<run-id>` directory from `run-gepa` when it is available because it contains the full local trace without needing server rehydration.
- When ending an optimization run, attach a markdown report with `--report-file` when possible. Use `references/optimization-reports.md` for what to include.
- Use `orizu prompts comments <prompt-id-or-name> --project <team>/<project> [--label <label> | --version <id>] [--json]` to list prompt-level discussion threads with open/resolved status, selected text/line context, and replies.
