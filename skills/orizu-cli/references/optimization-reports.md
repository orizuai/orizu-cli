# Optimization Reports

Use this reference when writing the markdown report attached to an Orizu optimization run. The report explains what happened in one run; the skill docs explain how to interpret and act on it. A good report is diagnostic and prescriptive, not just a metric dump.

Attach the final markdown with:

```bash
orizu optimizations finish <run-id> --best-candidate <candidate-id> --report-file ./reports/<run-id>.md
orizu optimizations fail <run-id> --reason "<reason>" --report-file ./reports/<run-id>.md
orizu optimizations cancel <run-id> --reason "<reason>" --report-file ./reports/<run-id>.md
```

For budget-exhausted runs, `run-gepa` pauses the optimization before auto-promotion. Write the report from the paused run, then manually finish with `--best-candidate`, `--result-prompt-version` if promoted, and `--report-file` once the decision is made.

## Source Artifacts

Prefer the local GEPA log directory printed by `run-gepa`:

```text
logs/<optimization_run_id>/
  result.json
  evaluations.jsonl
  reflections.jsonl
  events.jsonl
  trainset.json
  valset.json
```

Read them in this order:

1. `result.json` for seed score, best score, best candidate id/text, promotion id, and budget state.
2. `evaluations.jsonl` for fixed rows, regressions, persistent failures, per-row feedback, latency, cost, and cache state.
3. `reflections.jsonl` for what the reflection model saw and why each child prompt was proposed.
4. `events.jsonl` for iteration order, candidate lineage, Pareto updates, budget events, pauses, failures, and promotions.

If local logs are unavailable, export the server-side archive:

```bash
orizu optimizations export <run-id> --out <run-id>.optimization.json
```

Use export for diagnostics because it is the portable source for per-candidate bodies, per-iteration minibatch and validation scores, candidate parent/child trajectory, score over time, prompt contexts, scorer contexts, and split metadata. Diff the seed body against the best body to understand what the optimizer actually learned.

## Report Structure

Write these sections, in this order.

### 1. Headline

Include:
- Seed score -> best score, absolute change, and percentage-point delta when the metric is a rate.
- The headline scorer name, metric key, split, scorer version, and dataset split.
- For judge alignment, prefer Cohen's kappa as the headline metric when labels are imbalanced. Kappa has an interpretable zero point: 0 is chance agreement, negative is worse than chance, and positive means real discrimination.
- Always include the confusion matrix alongside kappa. On small validation sets, the matrix movement often matters more than the single estimate.
- Promoted prompt version id, promotion label, and Orizu dashboard link when available.
- Small-n uncertainty note when `n < 30`. For example, at `n = 15`, a rough kappa standard error can be about +/- 0.25, so call out directional signals rather than overclaiming precision.

### 2. What The Optimizer Changed

Summarize the seed body -> best body diff in bullets rather than pasting a full raw diff. For each notable change, mark it as:
- Targeted fix: addresses a specific failure cluster found in train/validation feedback.
- General restructure: reorganizes the prompt, output contract, or reasoning order.
- Over-correction risk: may improve one cluster while hurting another.

When the reflection model added the same rules you were about to hand-write, do not hand-edit the seed just to feel useful. If GEPA can see and fix the failure from train examples, the next move is usually more budget, better feedback, or better data, not manual prompt patching. Hand-edit only when the optimizer cannot see the failure mode, such as zero train examples for that category.

### 3. Per-Row Outcome Decomposition

Decompose validation or held-out outcomes:
- Fixed rows: wrong before, right after. Include row ids and failure-mode tags.
- Regressed rows: right before, wrong after. Explain the likely cost of the new instructions.
- Persistent failures: wrong before and after. Classify each as one of:
  - Data gap: failure mode underrepresented or absent in train.
  - Contested gold: label or rationale appears questionable and needs human re-review.
  - Beyond prompt scope: the failure needs tools, state, retrieval, or reasoning outside this prompt.
  - Calibration overshoot: instructions pushed too far in one direction.

For judge optimization, include flag/ok recall and precision alongside the confusion matrix. A jump in rare-class recall can be more important than a modest kappa movement.

### 4. Optimizer Health Signals

Report:
- Pareto frontier size. A frontier of 1 or 2 means limited parent diversity.
- Acceptance rate by iteration. Many rejections suggest reflection is exploring but not finding hills; many acceptances suggest it is climbing a real signal.
- Budget state. If budget was exhausted, the run paused before auto-promotion; manually decide whether to promote/finish. If max iterations was reached with budget remaining, the run likely converged under the configured search.
- `scoreOverTime` / validation trajectory. Still climbing at the end suggests raising budget or iterations. Plateaued curves point toward scorer, feedback, or data work upstream.
- Reflection model, inference model, scorer model, provider settings, minibatch size, budget preset/limit, candidate selection strategy, seed, and cache settings.

### 5. Recommendations

Pick concrete next steps and state why each should help. Do not pattern-match from the final score alone.

Common recommendations:
- Increase budget: budget was binding, acceptance rate was healthy, and row analysis shows remaining fixable headroom.
- Increase minibatch size: the positive/flag class is rare, small batches miss the rare class, or reflection looks noisy.
- Multi-seed or broaden parent diversity: Pareto frontier stayed at 1 or 2 candidates.
- Switch reflection model or template: minibatch acceptance is healthy but validation gains do not generalize.
- Change metric or scorer contract: metric movement diverges from human judgment.
- Improve scorer feedback: reflection saw generic feedback and had to guess the failure mode.
- Data work upstream: persistent failures cluster on patterns missing from train.
- Gold label re-review: persistent failures cluster on single-reviewer rows, generic rationales, or rationales that contradict the label.

### 6. What Not To Do

List unsupported moves so the next agent does not burn cycles. Examples:
- Do not hand-edit the prompt when the best candidate already learned the intended failure rules.
- Do not raise budget when score over time plateaued and persistent failures are data/gold issues.
- Do not switch metrics because one small validation result looks noisy; first measure variance across repeated runs or larger samples.
- Do not optimize against a scorer whose feedback is too generic for reflection to learn from.

### 7. Links And Reproducibility

End with:
- Run id and dashboard link.
- Local log path or export artifact path.
- Prompt/scorer/runner/optimizer version ids.
- Dataset version id, split set id, train/validation split names, row counts, and random seed.
- Commands used to start/export/finish the run, with secrets omitted.
- Links to relevant skill sections, especially `optimization-with-gepa.md`, `prompt-control-plane.md`, `building-judges.md`, and this report guide.

## Interpretation Rules

### Pre-Flight Checks

Before launching GEPA, rerun the seed locally on validation and decompose the baseline by headline metric plus confusion matrix. Do not trust reported lift until the seed was measured through the same runner/scorer path.

Confirm train/validation class balance and failure-mode coverage. If train has zero examples of a category, GEPA cannot learn that category from reflection; call it data work, not optimizer failure.

Set an explicit expectation before the run: for example, "if best kappa does not beat 0.35 on validation and rare-class recall does not improve, the bottleneck is data/scorer feedback."

### Budget Versus Iteration Cap

Default budget presets are metric-call budgets: `auto = 64`, `light = 48`, `medium = 96`, and `high = 192`, unless `--max-metric-calls`, `--max-full-evals`, or `--max-candidate-proposals` overrides them.

Each iteration costs the minibatch evaluation plus full validation calls for accepted candidates, so medium budget can be exhausted well before a high `--max-iterations` target. If a run ends as `budget_exhausted`, it pauses and does not auto-promote. If auto-promotion matters, either increase budget to fit the iteration target or lower `--max-iterations` to fit the budget.

### Reflection Signal Quality

The scorer `feedback` string is what the reflection model sees per row. Generic feedback such as only a numeric error forces the model to infer the failure mode. Rich feedback should include the gold rationale, model/judge rationale, failure label, and the concrete disagreement.

Frame scorer output as a score where higher is better. Avoid naming the value as a loss/error while also setting `higher_is_better: true`; that gives reflection mixed directional signals.

Drop fields that are not intended to be scored. "Informational; not scored" columns create noise that reflection can overfit.

### Binary Verdict Versus Continuous Score

If gold is binary, ask the judge for a binary class and map it to numeric score after parsing. Continuous scores let a judge hedge and earn partial credit while being directionally wrong. For binary judge alignment, report the verdict confusion matrix and kappa, not just average continuous score.

### Kappa And Confusion Matrices

Use kappa as the headline metric for binary judge alignment when class imbalance matters. It corrects for majority-class baselines and has a meaningful chance-agreement zero point.

Always report the confusion matrix with kappa. On small `n`, kappa is unstable, and the operational change may be in a cell shift such as false negatives dropping or rare-class recall jumping.

### Aggregate Set Scorers

Set scorers are aggregate metric contracts today, not whole-split runner execution contracts. `runners exec --scorer-version` invokes the scorer runner per row even when the scorer manifest says `mode: "set"`.

For aggregate metrics such as kappa, accuracy, precision, recall, or F1:
1. Run or reuse row-level judge results.
2. Compute the aggregate locally.
3. Submit the score run with `scoreValue`, `diagnostics`, `feedbackSummary`, row counts, and optional `resultsJsonl` via the score submission API.

Temporary CLI limitation: `orizu scores submit <file>` uploads row results as JSONL and does not preserve top-level aggregate fields from a JSON file. Until aggregate score flags or a set-scorer execution command lands, POST directly to `/api/cli/scores/submit?project=<team/project>` when you need to preserve aggregate JSON fields.

### Gold Label Audit

Gold label audit comes before more optimization when persistent failures cluster on rows with:
- single-reviewer labels,
- generic or missing rationales,
- rationales that contradict the label,
- contentious domain judgments.

Fixing gold can move headline metrics more than another optimizer run. Call this out clearly instead of hiding it under "model still fails."
