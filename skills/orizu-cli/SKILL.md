---
name: orizu-cli
description: Use when the user wants to improve an LLM application's performance in a measurable way, or mentions Orizu by name. Triggers include improving model or agent performance, collecting human feedback on model outputs, converting feedback into evals, building or crafting evals, running prompt optimization (including one-off prompt tweaks the user is willing to validate with evals), finetuning against evals, hill-climbing on metrics, or building "continually learning" agents. Orizu is a platform for building evals first, then improving LLM applications by optimizing against them. The CLI handles three workflows – gathering expert feedback, turning feedback into evals, and running optimizations (prompt optimization or finetuning). Do NOT use for prompt advice when the user has explicitly said they don't want to set up evals.
---

# Orizu

Orizu improves LLM applications by building evals first, then optimizing against them. The end-to-end loop has four steps: **Upload → Annotate → Judge → Optimize**. The CLI covers steps 1–2; steps 3–4 are done offline today (judges in code, optimization with DSPy + GEPA), with platform support coming.

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
- Login callback requires `127.0.0.1:43123`.
- Credentials are stored at `~/.config/orizu/credentials.json`.

## Login

- Verify auth: `orizu whoami`.
- Start the login flow: `orizu login` (opens a browser tab).
- Clear session: `orizu logout`.
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
  --title "<round>" --assignees <userId1,userId2> --labels-per-item 2

orizu tasks status --task <taskId>
orizu tasks export --task <taskId> --format jsonl --out ./labels.jsonl
```

Authoring the labeler: **`references/building-apps.md`** covers the component contract, design principles, common patterns (trace exploration, side-by-side, text annotation, etc.), and the offline smoke test at `scripts/test-app.mjs` (runs on plain `node`). Run the smoke test before `orizu apps create`.

Deeper: `references/primer.md` (Step 2); `references/cli-reference.md` (apps + tasks surface).

## 3. Judge — turn labels into automated evaluators

Done in code today; Orizu platform support is coming.

Principles:
- **Code assertions first.** If a failure is a rule (keyword present, tool called, format valid), write a code check. Fast, free, deterministic.
- **LLM-as-a-judge for nuanced criteria only.** Always validate against your human labels.
- **TPR > 90% and TNR > 90%** before trusting a judge. Track each separately — accuracy is misleading on imbalanced data.
- **A 100% pass rate is a smell.** Your evals are saturated; add harder cases.

Offline workflow:
1. Export labels: `orizu tasks export --task <id> --format jsonl --out labels.jsonl`.
2. For each failure mode, choose code assertion or LLM-judge.
3. Build the judge.
4. Validate: split labels train/dev/test (20/40/40), measure TPR + TNR on test, target both > 90%.
5. Run the validated judge over future outputs.

Detailed walkthrough — code assertion patterns, LLM-judge prompt scaffold, train/dev/test split, TPR/TNR computation, saturation: **`references/building-judges.md`**.

## 4. Optimize — hill-climb against validated judges

Done in code today with DSPy + GEPA; Orizu platform support is coming.

Principles:
- Only optimize against judges you've validated. Otherwise you Goodhart your way to a worse system.
- Compare before/after on the **same held-out eval suite**. Don't trust vibes.
- Read **per-failure-mode metrics**, not just combined — averages hide regressions.
- Improved-system traces feed back into step 1; the loop continues.

Offline workflow:
1. Wrap the LLM application as a `dspy.Module`.
2. Wire each validated judge as a DSPy metric.
3. Run GEPA against the metric set; keep the highest-scoring candidate.
4. Diff before/after on a held-out set; ship if it holds.

Detailed walkthrough — DSPy program structure, metric wiring, GEPA invocation, before/after comparison: **`references/optimization-with-dspy-gepa.md`**.

# Reference index

- `references/primer.md` — methodology end-to-end (read first when in doubt about *why*).
- `references/cli-reference.md` — full CLI command surface.
- `references/building-apps.md` — labeler app contract, design principles, common patterns, offline smoke test.
- `references/building-judges.md` — offline judge construction + TPR/TNR validation.
- `references/optimization-with-dspy-gepa.md` — DSPy + GEPA optimization loop.
- `scripts/test-app.mjs` — smoke test for `App.tsx` + schemas before `orizu apps create` (runs on plain `node`).

# Execution rules

- Prefer explicit flags in non-TTY contexts; reserve interactive fallback for TTY.
- Canonical selectors: `--team`, `--project`, `--app`, `--task`, `--dataset`, `--assignees`.
- `tasks assign` takes user IDs, not emails.
- `datasets edit-rows` requires a non-empty string `id` on each row in `--file`.
- `datasets delete-rows` uses `--row-ids` as the canonical selector.
- Locked datasets reject append/edit/delete row mutations.
- `--output-schema` JSON Schema validation surface is restricted to `type`, `required`, `properties`, `items`, `enum`.
- Export defaults: `--format jsonl`, output `<taskId>.<format>`.
