# Migrating an existing GEPA setup into Orizu

For a customer already running official GEPA from a plain script — inline
`trainset`/`valset`, seed component values in a dict, and their own
`metric(row, output)`. The dict becomes one instruction-set profile: its keys
become the set's fixed shape, and its values become that profile's components.
Use `orizu instructions` as the only creation and update path for those
customer-owned instructions. Prepare the complete manifest, then follow the
[Authority map](authority-map.md) for its mutations.

The ordering rule: **nothing is optimized until parity is proven.** The last
step before `run-gepa` is always `orizu scorers verify-parity`, which runs the
migrated scorer runner under the exact payload `run-gepa` sends it and the
customer's original metric over the same rows, and exits 0 only if they agree.

Commands are shown with `--local`; drop it against a hosted server and follow
the Authority map for surface-specific execution and hand-offs.

## 0. Read their script

Note the row shape and which field is the stable id, `trainset`/`valset`
membership, the seed component map, the metric's `module:function`, and what it
returns (a float, a dict with `score`, or GEPA's `EvaluationResult` — all three
are accepted; `objective_scores` is ignored). If rows have no stable id, add
one now: every step below pairs on it.

## 1. Set up, then export the rows

```bash
orizu setup --team <team-slug> --project <project-slug>
```

One dataset holds every row; require four disjoint, nonempty partitions:
`TRAINSET`, `VALSET`, `PARITYSET`, and `FINAL_HELD_OUT`. Mirror existing
train/validation membership exactly. Here, `parity` is a migration-only
auxiliary partition, not an application partition; the canonical dataset-design
application doctrine remains train, validation, and final-held-out. Source and
approve representative `PARITYSET` rows before reserving final-held-out, then
reserve `FINAL_HELD_OUT` only from the remaining rows. Apply First win's dataset-coverage
discipline:
every named scenario class must have nonzero train, validation, and
final-held-out counts. Stop when that coverage, ordering, or four-way
disjointness cannot be proven; a resampled or overlapping split makes later
comparisons invalid.

```python
import json
partitions = {
    "train": TRAINSET,
    "validation": VALSET,
    "parity": PARITYSET,
    "final-held-out": FINAL_HELD_OUT,
}
if any(not partition for partition in partitions.values()):
    raise ValueError("train, validation, parity, and final-held-out must be nonempty")
partition_ids = {
    name: [row["id"] for row in partition]
    for name, partition in partitions.items()
}
all_ids = [row_id for ids in partition_ids.values() for row_id in ids]
if len(all_ids) != len(set(all_ids)):
    raise ValueError("train, validation, parity, and final-held-out must be disjoint")
rows = [row for partition in partitions.values() for row in partition]
with open("dataset.jsonl", "w") as handle:
    for row in rows:
        handle.write(json.dumps(row) + "\n")
with open("split.json", "w") as handle:
    json.dump({"name": "default", "strategy": "predefined", "seed": 42, "partitions": [
        {"name": name, "row_ids": row_ids}
        for name, row_ids in partition_ids.items()
    ]}, handle)
```

## 2. Upload, version, split

```bash
orizu --local datasets upload --file ./dataset.jsonl \
  --project <team>/<project> --name "GEPA migration rows" --json

orizu --local datasets splits create <upload-returned-dataset-version-id> \
  --from-file ./split.json --json                   # -> split_set_id
```

Upload creates the initial `v1` snapshot. Capture its returned `dataset_version_id` and use that ID directly for split creation; reserve `datasets versions create` for later snapshots with a different label.

`--from-file` preserves their partitions; the ratio flags
(`--train/--validation/--test`) resample and must not be used here.

## 3. Candidate runner and seed instruction set

The candidate runner does what `task_lm` did: candidate profile + row ->
output. A one-component profile keeps the single-body runner contract. For a
multi-component profile, read the complete map from
`input["instruction_set"]["components"]`; components belong only to this
profile and are never shared across profiles or sets.

```bash
orizu --local runners push ./candidate-runner \
  --project <team>/<project> --name gepa-candidate-runner --json

orizu --local instructions create ./orizu.instruction-set.json \
  --project <team>/<project> \
  --runner-version <candidate-runner-version-id> \
  --model-config <provider/model> --json
```

The agent-created runner version is unlabeled. No standalone runner-label command exists. Following the [Authority map](authority-map.md), if a human accepts its exact ID as default, the human curator runs `orizu --local runners pull gepa-candidate-runner --project <team>/<project> --version <candidate-runner-version-id> --out ./candidate-runner-default-handoff`, leaves that fresh exact-version directory unchanged, then runs `orizu --local runners push ./candidate-runner-default-handoff --project <team>/<project> --name gepa-candidate-runner --label default --json`. The manifest
carries the set's `name`, human-readable `description`, fixed `shape`, and component values. Put each original dict
value in a file without changing its bytes. This one-component example maps
the old `system` key to `system.md`:

```json
{
  "name": "gepa-agent-instructions",
  "description": "Instructions for the migrated GEPA application",
  "shape": ["system"],
  "components": [
    { "key": "system", "path": "./system.md" }
  ]
}
```

For a multi-component seed, list every original key once in `shape`, in stable
order, and add one component entry per key. `--model-config` selects the
profile whose seed is created; it must name an existing model config with the
same settings used by the original script. The JSON result includes the set's
stable `slug` and its default profile version. Record the slug — later reads,
optimization, archiving, and restoration should use it even if the display
name changes.

## 4. Wrap their metric in a scorer runner

Do not rewrite the metric — wrap it, or parity is unachievable by construction.
`scorer-runner/manifest.json` declares
`"command": ["python3", "runner.py"]` and `"scorer_input_contract": "flat_row"`.
Under `flat_row`, `input["row"]` is the dataset row with the candidate output
injected at `model_output` (or the `--scorer-candidate-field` field) and
`input["model_output"]` is that same output, so `runner.py` is two lines:
`result = metric(payload["row"], payload["model_output"])`, then write the score
to `ORIZU_RUNNER_OUTPUT_PATH`. Extract it the same three ways `verify-parity`
extracts the original metric's result, or the two sides disagree on a shape step
0 says is supported:

```python
score = result["score"] if isinstance(result, dict) else getattr(result, "score", result)
json.dump({"score": float(score)}, open(os.environ["ORIZU_RUNNER_OUTPUT_PATH"], "w"))
```

A bare `float(getattr(result, "score", result))` raises `TypeError` on the dict
form, failing every row here and again under `run-gepa`.

**If the metric lives inside their script, extract it first.** The one-file
shape in step 0 usually defines `metric` inside `optimize.py` next to
`import gepa`; vendoring that file into the runner drags the `gepa` import into
the scrubbed runner environment and every row raises `ModuleNotFoundError`. Move
the function to a `metric.py` with no optimizer imports and have `optimize.py`
do `from metric import metric` — their script keeps working unchanged, the
runner copy carries no dependencies, and `--original metric:metric` is valid for
both. (`docs/requirements/official-gepa/stranger/` ships this two-file shape.)

**Copy the metric module into `./scorer-runner/` before pushing.** The runner
executes with its working directory set to the *materialized runner version* and
a scrubbed environment, so the `metric.py` sitting next to their `optimize.py`
is not importable — a runner that does `import metric` raises
`ModuleNotFoundError` on every row, here and again under `run-gepa`. Vendor the
file (or the whole package) into the runner directory so the registered runner
bytes contain everything the metric needs:

```bash
cp ./metric.py ./scorer-runner/metric.py     # or: cp -R ./their_package ./scorer-runner/
```

`verify-parity` still imports the customer's ORIGINAL metric from the current
directory, so the two copies must be the same file — re-copy whenever it changes,
or the parity you prove is against a stale runner.

A DSPy metric is `metric(example, pred)`; the 3-line adapter is:

```python
def metric(row, model_output):                      # what verify-parity calls
    import dspy
    return dspy_metric(dspy.Example(**row), dspy.Prediction(answer=model_output))
```

```bash
orizu --local runners push ./scorer-runner \
  --project <team>/<project> --name gepa-scorer-runner --json

orizu --local judges push ./judge \
  --project <team>/<project> --runner-version <scorer-runner-version-id> --json

orizu --local scorers register --project <team>/<project> \
  --name gepa-migrated-metric --manifest ./scorer.manifest.json \
  --prompt-version <judge-version-id> \
  --runner-version <scorer-runner-version-id> --json # -> scorer_version_id
```

Both agent-created versions are unlabeled. For accepted versions, a human curator materializes the exact runner with `orizu --local runners pull gepa-scorer-runner --project <team>/<project> --version <scorer-runner-version-id> --out ./scorer-runner-default-handoff`, leaves that fresh directory unchanged, runs `orizu --local runners push ./scorer-runner-default-handoff --project <team>/<project> --name gepa-scorer-runner --label default --json`, then runs `orizu --local scorers labels set gepa-migrated-metric production --version <scorer-version-id> --project <team>/<project> --json`. `scorer.manifest.json` needs all four fields below;
`app/api/cli/scorers/route.ts` rejects a manifest missing `implementation_kind`
or `metric_key`, and `mode` must be `row` or `set`:

```json
{
  "name": "gepa-migrated-metric",
  "mode": "row",
  "implementation_kind": "prompt_runner",
  "metric_key": "score"
}
```

`prompt_runner` is the only implementation kind that `runners exec
--scorer-version` and `verify-parity` can execute, and the scorer contract
currently names its backing judge artifact with `--prompt-version`. That flag
receives the `prompt_version_id` returned by `orizu judges push`; do not replace
the judge command with a standalone prompt mutation.

For an LLM metric, `./judge` contains the evaluator rubric the scorer runner
executes. For a pure-code metric, keep a short judge rubric that documents the
deterministic rule and expected output, even though the runner does not read
its body. The judge is the evaluator artifact; the scorer is the metric
contract that gives its numeric result a name, mode, and direction.

## 5. Freeze the original setup's outputs

A scorer scores *(row, output)*, so parity needs one candidate output per row
in its development corpus. Use the customer's existing script to run its
original `task_lm` once with the unchanged seed component map on train,
validation, and the mandatory `parity` partition, and record the exact output
passed to `metric(row, output)`. Write `outputs-train.jsonl`,
`outputs-validation.jsonl`, and `outputs-parity.jsonl`. Each JSONL row is:

```json
{"row_id":"<the row's stable id>","model_output":"<the exact output>"}
```

Do not produce this evidence by running the migrated scorer or by starting an
optimization. The output is a fixed subject shared by the original metric and
the migrated scorer, so a mismatch isolates the scorer migration rather than
mixing in candidate-runner or provider drift. Keep final-held-out outside this
evidence. After scorer parity is proven, characterize the candidate runner
separately against the same parity rows before starting GEPA.

Each parity output file must cover exactly the rows being checked: a
missing or extra `row_id`, a duplicate, or a non-string `model_output` is
refused before anything runs.

## 6. Prove parity

```bash
orizu --local scorers verify-parity \
  --scorer-version <scorer-version-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id> --split validation \
  --outputs ./outputs-validation.jsonl \
  --original metric:metric \
  --json

orizu --local scorers verify-parity \
  --scorer-version <scorer-version-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id> --split parity \
  --outputs ./outputs-parity.jsonl \
  --original metric:metric \
  --json
```

- `--original <module>:<function>` is imported from the **current directory**,
  so run this where their script lives.
- The input contract and candidate field resolve exactly as `run-gepa` resolves
  them: flag > runner manifest (`scorer_input_contract`,
  `candidate_output_field`) > defaults (`gepa`, `model_output`). Because a
  `gepa`-contract runner is fed a different payload shape entirely,
  verify-parity refuses anything that does not resolve to `flat_row` — declare
  `"scorer_input_contract": "flat_row"` in the runner manifest (step 4) or pass
  `--scorer-input-contract flat_row`, and pass the SAME value to `run-gepa`.
- `--scorer-candidate-field <field>` when the judge reads the candidate from a
  row field other than `model_output` — the same value you pass to `run-gepa`.
  It may not be blank.
- `--tolerance <float>` defaults to `0` (exact). Raise it only for a genuinely
  non-deterministic metric, and say so in the report.
- `--python <cmd>` picks the interpreter (else `PYTHON`, else `python3`). The
  metric runs in the customer's own unscrubbed environment, so an LLM-judge
  metric still sees its API keys.
- `--runner-dir <dir>` runs local scorer-runner bytes, but only if they hash to
  the registered runner version; drifted bytes exit 2.
- `--limit <n>` checks the first N rows of the partition — a smoke check, not
  the proof: it always reports `parity: false` with `scope: {compared, total}`,
  so a limited run can never be mistaken for a full one. The full partition's
  output file works: outputs must cover the limited rows, belong to the split,
  and need not be trimmed to N.
- A repeated option takes its LAST value, matching run-gepa's scalar options.
- If a sampled row already has the candidate field as a key, the command exits 2
  rather than overwriting a value the original metric reads.

Exit `0` parity proven (>= 1 row compared, no mismatch, no row error); `1` at
least one mismatch or row error — read `mismatches`/`errors` in the `--json`
report, fix the runner, repeat; `2` the check could not run (bad arguments, no
rows, unverified runner dir, original metric not importable).

Do not continue on exit 1 or 2. A scorer that disagrees with their metric
optimizes the wrong thing, and every number afterwards is wrong.

**Prove parity on train, validation, and parity before declaring the scorer
migrated.** `run-gepa` scores train and validation, and training rows drive
GEPA's proposals: a scorer that agrees on validation but diverges on a
different schema branch changes the experiment's result while passing this
gate. Repeat the command with `--split train` and `outputs-train.jsonl`; the
explicit `parity` command above covers the independently selected corpus.
Require exit 0 on all three parity runs.

Keep final-held-out untouched until Promote. It is exercised exactly once, at the
final seed-vs-selected comparison, by the already-parity-proven scorer and
supplies no scorer-development feedback.

A `parity: true` report means every row of that partition was compared and
agreed. A limited run reports `parity: false` with
`scope: {compared, total}` and the line "Smoke check passed on N of M rows"
— it exits 0, but it is not the proof.

## Router handoff after parity

When the router sends an existing setup here, stop after all three scorer parity checks pass. Open `flows/first-win.md`; do not continue directly to section 7. First win owns the validated-judge optimization run, and `flows/promote.md` separately owns its report, validation, and human promotion decision. The remaining sections are reference detail only when the active flow explicitly reaches them.

## 7. Optimizer and run

```bash
orizu --local optimizers push ./optimizer \
  --project <team>/<project> --name gepa-optimizer --json

orizu --local optimizations run-gepa \
  --project <team>/<project> \
  --optimizer-version-id <optimizer-version-id> \
  --instruction-set <instruction-set-slug> \
  --model-config <provider/model> \
  --component-selector round-robin \
  --runner-version-id <candidate-runner-version-id> \
  --candidate-runner-dir ./candidate-runner \
  --scorer-version-id <scorer-version-id> \
  --scorer-runner-version-id <scorer-runner-version-id> \
  --scorer-runner-dir ./scorer-runner \
  --dataset-version-id <dataset-version-id> \
  --split-set-id <split-set-id> \
  --train-split train --val-split validation \
  --scorer-input-contract flat_row \
  --reflection-max-tokens 8192 \
  --engine official
```

`--reflection-max-tokens` is not optional here: with `--engine official` the
reflection model defaults to `anthropic/claude-opus-4-7`, and every non-`openai/`
reflection model is refused at launch without it
(`packages/cli/src/gepa-engine-dispatch.ts:301-304`, again at
`packages/orizu-gepa/src/orizu_gepa_connector/runtime.py:193-196`). Drop it only
if you also pass an `openai/...` `--reflection-model`.

`--instruction-set` and `--model-config` select exactly one profile. The CLI
uses that profile's production version when it has one and otherwise uses the
set default; it refuses the legacy `--candidate-version-id` selector when the
instruction-set selectors are present. `round-robin` updates one component per
round; use `--component-selector all` only when every component should be
reflected on each round.

`./optimizer` needs `manifest.json` with `"optimizer_family": "gepa"`. See
`references/optimization-with-gepa.md` for reflection-model and budget flags.
Pass `--scorer-candidate-field <field>` here too if you passed it to
`verify-parity`: the payload the runner sees must be the one parity was proven
under. Select one candidate on validation evidence, then reserve one final-held-out seed-versus-selected-candidate comparison for the promotion decision.
Write and attach the optimization report, then obtain the human decision. Following the [Authority map](authority-map.md), in the simpler one-shot path a human curator runs `orizu --local optimizations promote <run-id> --candidate <candidate-id> --label production --project <team>/<project> --json` after acceptance. In the equivalent two-stage path for separate materialization, the coding agent materializes once with the unlabeled command below.

```bash
orizu --local optimizations promote <run-id> --candidate <candidate-id> \
  --project <team>/<project> --json
```

A human curator re-runs the same promotion as `orizu --local optimizations promote <run-id> --candidate <candidate-id> --label production --project <team>/<project> --json`. The idempotent finalizer finds the existing profile version by run and candidate provenance, moves production to it, and creates no duplicate profile version or candidate-promoted event.
