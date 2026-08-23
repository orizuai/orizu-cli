# Migrating an existing GEPA setup into Orizu

For a customer already running official GEPA from a plain script — inline
`trainset`/`valset`, a seed prompt in a dict, their own `metric(row, output)`.

The ordering rule: **nothing is optimized until parity is proven.** The last
step before `run-gepa` is always `orizu scorers verify-parity`, which runs the
migrated scorer runner under the exact payload `run-gepa` sends it and the
customer's original metric over the same rows, and exits 0 only if they agree.

Commands are shown with `--local`; drop it against a hosted server.

## 0. Read their script

Note the row shape and which field is the stable id, `trainset`/`valset`
membership, the seed candidate text, the metric's `module:function`, and what
it returns (a float, a dict with `score`, or GEPA's `EvaluationResult` — all
three are accepted; `objective_scores` is ignored). If rows have no stable id,
add one now: every step below pairs on it.

## 1. Set up, then export the rows

```bash
orizu setup --team <team-slug>
```

One dataset holds every row; the split set decides train vs validation. Dump
rows verbatim from their script, and mirror their lists exactly — a resampled
split makes every later number incomparable with the numbers they have.

Build the dataset from the **id-deduplicated union**: a row reused in both
`TRAINSET` and `VALSET` would otherwise be written twice, and the upload route
rejects duplicate canonical row ids (`app/api/datasets/route.ts:206-211`,
"csvData must contain unique canonical row ids"). The partition lists keep the
original ids independently, so a shared row can still appear in both.

```python
import json
seen, rows = set(), []
for row in TRAINSET + VALSET:
    if row["id"] in seen:
        continue
    seen.add(row["id"])
    rows.append(row)
with open("dataset.jsonl", "w") as handle:
    for row in rows:
        handle.write(json.dumps(row) + "\n")
with open("split.json", "w") as handle:
    json.dump({"name": "default", "strategy": "predefined", "seed": 42, "partitions": [
        {"name": "train", "row_ids": [row["id"] for row in TRAINSET]},
        {"name": "validation", "row_ids": [row["id"] for row in VALSET]},
        {"name": "test", "row_ids": []},
    ]}, handle)
```

## 2. Upload, version, split

```bash
orizu --local datasets upload --file ./dataset.jsonl \
  --project <team>/<project> --name "GEPA migration rows" --json

orizu --local datasets versions create <dataset-id-or-name> \
  --project <team>/<project> --label v1 --json      # -> dataset_version_id

orizu --local datasets splits create <dataset-version-id> \
  --from-file ./split.json --json                   # -> split_set_id
```

`--from-file` preserves their partitions; the ratio flags
(`--train/--validation/--test`) resample and must not be used here.

## 3. Candidate runner and seed prompt

The candidate runner does what `task_lm` did: candidate prompt + row -> output.

```bash
orizu --local runners push ./candidate-runner \
  --project <team>/<project> --name gepa-candidate-runner --label default --json

orizu --local prompts push ./prompt \
  --project <team>/<project> --runner-version <candidate-runner-version-id> --json
```

`./prompt` holds `orizu.prompt.json` plus the body file it names. Only `name`
is enforced (`app/api/cli/prompts/route.ts:220-221`); `body_file` defaults to
`prompt.md`, `body_kind` to `text` (`packages/cli/src/index.ts:3966-3985`) and
`provider_settings` to `{}`. Write all four anyway — a migration whose model
settings are implicit is a migration nobody can reproduce:

```json
{
  "name": "gepa-seed-prompt",
  "body_file": "prompt.md",
  "body_kind": "text",
  "provider_settings": { "model": "claude-sonnet-4-6", "temperature": 0 }
}
```

`prompt.md` carries their seed candidate text verbatim. Returns the seed
`prompt_version_id`.

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
  --project <team>/<project> --name gepa-scorer-runner --label default --json

orizu --local prompts push ./scorer-prompt \
  --project <team>/<project> --runner-version <scorer-runner-version-id> --json

orizu --local scorers register --project <team>/<project> \
  --name gepa-migrated-metric --manifest ./scorer.manifest.json \
  --prompt-version <scorer-prompt-version-id> \
  --runner-version <scorer-runner-version-id> \
  --label production --json                        # -> scorer_version_id
```

`scorer.manifest.json` needs all four fields below;
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

`prompt_runner` is the only kind `runners exec --scorer-version` and
`verify-parity` can execute, and it requires a backing prompt version. For a
pure-code metric with no judge text, `./scorer-prompt` is a short prompt
version documenting the rubric; the runner never reads its body.

## 5. Produce `outputs.jsonl` by running the seed once

A scorer scores *(row, output)*, so parity needs one candidate output per row.

```bash
orizu --local runners exec \
  --prompt-version <seed-prompt-version-id> \
  --runner-version <candidate-runner-version-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id> --split validation \
  --out ./results.jsonl

jq -c '{row_id: .row_id, model_output: .model_response}' ./results.jsonl > ./outputs.jsonl
```

`outputs.jsonl` must cover exactly the rows being checked: a missing or extra
`row_id`, a duplicate, or a non-string `model_output` is refused before
anything runs.

## 6. Prove parity

```bash
orizu --local scorers verify-parity \
  --scorer-version <scorer-version-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id> --split validation \
  --outputs ./outputs.jsonl \
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
  so a limited run can never be mistaken for a full one. The same full
  `outputs.jsonl` works: outputs must cover the limited rows and belong to the
  split, and need not be trimmed to N.
- A repeated option takes its LAST value, matching run-gepa's scalar options.
- If a sampled row already has the candidate field as a key, the command exits 2
  rather than overwriting a value the original metric reads.

Exit `0` parity proven (>= 1 row compared, no mismatch, no row error); `1` at
least one mismatch or row error — read `mismatches`/`errors` in the `--json`
report, fix the runner, repeat; `2` the check could not run (bad arguments, no
rows, unverified runner dir, original metric not importable).

Do not continue on exit 1 or 2. A scorer that disagrees with their metric
optimizes the wrong thing, and every number afterwards is wrong.

**Prove parity on BOTH partitions before declaring the scorer migrated.**
`run-gepa` scores `train` and `validation`, and training rows drive GEPA's
proposals: a scorer that agrees on validation but diverges on a training row
that exercises a different schema branch changes the experiment's result while
passing this gate. Repeat steps 5 and 6 with `--split train` (its own
`outputs.jsonl` from the same seed run) and require exit 0 on both.

A `parity: true` report means every row of that partition was compared and
agreed. A limited run reports `parity: false` with
`scope: {compared, total}` and the line "Smoke check passed on N of M rows"
— it exits 0, but it is not the proof.

## 7. Optimizer and run

```bash
orizu --local optimizers push ./optimizer \
  --project <team>/<project> --name gepa-optimizer --label gepa-v1 --json

orizu --local optimizations run-gepa \
  --project <team>/<project> \
  --optimizer-version-id <optimizer-version-id> \
  --candidate-version-id <seed-prompt-version-id> \
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

`./optimizer` needs `manifest.json` with `"optimizer_family": "gepa"`. See
`references/optimization-with-gepa.md` for reflection-model and budget flags.
Pass `--scorer-candidate-field <field>` here too if you passed it to
`verify-parity`: the payload the runner sees must be the one parity was proven
under. Afterwards, `orizu optimizations promote <run-id> --candidate <id>
--label production` promotes the winner — and with parity proven, its score is
comparable to the seed score their own script reports.
