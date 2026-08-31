# Building Judges And Scorers

Turn human-labeled decisions into automated evaluators whose alignment is good
enough for the decision they power. Use this reference for authoring, alignment,
and judge optimization. Use `prompt-control-plane.md` for artifact manifests,
versioning, and score-submission contracts.

## Inputs and terms

Arrive with one of these accepted label inputs:

- a labeled task export: `orizu tasks export --task <taskId> --format jsonl --out labels.jsonl`;
- a versioned golden dataset plus its human-label field mapping; or
- for a mixed dataset, the union of golden field-mapping rows and task-export
  rows, keyed by the primary dataset's `dataset_row_id`.

The downstream judge-building steps are identical for all three forms. Also
arrive with:

- one or more specific binary **failure modes**, such as
  `correctly_identified_issue` or `escalated_when_required`;
- the original dataset row for every label; and
- multiply labeled rows for measuring human–human agreement.

If the labels are Likert scores or an “overall quality” bundle, return to the
**J4 — Ground truth via annotation (conditional)** and rewrite the rubric as one binary question
per failure mode before building a judge.

- A **judge** is the evaluator, often an LLM instruction set plus a runner.
- A **scorer** is the metric contract stored in Orizu. It names the score,
  directionality, mode (`row` or `set`), display format, and implementation.
- Row scorers return per-row scores and feedback. Set scorers compute batch
  metrics such as agreement, precision, recall, F1, or a custom reduction.

## Start with alignment, not a universal threshold

Raw percent agreement is the share of identical decisions, and it can look high
when one label dominates even if the judge learned nothing. **Cohen's kappa** is
chance-corrected agreement, so zero means chance-level agreement. **TPR (true
positive rate)** is the fraction of human-labeled failures the judge catches.
**TNR (true negative rate)** is the fraction of human-labeled passes the judge
correctly leaves unflagged.

Measure kappa, TPR, and TNR separately for every failure mode on judge-test rows.
Always show the confusion matrix, sample count, class balance, and scenario-class
breakdown beside them. A judge that flags everything can have perfect TPR and
useless TNR; a judge that passes everything has the inverse failure. If a
judge-test set contains no positives or no negatives, the corresponding rate is
undefined: collect enough examples of that class before setting or clearing a
bar.

### Measure the human ceiling first

Use only rows with two or more independent labels on the same example. For each
failure mode, compute human–human kappa and inspect the annotator confusion
matrix and directional disagreement. Do not infer the ceiling from single-label
rows or overall agreement. Judge–human kappa should normally land within about
0.05–0.10 of human–human kappa.

When human–human kappa is itself low (below ~0.6), the rubric or labels are the
bottleneck. Return to **J4 — Ground truth via annotation (conditional)**: clarify the
failure-mode definition, add boundary examples, repair the labeler workflow, and
relabel a shared sample. Recompute the human ceiling before changing judge
instructions. Judge tuning against disputed labels only automates the dispute.

### Teach the framework and agree on each bar

The agent presents the observed label balance, human ceiling, confusion costs,
and the following starting points. These are defaults to reason from, not
requirements.

| Decision class | Starting-point threshold (agent + user adjust together) |
| -- | -- |
| **Gatekeeper** — headline metric; informs ship/promote decisions | kappa ≥ 0.75, TPR ≥ 0.90 and TNR ≥ 0.90, and within 0.10 of human–human kappa |
| **Optimization signal** — GEPA reflection and candidate selection | kappa ≥ 0.6 (roughly the 70–80% agreement zone on balanced data). Row-level noise averages out across a run — but the winning candidate must be confirmed against a gatekeeper-grade judge before shipping, or we Goodhart on judge noise |
| **Triage / monitoring** — flags suspect traces for human review | TPR ≥ 0.80 with a tolerable false-positive rate; kappa ≥ 0.4–0.5 usable, because a human reviews every flag |

To clarify the table's rough parenthetical, on balanced data
`kappa = 2 * agreement - 1`: kappa 0.6 is about 80% raw agreement, and the
common 70–80% instinct spans kappa 0.4–0.6, which is why the bar sits at the top
of that zone.

For each judge and failure mode:

1. Choose the decision class: gatekeeper, optimization signal, or triage /
   monitoring.
2. Explain the relevant false-negative and false-positive costs, the human
   ceiling, small-sample uncertainty, and scenario-class gaps.
3. Ask the user which kappa, TPR, TNR or false-positive-rate bars they accept.
   The agent never selects a bar silently.
4. Record the agreed judge trust bar in the judge-validation output before tuning or final
   validation. Include the judge version, failure mode, decision class,
   human–human kappa, each agreed judge trust bar metric, applicable scenario classes, user,
   and decision date.

An agreement record can use this shape:

| Judge version | Failure mode | Decision class | Human–human kappa | Agreed judge trust bar | Scenario classes | Agreed by |
| -- | -- | -- | -- | -- | -- | -- |
| `<version>` | `<mode>` | `<class>` | `<value>` | `kappa …; TPR …; TNR/FPR …` | `<covered classes>` | `<user/date>` |

## Choose and author the evaluator

| Failure mode looks like | Use |
| -- | -- |
| Rule-shaped: tool called, JSON valid, exact format, numeric bound | **Code assertion** |
| Nuanced: resolution was appropriate, tone met policy, escalation was warranted | **LLM judge** |
| Must block before a user sees the response: toxicity or PII leak | **Guardrail** (synchronous code or classifier; not covered here) |

Default to code for genuinely deterministic rules. A mechanically equivalent
assertion, such as schema validation when schema validity is the entire failure
definition, does not need prompt tuning or model-selection statistics. Record
why the assertion is identical to the human-approved rule. If it is gating, it
still needs an agreed judge trust bar and the registered, submitted evidence path from
**J5 — Build & validate judges**. A regex, keyword, or other heuristic is not
tautological merely because it is code; validate it against the human labels
like any other judge.

Example deterministic assertion:

```python
import re

CASE_REF_RE = re.compile(r"\bCASE-\d{6}\b")

def has_case_reference(input: dict, output: dict) -> bool:
    return bool(CASE_REF_RE.search(output["text"]))
```

For a nuanced failure mode, make the LLM judge return one binary decision and a
short reason. Its instructions should contain:

1. the binary question;
2. specific pass and fail criteria;
3. four to eight stratified examples from the training split, including boundary
   cases and short rationales; and
4. a strict JSON result whose label is exactly `ok` or `flag`, such as
   `{"label": "flag", "reason": "Escalation was required but omitted."}`.

For binary gold labels, require that binary verdict rather than a continuous
score. The runner validates the two allowed labels, stores the parsed object as
`model_response`, and emits `passed: label === "ok"`. The canonical kappa
manifest can then read `$dependencies.judge.model_response.label` with `flag` as
the positive class, while `scores submit` can aggregate the top-level `passed`
field. The GEPA alignment scorer uses the same `ok`/`flag` domain when comparing
the candidate verdict with the human label. This strict `label` contract applies
to the Orizu-native path. The external DSPy example in
`optimization-with-gepa.md` wraps the judge with its own `pass` shape at
`return 1.0 if judge_result["pass"] else 0.0`, so its wrapper adapts that shape
rather than expecting native shape parity.

Frame every scorer output so higher means better; for the binary row score,
`ok` maps to 1 and `flag` to 0. Never name a value as a loss or error while also
declaring `higher_is_better: true`, because that gives optimization and
reflection mixed directional signals.

## Split, iterate, and validate

Build the labeled judge pool only from the application's train and validation
rows. Use a stratified split within that pool when labels are imbalanced; the
allocations below are starting points, and the exact judge-development /
judge-test split is yours to define:

| Set | Starting allocation | Purpose |
| -- | -- | -- |
| Judge train (`train`) | ~20% | Few-shot examples or judge-instruction optimization |
| Judge dev / validation (`validation`) | ~40% | Iterate and compare candidates |
| Judge test (`judge-test`) | ~40% | One alignment validation after the judge candidate is frozen |

Author `judge-split.json` with explicit row membership for all three judge
partitions. Every `row_ids` entry must come from the application's train or
validation partition; never include an application final-held-out row. Require
the three judge partitions to be mutually disjoint:

```json
{
  "name": "judge-alignment",
  "strategy": "predefined",
  "seed": null,
  "partitions": [
    { "name": "train", "row_ids": ["<judge-train-row-id>"] },
    { "name": "validation", "row_ids": ["<judge-validation-row-id>"] },
    { "name": "judge-test", "row_ids": ["<judge-test-row-id>"] }
  ]
}
```

Materialize that judge split set and record the returned `split_set_id` as
`<judge-split-set-id>`:

```bash
orizu datasets splits create <datasetVersionId> --from-file <judge-split.json> --json
```

Keep the local `judge-split.json` and the source application split-membership
artifact in version control. Before materializing, record that the judge
partitions are pairwise disjoint, their union is a subset of application train
plus validation, and their union has zero intersection with application
final-held-out. That recorded comparison and `judge-split.json` are the
auditable row-membership evidence proving final-held-out exclusion.

On development rows, inspect false negatives when TPR is weak and false positives
when TNR is weak. Fix the failure-mode criteria and boundary examples, then rerun
development evaluation. Preserve judge-test until the candidate and agreed judge trust bar
are frozen. If judge-test alignment falls materially below development, treat
that as overfitting and return to a new development cycle rather than iterating
on judge-test rows.

The application final-held-out partition reserved for the single
seed-versus-selected comparison in the dataset-design reference (J3) never
appears in judge train, judge dev, judge test, or any other judge-alignment
material. A judge selected for agreement on those rows would bias the final
comparison through the judge itself. Those rows need no human labels. At the
**J6 — Optimize & promote**, the accepted judge scores the application
final-held-out rows exactly once for that comparison; this application scoring
is not judge-alignment measurement or tuning.

A 100% pass rate is a saturation warning, not evidence of alignment. Sample
fresh production traces and add harder scenario classes when an evaluator stops
finding meaningful failures.

## Register and submit the validation evidence

Store evaluator code, instructions, manifests, validation records, and the labels
used to validate them in version control. Use `prompt-control-plane.md` for the
manifest bodies and artifact boundaries. A typical local layout is:

```text
evals/<project>/
  judge-split.json
  judge-optimizer/
  judges/<failure-mode>/
    judge/
    runner/
    alignment-runner/
    orizu.instruction-set.json
    row-scorer.manifest.json
    kappa-scorer.manifest.json
    alignment-row-scorer.manifest.json
    judge-validation.md
```

In a local workflow under the user's token, push the executable artifacts and
register both the row scorer used for per-example feedback and the set scorer
used for kappa plus confusion diagnostics. Hosted sessions follow the artifact
authority and commit rules in `authority-map.md`. Substitute IDs returned by each
command in subsequent commands:

For a custom deterministic code assertion that must complete the submitted J5
evidence path, use the executable `prompt_runner` control-plane shape. The
runner implements the assertion without calling an LLM; the judge artifact is
its versioned execution contract and output-schema identity. A `runner_only`
scorer can be registered, but the current CLI cannot execute it through either
`runners exec --scorer-version` or `scorers exec`, so it cannot satisfy this
recipe.

Set the row-scorer manifest's `implementation_kind: prompt_runner`, set the
dependent set-scorer manifest's `implementation_kind: builtin_metric`, and use
the IDs returned by each command in the next command:

```bash
orizu runners push ./evals/<project>/judges/<failure-mode>/runner --project <team/project> --name <code-assertion-runner-name> --json

orizu judges push ./evals/<project>/judges/<failure-mode>/judge --project <team/project> --runner-version <code-assertion-runner-version-id> --json

orizu scorers register --project <team/project> --name <code-assertion-row-scorer-name> --manifest ./evals/<project>/judges/<failure-mode>/row-scorer.manifest.json --prompt-version <code-assertion-judge-version-id> --runner-version <code-assertion-runner-version-id> --json

# Set the dependency whose `alias` is `judge` in `kappa-scorer.manifest.json`: its `dependencies[].scorer_version_id` must be `<code-assertion-row-scorer-version-id>` before registering the dependent set scorer.
orizu scorers register --project <team/project> --name <code-assertion-kappa-scorer-name> --manifest ./evals/<project>/judges/<failure-mode>/kappa-scorer.manifest.json --json

orizu runners exec --scorer-version <code-assertion-row-scorer-version-id> --dataset-version <dataset-version-id> --split-set <judge-split-set-id> --split judge-test --runner-dir ./evals/<project>/judges/<failure-mode>/runner --out ./code-assertion-judge-test-results.jsonl

orizu scores submit ./code-assertion-judge-test-results.jsonl --project <team/project> --scorer-version <code-assertion-row-scorer-version-id> --subject-version <code-assertion-judge-version-id> --dataset-version <dataset-version-id> --split-set <judge-split-set-id> --split judge-test --json

orizu scorers exec --project <team/project> --scorer-version <code-assertion-kappa-scorer-version-id> --subject-version <code-assertion-judge-version-id> --dataset-version <dataset-version-id> --split-set <judge-split-set-id> --split judge-test --dependency-score-run judge=<code-assertion-row-score-run-id> --out ./code-assertion-judge-test-alignment.json --json
```

For an LLM judge, register the prompt-backed row scorer and its dependent set
scorer:

```bash
orizu runners push ./evals/<project>/judges/<failure-mode>/runner --project <team/project> --name <judge-runner-name> --json

orizu judges push ./evals/<project>/judges/<failure-mode>/judge --project <team/project> --runner-version <judge-runner-version-id> --json

orizu scorers register --project <team/project> --name <row-scorer-name> --manifest ./evals/<project>/judges/<failure-mode>/row-scorer.manifest.json --prompt-version <judge-version-id> --runner-version <judge-runner-version-id> --json

orizu scorers register --project <team/project> --name <kappa-scorer-name> --manifest ./evals/<project>/judges/<failure-mode>/kappa-scorer.manifest.json --json
```

For the LLM judge-test split, execute the row scorer, submit its row results,
and then execute the dependent set scorer. `scorers exec` submits the aggregate
score run by default, so omit `--no-submit` at the J5 — Build & validate judges
boundary. See `prompt-control-plane.md` for the canonical submission behavior:

```bash
orizu runners exec --scorer-version <row-scorer-version-id> --dataset-version <dataset-version-id> --split-set <judge-split-set-id> --split judge-test --runner-dir ./evals/<project>/judges/<failure-mode>/runner --out ./judge-test-results.jsonl

orizu scores submit ./judge-test-results.jsonl --project <team/project> --scorer-version <row-scorer-version-id> --subject-version <judge-version-id> --dataset-version <dataset-version-id> --split-set <judge-split-set-id> --split judge-test --json

orizu scorers exec --project <team/project> --scorer-version <kappa-scorer-version-id> --subject-version <judge-version-id> --dataset-version <dataset-version-id> --split-set <judge-split-set-id> --split judge-test --dependency-score-run judge=<row-score-run-id> --out ./judge-test-alignment.json --json
```

Inspect the submitted set score run, not only the local file. The stored evidence
must identify the submitted row-score dependency and contain measured row
evidence from which kappa, TPR, TNR, and the confusion matrix can be checked.
Store the separately computed scenario-class slices beside it. Record every
achieved value beside the agreed judge trust bar. Both `scores submit` and the submitting
`scorers exec` store `agent_reported` evidence, which is never
execution-verified. Hand the resulting set `<score-run-id>` to a human curator
for acceptance:

```bash
# Human-only handoff: the agent prepares this exact command; the curator runs it.
orizu scores accept <score-run-id> --project <team/project> --json
```

J5 — Build & validate judges is complete only when every gating judge clears its
agreed judge trust bar, the scorer versions are registered, `runners exec`, `scores submit`,
and the measured `scorers exec` run have all succeeded, and the human curator has
accepted that score run. Gate decisions only on accepted evidence. A locally
computed alignment report with no accepted Orizu score run does not clear the
trust bar.

Re-run this evidence path after labels, judge instructions, runners, or scorer
definitions change. Builtin set scorers, their dependency mapping, and aggregate
submission behavior are specified in `prompt-control-plane.md`.

## Optimize the judge instructions with GEPA

Judge building is itself an optimization problem. Optimize the LLM judge's own
instructions against human labels; do not optimize it against its own previous
decisions.

Manage a composite judge as one `orizu instructions` instruction set. Components
can separate the rubric, boundary examples, output contract, and failure-mode
rules, while the complete component map remains the candidate. The candidate
runner executes those candidate judge instructions on human-labeled train and
validation rows. The row-mode alignment scorer compares the binary candidate
decision with the human label and returns per-row feedback for reflection.

Materialize those components in `orizu.instruction-set.json` before GEPA. Create
the stable instruction set once, or push a revised seed for a later optimization
cycle. `authority-map.md` is authoritative for who runs each mutation; hosted sessions
prepare the manifest and exact human handoff:

```bash
# Local surface (agent-allowed under the user's token): see `authority-map.md`.
orizu instructions create ./evals/<project>/judges/<failure-mode>/orizu.instruction-set.json --project <team/project> --model-config <provider/model> --json

# Local surface (agent-allowed under the user's token): see `authority-map.md`.
orizu instructions push ./evals/<project>/judges/<failure-mode>/orizu.instruction-set.json --project <team/project> --set <judge-instruction-set> --json
```

Use the instruction-set name returned by `create`, or the stable set named by
`push`, as `<judge-instruction-set>` below.

In that same local workflow, push the optimizer implementation, then run GEPA
against that judge instruction set and one model-config profile:

```bash
orizu runners push ./evals/<project>/judges/<failure-mode>/alignment-runner --project <team/project> --name <alignment-runner-name> --json

orizu scorers register --project <team/project> --name <alignment-row-scorer-name> --manifest ./evals/<project>/judges/<failure-mode>/alignment-row-scorer.manifest.json --runner-version <alignment-runner-version-id> --json

orizu optimizers push ./evals/<project>/judge-optimizer --project <team/project> --name <judge-optimizer-name> --json

orizu optimizations run-gepa --project <team/project> --optimizer-version-id <optimizer-version-id> --instruction-set <judge-instruction-set> --model-config <provider/model> --component-selector all --runner-version-id <judge-runner-version-id> --candidate-runner-dir ./evals/<project>/judges/<failure-mode>/runner --scorer-version-id <alignment-row-scorer-version-id> --scorer-runner-version-id <alignment-runner-version-id> --scorer-runner-dir ./evals/<project>/judges/<failure-mode>/alignment-runner --scorer-input-contract gepa --dataset-version-id <dataset-version-id> --split-set-id <judge-split-set-id> --train-split train --val-split validation --engine official --budget medium --reflection-max-tokens <n> --log-dir logs/judge-gepa
```

`round-robin` is the default component selector and updates one mutable component
per round. The walkthrough explicitly chooses `--component-selector all`, the
alternative that updates every mutable component for a candidate. One run
accepts one alignment scorer, so report each failure mode against its own agreed
bar; an aggregate optimization score cannot waive a regression.
Every component passed to judge GEPA must be inline and materialized; the
official connector refuses an instruction set profile with pinned components.
Keep judge-test outside GEPA. The command records the best candidate and
local logs; it does not push a new judge or instruction set version.

After a human accepts the optimized components, materialize the complete map in
`orizu.instruction-set.json`. Read
`<printed-local-log-directory>/result.json`; `--log-dir` names a root and the
logger appends the optimization run ID, so use the directory printed by the
completed run rather than joining the root directly to the filename. For a
one-component candidate, `best_candidate_text` is a bare string: copy it to
that one component. For a multi-component candidate, `best_candidate_text` is
the complete component map; require it to cover the instruction set's complete
shape and copy that accepted map into the manifest. There is no separate
component-to-judge materializer command. The judge runner's own file layout is
the materializer: write every accepted component value, byte for byte, to the
exact instruction file that the runner project's manifest maps to that
component. That mapping is a project-specific runner contract, not a standard
Orizu runner-manifest field. Then use the runner's deterministic composition
rule to update the single primary body in `judge/` from those same files.

Those file changes produce new runner bytes. Under the user's token, push them
as a fresh runner version before parity; `runners exec --runner-dir` verifies
the directory against its registered version and will not execute an altered
copy of the old version:

```bash
orizu runners push ./evals/<project>/judges/<failure-mode>/runner --project <team/project> --name <judge-runner-name> --json
```

The judge runner resolves instruction text from the input
`instruction_set.components` when present, as GEPA candidate execution requires,
and otherwise from its bundled instruction files—never from server
`prompt.body`. The parity exec-context therefore carries the superseded server
`prompt.body` by design; when candidate `instruction_set.components` are absent,
the runner's bundled, materialized files are what execute.

Parity-check that new runner version on a small existing development /
validation split containing a handful of row IDs evaluated for the winning
candidate:

```bash
orizu runners exec --prompt-version <current-judge-version-id> --runner-version <materialized-judge-runner-version-id> --dataset-version <dataset-version-id> --split-set <parity-split-set-id> --split <parity-split-name> --runner-dir ./evals/<project>/judges/<failure-mode>/runner --out ./accepted-judge-parity.jsonl
```

Match those row IDs to the winning candidate's entries in
`<printed-local-log-directory>/evaluations.jsonl` and compare each recorded `output` with the
parity run's normalized parsed judge decision. Preserve the winning run's model
settings; an unexplained decision mismatch means the accepted map was not
reproduced and blocks publication. Orizu has no profile-capable validation
surface today; this local runner parity check is required before reducing the
component map to the composed primary body that `judges push` publishes.

Only after parity holds, publish fresh instruction and judge versions before
touching judge-test. Under the user's token, the local sequence is:

```bash
# Local surface (agent-allowed under the user's token): see `authority-map.md`.
orizu instructions push ./evals/<project>/judges/<failure-mode>/orizu.instruction-set.json --project <team/project> --set <judge-instruction-set> --json

orizu judges push ./evals/<project>/judges/<failure-mode>/judge --project <team/project> --runner-version <materialized-judge-runner-version-id> --json

orizu scorers register --project <team/project> --name <row-scorer-name> --manifest ./evals/<project>/judges/<failure-mode>/row-scorer.manifest.json --prompt-version <new-judge-version-id> --runner-version <materialized-judge-runner-version-id> --json
```

Update `kappa-scorer.manifest.json` so the `judge` dependency's
`dependencies[].scorer_version_id` is `<new-row-scorer-version-id>`, then
register a new set-scorer version before supplying that dependency run:

```bash
orizu scorers register --project <team/project> --name <kappa-scorer-name> --manifest ./evals/<project>/judges/<failure-mode>/kappa-scorer.manifest.json --json

orizu runners exec --scorer-version <new-row-scorer-version-id> --dataset-version <dataset-version-id> --split-set <judge-split-set-id> --split judge-test --runner-dir ./evals/<project>/judges/<failure-mode>/runner --out ./new-judge-test-results.jsonl

orizu scores submit ./new-judge-test-results.jsonl --project <team/project> --scorer-version <new-row-scorer-version-id> --subject-version <new-judge-version-id> --dataset-version <dataset-version-id> --split-set <judge-split-set-id> --split judge-test --json

orizu scorers exec --project <team/project> --scorer-version <new-kappa-scorer-version-id> --subject-version <new-judge-version-id> --dataset-version <dataset-version-id> --split-set <judge-split-set-id> --split judge-test --dependency-score-run judge=<new-row-score-run-id> --out ./new-judge-test-alignment.json --json

# Human-only handoff: the agent prepares this exact command; the curator runs it.
orizu scores accept <new-set-score-run-id> --project <team/project> --json
```

The materialized `runners push` must return a fresh runner version. `judges push`
must return a new judge version (and therefore a new prompt version), and the
two `scorers register` commands must return row- and set-scorer versions bound
through the new runner and updated dependency.
The instruction-set/profile version is not a valid `--subject-version`; both
submitted judge-test commands above deliberately use `<new-judge-version-id>`.
Require human acceptance and gatekeeper-grade judge-test validation for any ship
or promotion decision even when the judge used for reflection met only the
optimization-signal judge trust bar. Hosted sessions commit the accepted component map and
follow the handoff boundary in `authority-map.md`.

The default GEPA scorer contract supplies a GEPA-shaped row containing
`source_row`, `candidate_id`, and `candidate_output`. If reusing a scorer runner
built for flat score-run rows, pass `--scorer-input-contract flat_row` and, when
the output belongs in a named row field, `--scorer-candidate-field <row-field>`.
A runner manifest can instead declare `scorer_input_contract` and
`candidate_output_field`. The CLI validates the active contract on the seed and
refuses a uniformly worst seed by default. Read “Scorer-Runner Input Contracts”
in `prompt-control-plane.md` before choosing either contract.

## Exit criterion checklist

- [ ] Each failure mode is binary and has adequate positive and negative rows.
- [ ] Human–human kappa is computed from multiply labeled rows; low agreement
      routes back to rubric and label repair.
- [ ] Kappa, TPR, TNR, confusion matrix, sample size, class balance, and
      scenario-class results are reported per failure mode.
- [ ] The agent taught the decision-class tradeoffs, the user chose each
      judge trust bar, and the agreed value is recorded in the output.
- [ ] Development rows were used for iteration and judge-test was used only
      after the candidate was frozen.
- [ ] The application final-held-out partition was excluded from all judge
      material and is reserved for one accepted-judge scoring pass at J6.
- [ ] The versioned judge and runners are stored; row and set scorers are
      registered.
- [ ] `runners exec` evidence was submitted with `scores submit`, and a measured
      `scorers exec` result was submitted, inspected, and accepted by a human
      curator before gating decisions.
- [ ] Any GEPA judge optimization targeted the judge's own complete instruction
      set against human labels, followed by gatekeeper-grade judge-test
      validation.
