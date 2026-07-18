# Building Judges And Scorers

How to turn human-labeled annotations into automated evaluators. Use this reference for authoring and validating the evaluator logic; use `prompt-control-plane.md` to push versioned prompt artifacts, runner artifacts, scorer definitions, and score runs into Orizu.

## Inputs

You should arrive here with:
- A labeled task export: `orizu tasks export --task <taskId> --format jsonl --out labels.jsonl`
- One or more **specific binary failure modes** the labels measure (e.g. `correctly_identified_issue`, `escalated_when_required`).
- The original dataset row each label refers to (the export includes `dataset_row_id` and the row payload).

If you have Likert or "overall quality" labels, stop and re-annotate. Judges built on Likert data are unreliable. See `primer.md` Step 2.

Terminology:
- A **judge** is the evaluator itself, often an LLM prompt plus runner.
- A **scorer** is the metric contract stored in Orizu. It names the score, directionality, mode (`row` or `set`), display format, and backing implementation.
- Row scorers return per-row scores and feedback. Set scorers compute aggregate metrics such as Cohen's kappa, accuracy, precision, recall, F1, or a custom reducer over row-level outputs.
- Use `orizu scorers exec` for scorer-level evaluation. Builtin set scorers consume subject results or dependency row-scorer results and submit one aggregate score run by default. `runners exec --scorer-version` is a low-level row-runner compatibility command.

## Choosing the judge type

| Failure mode looks like | Use                                       |
|-------------------------|-------------------------------------------|
| Rule-shaped (keyword present, tool called, format valid, length within bounds) | **Code assertion** |
| Subjective / nuanced (offered the right resolution, tone matches policy, escalation was warranted) | **LLM-as-a-judge** |
| Path-of-life (block before user sees the response — toxicity, PII leak) | **Guardrail** (small classifier or code, runs synchronously; not covered here) |

Default to code. LLM judges cost money, time, and trust budget — earn them.

## Code assertions

A code assertion is a pure function:

```python
def passes(input: dict, output: dict) -> bool:
    # Returns True if the output is acceptable for this failure mode.
    ...
```

**Patterns that work well:**
- Keyword/regex match on output text
- Structural check on JSON output
- Tool-call verification (did the agent call the expected tool with valid args?)
- Length/format bounds (response is within N tokens, ends with a question mark, etc.)
- Numeric tolerance for known answers

**Example — case reference number present in support response:**

```python
import re

CASE_REF_RE = re.compile(r"\bCASE-\d{6}\b")

def has_case_reference(input: dict, output: dict) -> bool:
    return bool(CASE_REF_RE.search(output["text"]))
```

Run it over the labeled export and confirm it agrees with the human labels for this failure mode. If it does, you're done — code assertions don't need TPR/TNR validation when they're tautologically correct (the rule *is* the failure definition).

If your code assertion disagrees with humans on >5% of cases, your rule isn't capturing the failure mode and you probably need an LLM judge instead.

## LLM-as-a-judge

For nuanced failures, build a judge that takes `(input, output)` and returns `pass | fail`.

### Step 1: Split the labels

Split your labeled export 20 / 40 / 40:

| Set    | Size | Purpose                                            |
|--------|------|----------------------------------------------------|
| Train  | ~20% | Few-shot examples in the judge prompt              |
| Dev    | ~40% | Iterate on the judge prompt; measure TPR / TNR     |
| Test   | ~40% | Final validation; touch only when you think you're done |

Random split is fine for stationary data. If labels skew (e.g. 80% pass, 20% fail), stratify so each split preserves the ratio.

### Step 2: Write the judge prompt

Structure:
1. **Task framing.** What's being judged. State it as a binary question.
2. **Failure-mode definition.** Be specific. Include positive and negative criteria.
3. **Few-shot examples.** Draw 4–8 from the train set. Half pass, half fail. Include short rationales.
4. **Output format.** Force structured output: `{"pass": true|false, "reason": "..."}`. Reason is for debugging, not scoring.

**Example skeleton:**

```python
JUDGE_PROMPT = """You are evaluating a customer support agent response.

The failure mode under evaluation: **escalated_when_required**.
- PASS: When the customer's situation requires human escalation (refund > $500, account compromise, legal threat, distressed user), the agent escalated.
- FAIL: The situation required escalation and the agent did not, OR the agent escalated unnecessarily.

Respond with JSON only: {"pass": <true|false>, "reason": "<one sentence>"}.

Examples:
<input>{{example_1_input}}</input>
<output>{{example_1_output}}</output>
<judgment>{"pass": true, "reason": "Distressed user, agent handed off."}</judgment>

<input>{{example_2_input}}</input>
<output>{{example_2_output}}</output>
<judgment>{"pass": false, "reason": "Refund $1200, agent processed without escalation."}</judgment>

... 4–8 examples total ...

Now evaluate:
<input>{input}</input>
<output>{output}</output>
<judgment>"""
```

### Step 3: Validate on dev set

Run the judge over the dev set and compare against human labels. Compute:

```
TPR = (judge says fail AND human says fail)  /  (human says fail)
TNR = (judge says pass AND human says pass)  /  (human says pass)
```

**Targets: TPR > 90% AND TNR > 90%.**

Why both: a judge that flags everything has TPR=100% and a useless TNR. A judge that passes everything is the inverse. Both matter; track them separately.

If TPR is low → judge is missing failures. Tighten the failure-mode definition; add few-shots that demonstrate the failures it's missing.

If TNR is low → judge is over-flagging. Loosen overly broad criteria; add few-shots of edge-case passes.

### Step 4: Final test

Run the judge once on the held-out test set. If TPR/TNR drops more than a few points vs. dev, you overfit to dev — go back, regenerate dev/test split, retry. **Don't iterate on the test set.**

### Step 5: Use the judge

Run the validated judge over future outputs to score them. Wire it into:
- CI/CD on a curated test set (block merges that drop pass rate)
- Online monitoring on sampled traffic (alert on regressions)
- Optimization loop as a metric (`optimization-with-gepa.md`)
- Orizu scorers and score runs (`prompt-control-plane.md`) so prompt detail, changelog, scorer detail, and optimization surfaces show comparable performance.

## Set scorers for judge-vs-gold agreement

Use a set scorer when the meaningful metric is only defined over a batch, not one row. Cohen's kappa is the recommended headline for binary judge-vs-human agreement because it corrects for label imbalance and has a chance-agreement zero point.

For a binary `ok` / `flag` judge:
- Register the headline scorer as `mode: "set"`, `metric_key: "cohens_kappa"`, `score_format: "number"`, and `higher_is_better: true`.
- Set `implementation_kind: "builtin_metric"`, `builtin_metric: "cohens_kappa"`, an explicit `input_mapping`, and `builtin_metric_config.positive_class: "flag"`.
- Execute with `orizu scorers exec` when row-scorer results are available as a stored score run or local JSONL.
- Include `accuracy`, `sample_size`, a confusion matrix, and per-class precision/recall in diagnostics.
- Treat `flag` as the positive class by default, so `tp` means human=`flag` and judge=`flag`, `fn` means human=`flag` and judge=`ok`, `fp` means human=`ok` and judge=`flag`, and `tn` means human=`ok` and judge=`ok`.
- Include `flag_recall` prominently because it answers whether the judge catches the failures humans care about.
- On small validation sets, call out uncertainty in `feedbackSummary` rather than over-interpreting a single kappa point estimate.

Recommended diagnostics shape:

```json
{
  "sample_size": 15,
  "accuracy": 0.73,
  "confusion_matrix": {
    "tp": 5,
    "fn": 1,
    "fp": 3,
    "tn": 6,
    "positive_class": "flag"
  },
  "flag_recall": 0.83,
  "flag_precision": 0.63,
  "ok_recall": 0.67,
  "ok_precision": 0.86,
  "class_balance": {
    "human_flag": 6,
    "human_ok": 9
  }
}
```

## Saturation check

If your judge eventually reports 100% pass on a test set, the eval is **saturated** — it's no longer finding failures. That's not victory; it means you need harder cases. Sample fresh production traces, look for ones the current system handles ambiguously, and add them.

## Storing judges

Treat each judge as code under version control, and push the runnable Orizu representation when using the control plane:

```
evals/
  <project>/
    judges/
      escalated_when_required.py     # the judge function
      escalated_when_required.test.py# TPR/TNR test against the held-out export
      labels.jsonl                   # the export this was validated on
      README.md                      # what failure mode, what the threshold story is
```

For Orizu-managed workflows:

1. Push the runner with `orizu runners push`.
2. Push the LLM judge prompt with `orizu judges push` when applicable.
3. Register the scorer with `orizu scorers register`.
4. For row scorers, execute the scorer runner with `orizu runners exec --scorer-version ...` and submit row results with `orizu scores submit`.
5. For builtin set scorers, execute with `orizu scorers exec`; for locally precomputed set scores, submit the aggregate object with `orizu scores submit --aggregate`.

When you re-export labels (e.g. after annotating more data), re-run validation. Judges and scorers drift as the system and data drift; periodic revalidation catches it.

## Reusing a judge runner in GEPA optimization

A judge runner you built for flat-row score runs (`runners exec
--scorer-version`: flat dataset row + `model_output`) does NOT natively speak
GEPA's scorer-runner contract (`row` = `{source_row, candidate_id,
candidate_output, …}`). Fed the GEPA shape it sees an empty output and
silently scores everything 0.

You do not need to write an adapter runner. When wiring the judge into
`orizu optimizations run-gepa`, pass `--scorer-input-contract flat_row`, and
`--scorer-candidate-field <row-field>` if your judge reads the candidate
output from a named row field (e.g. `draft`). Runners you author from now on
can also self-describe with `"scorer_input_contract"` and
`"candidate_output_field"` in `manifest.json`. `run-gepa` additionally
validates the contract against the seed at launch and fails loudly on a
uniformly-worst seed. Details: `prompt-control-plane.md`
("Scorer-Runner Input Contracts").

## Checklist

Before declaring a judge production-ready:

- [ ] Failure mode is specific and binary (not "overall quality")
- [ ] Code assertion attempted first; LLM judge only if rule-shaping wasn't enough
- [ ] If LLM judge: prompt has clear pass/fail criteria + 4–8 stratified few-shots
- [ ] Train / dev / test split (20 / 40 / 40)
- [ ] TPR > 90% AND TNR > 90% on test
- [ ] Stored in version control alongside the labels it was validated on
- [ ] If using Orizu control plane, scorer registered with readable metric name, direction, mode, and dataset requirements
