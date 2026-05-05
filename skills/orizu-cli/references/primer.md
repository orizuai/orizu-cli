# Evals & Orizu Primer

> **Core idea:** You can't improve what you can't measure — but measuring the wrong thing is worse than not measuring at all. This doc walks from raw failure logs to a continuously-running evaluation loop, and shows how Orizu operationalizes each step.

The loop has four steps:

```
Upload → Annotate → Judge → Optimize
   ▲                                │
   └────────── new traces ──────────┘
```

The CLI covers steps 1–2. Steps 3–4 are done offline today (judge construction in code; optimization with DSPy + GEPA). Each step depends on the output of the previous; don't skip ahead.

---

## Step 0: Error Analysis (do this before writing any eval)

The most common mistake teams make is jumping straight to evals before they understand what's actually failing. Error analysis is the prerequisite.

**How to do it:**

1. **Collect traces** — Gather a diverse sample of 100+ traces from production or your own real/synthetic usage. Diversity matters more than volume.
2. **Annotate freely (open coding)** — Review each trace and write brief, unstructured notes about what went wrong. Be specific: *"hallucinated a fact," "misread the user's name," "failed to use the calculator tool."*
3. **Group & categorize** — Cluster similar notes into named failure modes (tone violation, failed tool call, etc.).
4. **Prioritize by frequency** — Count how often each category appears.

**When to stop:** Keep adding traces until you stop discovering new failure modes (theoretical saturation).

**Decision: should you even write a formal eval for this failure?**
- If you haven't observed it, no — do error analysis first.
- If the fix is one-shot and obvious, no — just fix it.
- If fixing it requires repeated iteration (prompt tweaks, retries, structural changes), yes — that's where evals shine.

---

## Step 1: Upload — gather diverse traces

### Why

- Mix production traces with a **random sample**. Thumbs-down feedback alone is biased toward extreme failures and misses the subtle ones.
- Aim for **~100+ diverse traces**. Stop adding when you stop discovering new failure modes.
- **Sampling strategies** (use a mix):
  - Random — surfaces unexpected issues; always include.
  - Clustering — semantic groups reveal failure patterns.
  - Outlier analysis — long latency, many turns, high token counts.
  - Classification — use existing evals or a small model to surface known-bad traces.
  - Explicit feedback — high signal but sparse.
- **Synthetic data** when real traces are scarce: define structured dimensions (Feature × Persona × Scenario), seed from real logs, generate many candidates, filter for difficulty. Don't ask the model "generate 50 test cases" cold — it produces generic, repetitive output. Increase complexity iteratively.
- For multi-turn agent failures, use the **N-1 method**: collect minimally-reproduced error traces and use the N-1 turns before the error as test cases.

### In Orizu

Datasets are the unit of upload. Each row has a canonical `id`; payload is the rest of the JSON object. Supported formats: `csv`, `json`, `jsonl`.

```bash
# Upload a fresh batch
orizu datasets upload \
  --project <teamSlug>/<projectSlug> \
  --file <traces.jsonl> \
  --name "Support traces — 2026-W18"

# Append later batches
orizu datasets append --dataset <datasetId> --file <more.jsonl>

# Edit specific rows in place (each row in --file must include canonical id)
orizu datasets edit-rows --dataset <datasetId> --file <edits.jsonl>

# Delete rows by canonical id
orizu datasets delete-rows --dataset <datasetId> --row-ids <id1,id2>

# Lock when ready for labeling — locked datasets reject append/edit/delete
orizu datasets lock --dataset <datasetId> --reason "Freeze for QA round 1"

# Snapshot/branch a dataset
orizu datasets clone --dataset <datasetId> --name "Support traces copy"
```

Full surface: `cli-reference.md`.

---

## Step 2: Annotate — binary labels per failure mode

### Why

- **Binary, not Likert.** Pass/fail forces a ship/no-ship decision; 3/5 doesn't. Annotators on Likert scales default to middle values and you lose signal.
- **One question per failure mode.** Don't bundle correctness, tone, and helpfulness into one rating — you won't know which is failing.
- **Annotate failures you've actually observed.** Hypothetical-failure labels are low-value.
- **Custom UI per task.** Generic annotation interfaces collapse signal. The labeler should be tailored to your data and the specific binary questions you're asking.

A good eval metric has these properties:
- It measures an error you've observed.
- It relates to a non-trivial issue you'll iterate on.
- It's scoped to a specific failure (not "overall quality").
- It has a binary outcome.
- It's verifiable — humans or an LLM judge can reliably assess it.

### In Orizu

Two artifacts: an **app** (custom labeler UI) and a **task** (the labeling round + assignments).

```bash
# 1. Create the labeler app, bound to the dataset
orizu apps create \
  --project <teamSlug>/<projectSlug> \
  --name "Support QA Labeler" \
  --dataset <datasetId> \
  --file ./labeler/App.tsx \
  --input-schema ./labeler/input.json \
  --output-schema ./labeler/output.json

# 2. Create the task — assignments fan out at create time
orizu tasks create \
  --project <teamSlug>/<projectSlug> \
  --dataset <datasetId> \
  --app <appId> \
  --title "Support QA — Round 1" \
  --assignees <userId1,userId2> \
  --instructions "Label per rubric v1" \
  --labels-per-item 2

# 3. Track progress
orizu tasks status --task <taskId>

# 4. Export labels for downstream judge work
orizu tasks export --task <taskId> --format jsonl --out ./labels.jsonl
```

Authoring the labeler app — contract, design principles, and common patterns: see `building-apps.md`. Includes an offline smoke test (`scripts/test-app.mjs`, runs on plain `node`).

---

## Step 3: Judge — turn labels into automated evaluators

### Why

- **Code assertions first.** If a failure is a rule (keyword present, tool called, format valid), write a code check. Fast, free, deterministic.
- **LLM-as-a-judge for nuanced criteria only.** Powerful but slow and expensive — reserve for failures code can't catch.
- **Validate every judge against human labels.** A judge that doesn't agree with humans is a misaligned metric.
- Track **TPR (True Positive Rate)** and **TNR (True Negative Rate)** separately, not accuracy. Accuracy is misleading on imbalanced data. Target both > 90%.
- **A 100% pass rate is a smell** — your evals are saturated. Add harder cases.
- **Three common eval mistakes:**
  1. Skipping the data — using off-the-shelf metrics ("Helpfulness," "Faithfulness") that don't measure your specific failures.
  2. Trusting the LLM judge without validating it against human labels.
  3. Celebrating perfect scores instead of pushing harder cases.

There are three **types** of automated evals:
- **Code-based assertions** — rule-based, deterministic. Use whenever possible.
- **LLM-as-a-judge** — for subjective/nuanced criteria. Validate before trusting.
- **Guardrails** — run in the request/response path to block failures before they reach users. Usually code-based or small classifiers, not LLMs.

### In Orizu (today, offline)

This work is done by the agent in code today (Orizu platform support coming):

1. Export labeled data: `orizu tasks export --task <id> --format jsonl --out labels.jsonl`
2. For each failure mode, choose code assertion or LLM-judge.
3. Build the judge.
4. Validate against the labels (train/dev/test split, TPR/TNR).
5. Run the validated judge over future outputs to score them.

Detailed walkthrough — code assertion patterns, LLM-judge prompt scaffold, train/dev/test split, TPR/TNR computation, saturation checks: `building-judges.md`.

---

## Step 4: Optimize — hill-climb against validated judges

### Why

- Only optimize against judges you've validated. Otherwise you Goodhart your way to a worse system that scores higher.
- Compare before/after on the **same eval suite** — don't trust vibes.
- Improvements compound: new traces from the improved system feed back into Upload and reveal the next layer of failures.

### In Orizu (today, offline)

Done with **DSPy + GEPA** today (Orizu platform support coming):

1. Wrap the LLM application as a DSPy program.
2. Wire each validated judge as a DSPy metric.
3. Run GEPA against the metric set; keep the candidate prompt that scores highest.
4. Diff before/after on the eval suite. Ship if it holds; new traces feed back to step 1.

Detailed walkthrough — DSPy program structure, metric wiring, GEPA invocation, before/after comparison: `optimization-with-dspy-gepa.md`.

---

## Deploying Continuously

Evals aren't just for development. Deploy them in three modes:

|              | **CI/CD**              | **Online Monitoring**             | **Guardrails**                       |
|--------------|------------------------|-----------------------------------|--------------------------------------|
| **Goal**     | Prevent regressions    | Discover new failures, track perf | Enforce safety, block bad responses  |
| **When**     | Pre-merge (PR)         | Async, post-response              | Synchronous, pre-response            |
| **How**      | Unit tests, LLM-judge  | LLM-judge, A/B testing            | Unit tests, small classifiers        |
| **Data**     | Curated test cases     | Sampled production traffic        | 100% of live traffic                 |
| **On fail**  | Block merge            | Trigger alert                     | Block, retry, or fallback            |

**The optimization loop:** error analysis → evals → CI/CD prevents regressions → online monitoring catches new failures → repeat.

---

## Finding Failure Hotspots in Multi-Step Agents

When an agent has many steps (Plan → Search → Code → Finalize), build a **Transition Failure Matrix** to spot where it breaks down most often:

1. List all states.
2. Build a matrix: rows = "From" state, columns = "To" state.
3. For each failure, find the last successful transition before the error and add +1 to that cell.

Hotspots tell you which transition to fix first. Example: `GenSQL → ExecSQL` count of 12 → your SQL generation is producing invalid queries.

---

## Quick Reference: Mental Model

```
Production Traffic
      ↓
  Sample Traces  ←─────────────────────────────┐
      ↓                                         │
  Error Analysis (annotate → group → prioritize)│
      ↓                                         │
  Worth an eval? (observed? requires iteration?)│
      ↓                                         │
  Annotate (binary, observed, custom UI)        │
      ↓                                         │
  Build Judge (code-first, LLM-as-judge if needed)
      ↓                                         │
  Validate Judge (TPR > 90%, TNR > 90%)         │
      ↓                                         │
  Optimize (DSPy + GEPA against the judge)      │
      ↓                                         │
  Deploy (CI/CD + Online Monitoring + Guardrails)
      ↓                                         │
  New traces flow in ───────────────────────────┘
```

---

*Source material draws on Hamel Husain's [Applied AI Evals](https://evals.info).*
