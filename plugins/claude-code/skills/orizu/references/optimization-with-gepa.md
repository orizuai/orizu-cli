# Optimization With GEPA

How to optimize an instruction-set profile against validated judges and scorers. Prepare the complete instruction-set manifest, follow the [Authority map](authority-map.md) for its mutation, and then run the bundled `orizu optimizations run-gepa` flow. Use this reference for GEPA mechanics, custom optimizer implementations, and optional DSPy context for customers already using DSPy.

When First win loads this reference, stop after the optimization run records a selected candidate or no-valid-candidate outcome. Do not write the decision report or run a promotion command until `flows/promote.md` is active. Steps 8–9 below describe Promote-owned continuation mechanics, not First win work.

Select the Profile explicitly with `--instruction-set <slug-or-exact-name> --model-config <identity>`. Those two selectors replace the legacy `--candidate-version-id` path and cannot be combined with it. The connector optimizes that Profile's complete Production component map. If the Profile is missing or unpromoted, launch refuses with the named Profile error; it never substitutes the Default Profile. `--component-selector round-robin` is the default and updates one component per round; `--component-selector all` updates every component per round. The runner receives a multi-component candidate as a component map, while a one-component set keeps the existing single-body runner contract. Git-pinned components and malformed component maps are refused before a run starts. Automatic promotion is refused for multi-component sets; write the report, obtain the human promotion decision, and follow the Authority map. Manifest create/push is the pre-run seed path, not a second accepted-candidate materialization; after a run, use the human one-shot or equivalent idempotent two-stage path in step 9.

## Inputs

You should arrive here with:
- One or more **validated judges** that clear their agreed judge trust bar (see `building-judges.md`).
- A **dataset** of inputs to optimize against — usually the same exported labels, plus any harder cases you've added since.
- An **instruction set** whose selected profile contains the starting component values for the LLM application you want to improve.

If you don't have a validated judge, stop. Optimizing against an unvalidated judge means you'll hill-climb on a noisy or biased signal — Goodhart's law in action.

## Why GEPA-Style Optimization

- **GEPA** is a gradient-free text optimizer that uses an LLM to propose component edits, scores candidates against your metric, and keeps the best. It is well-suited to instruction optimization where you cannot backpropagate through the model.
- In Orizu, runners execute candidates, scorers produce metrics/feedback, and optimization events make the loop inspectable and promotable.
- DSPy is not part of Orizu's bundled optimizer. Treat DSPy examples here as an external integration pattern only.

## Workflow at a glance

```
┌─────────────────────────────┐
│ Dataset (labeled inputs)    │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐     ┌─────────────────────┐
│ Runner (your LLM app call)  │ ◄── │ Validated scorers   │
│ file-contract execution     │     │ row/set metrics     │
└──────────┬──────────────────┘     └──────────┬──────────┘
           │                                    │
           └───────────────┬────────────────────┘
                           ▼
              ┌─────────────────────────┐
              │ GEPA optimization run   │
              │ (proposes, scores, keeps)│
              └──────────┬──────────────┘
                         ▼
              ┌─────────────────────────┐
              │ Optimized profile       │
              │ Compare before/after    │
              └─────────────────────────┘
```

## Orizu-tracked optimization

Use the control plane described in `prompt-control-plane.md` when you want runs, candidates, score charts, Pareto/frontier views, and promotions in Orizu:

1. Create the instruction set from its prepared manifest with `orizu instructions create`, or push a new profile version with `orizu instructions push`, using the executor selected by the Authority map. Keep the set's shape fixed during a run.
2. Push the candidate runner and, for an LLM evaluator, the judge rubric with `orizu judges push`.
3. Register a row scorer for reflection. GEPA reflection requires row-level feedback.
4. Snapshot a dataset version. Create one split set with train, validation, and a reserved final-held-out partition; pass only the train and validation partition names to `run-gepa`. Never pass the final-held-out partition as `--train-split` or `--val-split`; the CLI accepts arbitrary partition names and does not enforce this boundary.
5. Push the optimizer implementation with `orizu optimizers push ./optimizer --project <team/project> --name <optimizer-name> --json` and retain its returned optimizer version ID.
6. Use `orizu optimizations run-gepa --optimizer-version-id <optimizer-version-id>` with the set slug and model-config identity. It uses official GEPA by default; `--engine legacy` is a frozen safety hatch while migration parity is proven. Use `orizu optimizations start` plus event logging for a custom optimizer. Candidates are ranked on the partition passed as `--val-split`; use that partition for validation, not Final-held-out.
7. Use set scorers for selection/tracked reporting when the meaningful metric is batch-level; execute builtin set scorers with `orizu scorers exec` or submit precomputed aggregates with `orizu scores submit --aggregate`.
8. Write and attach the optimization report by following “How To Build The Report” step 5 in `references/optimization-reports.md`: “Determine whether the current execution surfaces can reproduce the selected system before claiming a Final-held-out comparison.” Its “Flat-row scorer contract,” “Default GEPA scorer contract,” and “Instruction-set execution limits” subsections own the executable boundaries and current gaps.
9. After the human accepts the report, follow the [Authority map](authority-map.md). Simpler one-shot path: a human curator runs `orizu optimizations promote <run-id> --candidate <id> --label production --project <team/project>`, materializing and labeling once. In the two-stage path for multi-component or deliberately unlabeled materialization, an agent may materialize with `orizu optimizations promote <run-id> --candidate <id> --project <team/project>`. A human curator re-runs that same promotion as `orizu optimizations promote <run-id> --candidate <id> --label production --project <team/project>`. The idempotent finalizer reuses the existing materialized profile version, moves production to it, and creates no duplicate profile version or candidate-promoted event.

The bundled Orizu GEPA-style optimizer supports configurable budget, minibatch size (default 3), candidate selection strategy, reflection model/template, reflection provider settings, evaluation caching, and optional auto-promotion. Use the report-first path: run without auto-promotion, write the report, obtain the human promotion decision, then route the manual promotion command through the Authority map. Only pass `--log-row-snapshots` when raw data in event logs is intentional.

Budget behavior:
- The `auto`, `light`, `medium`, and `heavy` presets are DSPy-style metric-call budgets whose limits scale with the validation-set size.
- Budgets are checked after in-run seed validation and between completed iterations, never mid-iteration; once an iteration starts, its parent minibatch, child minibatch, and, for an accepted child, full validation complete even if that work overshoots the selected limit.

Reflection output contract:
- The official engine uses the decoded reflective LM response string as the next value of the selected component without trimming; the legacy engine uses `response.strip()`, removing leading and trailing whitespace. With `round-robin`, other component values are read-only context; with `all`, each component is reflected independently and the results form one complete candidate profile.
- The default reflection template asks for only the complete updated component value. Do not ask the model to wrap the value in markdown fences or tags; instruction components often contain those characters.
- Put provider-native reasoning controls in `--reflection-provider-settings <json|@file>`, not in an instruction component. For OpenAI reasoning models, use a shape such as `{"reasoning":{"effort":"medium","summary":"auto"}}`. For Anthropic Claude models with thinking controls, use a shape such as `{"thinking":{"type":"adaptive"},"output_config":{"effort":"medium"}}`.
- Treat scorer feedback as directional signal: with `higher_is_better: true`, describe lower scores as failures or opportunities, not as a numeric loss; omit fields labeled `informational; not scored` from feedback sent to reflection.
- Reflection max-token limits are explicit. `--reflection-max-tokens <n>` maps to Anthropic `max_tokens` and OpenAI `max_output_tokens`; Anthropic native Messages reflection requires it, while OpenAI may omit it when no cap is desired.
- Reflection HTTP calls retry transient failures by default (`--reflection-retry-attempts 3`, `--reflection-http-timeout-seconds 180`). Legacy GEPA logs an exhausted retryable reflection failure, charges proposal and iteration budgets, and continues. The official engine increments proposal usage only after successful `on_proposal_end`; skilled-proposer failures re-raise and stop.

Full command syntax and event contracts: `prompt-control-plane.md`.

For staff-enabled hosted optimization, a human/PAT caller adds `--hosted` and
uses a named `--budget auto|light|medium|heavy`. Hosted launch does not require
the local candidate/scorer runner directories or a local log directory, and it
never sends provider credentials or runner bytes from the customer's machine.
Numeric budget controls are refused because they cannot be compared honestly
to the named team ceiling. Eligibility also requires a staff-enabled team with
available concurrency, an optimizer version in the launch project whose
validated `manifest.optimizer_family` is `gepa`, registered candidate and
scorer runners, and an Anthropic or OpenAI reflection model. Runner directories
are unnecessary; if supplied, they must byte-match the registered versions,
contain a confined `manifest.json`, and use each runner identity flag once.

Use `--json` for an agent-readable launch. Eligibility refusals in the hosted
catalog return the same `{error, code, remediation}` structure and may include
bounded `detail` with the verifier cause; a concurrency-cap refusal additionally
returns `runningRunUrls` for the active runs to inspect or cancel. Preserve the
server remediation verbatim. Acceptance prints a durable monitor URL: queued
means the coordinator accepted the run, not that optimization completed, so
watch that URL through running to a terminal state. For response-loss recovery,
reuse an explicit `--launch-intent-id <uuid>`; a changed project or job
specification requires a new intent. A hosted agent prepares the command and
hands it to a human.

## Migrating from the legacy engine (release cli-v0.5.20+)

Since release `cli-v0.5.20` (`orizu@0.5.20` on npm), `run-gepa` defaults to the official GEPA engine. The flag surface and validation rules match legacy almost everywhere — a valid legacy command runs unchanged, with two exceptions: the reflection-cap requirement below, and stricter `=`-form parsing (`--flag=` with an empty value, or an `=`-attached value that itself starts with `--`, is refused pre-launch; legacy's argparse accepted both — a scripted `--scorer-candidate-field=$FIELD` with `FIELD` unset now fails with the flag named). What actually differs:

- **Validation happens before launch.** Legacy validated flags inside the python process (an argparse exit); the official dispatcher enforces the flag-shape rules below before anything spawns and names the offending flag in the error (the budget-conflict error lists the exclusive set rather than the flags you passed; value errors — e.g. a non-integer or non-positive budget number — are still reported by the engine and name the underlying setting). The rules carried over from legacy: `--budget` / `--candidate-selection-strategy` / `--scorer-input-contract` validate their choices, boolean flags take no value, abbreviated flag spellings are rejected, and budget controls are mutually exclusive — at most one of `--budget`, `--max-metric-calls`, `--max-full-evals`, `--max-iterations`. The official-only `--max-candidate-proposals` joins that exclusion set. With no budget control, `--budget auto` selects the balanced `medium` preset.
- **Context and runtime.** Supply `--optimizer-version-id`, `--runner-version-id`, `--candidate-runner-dir`, `--scorer-version-id`, `--scorer-runner-version-id`, `--scorer-runner-dir`, `--dataset-version-id`, `--split-set-id`, `--train-split`, and `--val-split`; use `--python` to select the interpreter and `--json` for structured output.
- **Search and reproducibility.** Tune `--minibatch-size`, `--candidate-selection-strategy`, `--epsilon`, `--objective`, and `--num-threads`; use `--seed`, `--disable-evaluation-cache`, and optional `--metadata <json>` when reproducibility or run attribution requires them. Automatic row-evaluation concurrency is bounded by the larger of the minibatch and validation workloads, twice the detected CPU count, available memory after its reserve, available file descriptors after headroom, and a configurable ceiling whose default is 64 (`ORIZU_GEPA_AUTO_THREADS_MAX`). An explicit positive thread count bypasses that auto-scaling calculation.
- **Reflection controls.** Select `--reflection-model` and `--reflection-temperature`; a perfect selected minibatch skips reflection and child creation by default under `--skip-perfect-parent-reflection`, while `--no-skip-perfect-parent-reflection` overrides that behavior.
- **Promotion flags.** Do not use `--auto-promote` or `--promotion-label` in the report-first workflow: write the report, obtain the human promotion decision, and follow the Authority map.
- **A reflection cap is required for non-OpenAI reflection models.** `--reflection-max-tokens` is required at launch whenever the reflection model does not start with `openai/` — including the default (`anthropic/claude-opus-4-7`) and bare names like `gpt-4o` — so the run refuses immediately instead of failing every reflection call mid-run.
- **The skilled proposer is an opt-in proposal path.** Reach for `--candidate-proposer skilled-proposer` when you want to evaluate the upstream proposer's alternative reflection process and can accept its first-use network, CPython, and managed-dependency requirements. It prepares or reuses a managed Python environment. Its aggregate `--proposal-max-calls` and `--proposal-max-tokens` budgets are independent of metric-call limits and per-response reflection limits. Add `--candidate-proposer-config @file` for explicit skills/guidance; do not combine the selection with `--reflection-prompt-template`. Evaluate the shipped empty-skills proposer or a pinned config through the controlled A/B below, and ground quality or generalization claims in that evidence. Config schema, environment setup, and recovery live in `prompt-control-plane.md` ("Skilled proposer").
- **Seed preflight: same gate, better evidence.** Both engines refuse a degenerate seed (every valid row pinned to the same bound — the worst score, or uniformly `0.0` under a lower-is-better scorer, where the perfect bound is indistinguishable from a scorer silently zeroing on a mismatched input shape) or an all-errored seed at launch, and both accept `--allow-degenerate-seed` to bypass. The bypass covers *both* refusals — including the broken-scorer one — so a bypassed run can spend budget on a scorer that never works; use it only when a weak seed is expected. New on the official engine: the refusal message carries per-row evidence (row ids, scores, scorer output and errors); `<log-dir>/preflight-refused-<uuid>/preflight.json` (not written under `--no-local-log`) instead stores redacted `{row_id, score, error_class}` entries unless `--log-row-snapshots` is passed — a sibling of the run directories, since no run record exists when a launch is refused.
- **Metric accounting differs.** Official counts include every evaluated row; legacy excluded some cached work. Do not compare raw metric-call totals across engines (details in ADR-019).
- **Artifacts.** Both engines write `events.jsonl`, `evaluations.jsonl`, `reflections.jsonl`, and `result.json` locally; `lm_stats.json` (reflection usage) is official-only. Dashboard rendering is identical, and run metadata records `engine: official` or `engine: legacy`.

Terminal semantics are unchanged between engines: exhausting any budget control other than `--max-iterations` ends the run `paused` (`pause_reason: budget_exhausted`), while completing the configured `--max-iterations` is a normal `succeeded` finish. In both cases, keep the report-first path: no auto-promotion; write the report, obtain the human promotion decision, and follow the Authority map for manual promotion. Falling back to `--engine legacy` after a budget-exhausted pause reproduces the same paused outcome; it will not turn the run into a `succeeded` one.

**Fallback:** rerun with `--engine legacy` for the previous engine's exact behavior, dropping `--max-candidate-proposals` first if you used it (it is official-only; the CLI refuses it under legacy before launch). Legacy is frozen (no new features) and will be removed at the M3 milestone (ADR-019) — if you fall back because the official engine misbehaved, capture both run ids and report the pair.

### Compare the skilled proposer with the default

Run two arms with the same instruction-set profile version, dataset version and split set, candidate and scorer runners, seed, reflection model/settings, thread count, and one shared overall budget such as `--max-candidate-proposals 1`. Keep the default arm unselected; add `--candidate-proposer skilled-proposer`, the same pinned `--candidate-proposer-config @file` when testing configuration, and bounded `--proposal-max-calls` / `--proposal-max-tokens` only to the selected arm. The comparison is ready when both terminal states, retained candidates, scores, proposal evidence, and total run usage are captured. A fixed GEPA seed aligns optimizer sampling but does not make provider or scorer calls deterministic, so treat the pair as process and outcome evidence rather than an intrinsic quality claim.

For the selected arm, each provider-bearing proposal call appends `proposal-observability/events.jsonl`. Success records contain `source`, `status`, `attempt`, `correlation_id`, `provider`, `model`, nullable `request_id`, `latency_ms`, `cache_state`, and `usage.{input_tokens,output_tokens,total_tokens}`. Failure records contain `source`, `status`, `attempt`, `correlation_id`, `provider`, `cache_state`, `failure_code`, and optional `usage`; the latest durable failure is also written to `proposal-failures/latest.json` with `source`, `code`, `detail`, and optional `correlation_id`.

With local logging, those paths sit under `<log-dir>/<run-id>/`, and terminal `proposal-observability/lm_stats.json` is a flat object with `total_tokens_in`, `total_tokens_out`, and `total_tokens`. Under `--no-local-log`, per-call and failure records move under `.orizu/proposal-observability/<run-id>/`, and no terminal `lm_stats.json` is written. Finish the comparison after transport-bearing calls that reached provider completion or failure have records, `proposal_observability_event_failed` is absent, and, when local logging is enabled, terminal usage totals reconcile with those records.

## Step 1: Wrap your application as an Orizu runner

For Orizu-tracked optimization, the candidate runner receives one dataset row and the candidate profile through the file contract. A one-component profile is passed as a single body for runner compatibility; a multi-component profile is passed as a complete component map. The scorer runner, by default, receives a GEPA-shaped `row` — `{source_row, candidate_id, candidate_output, candidate_raw_response, candidate_error}` — and returns a score and feedback. See `prompt-control-plane.md` ("Scorer-Runner Input Contracts") for the exact runner I/O shapes.

**Contract warning:** the GEPA scorer contract differs from the flat-row score-run contract used by `orizu runners exec --scorer-version`. A judge runner written for flat-row score runs will find no output to judge in the GEPA shape and silently score every candidate 0. Do not hand-write a wrapper runner: pass `--scorer-input-contract flat_row` (plus `--scorer-candidate-field <row-field>` if the judge reads the candidate output from a named row field such as `draft`) and `run-gepa` adapts the payload for you while keeping the registered runner bytes unchanged. `run-gepa` also validates the contract on the seed at launch and refuses a uniformly-worst-scoring seed with a diagnosis instead of burning budget.

Keep the runner close to the production inference path: same model family, temperature, tools, parsing, and output schema wherever possible.

## Optional: DSPy program wrapper

If a customer already uses DSPy, they can express their application as a `dspy.Module` and build a custom optimizer around it. This is not how Orizu's bundled `orizu-gepa` package runs.

Express the LLM call as a `dspy.Module` with a `Signature`:

```python
import dspy

class SupportAgentSignature(dspy.Signature):
    """Generate a support response for a customer message.

    The response should resolve the issue when possible, escalate when the
    situation requires human handling, and always include a case reference.
    """
    customer_message: str = dspy.InputField()
    conversation_context: str = dspy.InputField()
    response: str = dspy.OutputField()
    should_escalate: bool = dspy.OutputField()


class SupportAgent(dspy.Module):
    def __init__(self):
        super().__init__()
        self.respond = dspy.ChainOfThought(SupportAgentSignature)

    def forward(self, customer_message: str, conversation_context: str):
        return self.respond(
            customer_message=customer_message,
            conversation_context=conversation_context,
        )
```

If your real application is multi-step (retrieval + generation + tool use), build a multi-Module program. GEPA can optimize each module's instructions independently.

## Step 2: Register scorers

For Orizu, register scorers with readable names, directionality, row/set mode, and dataset requirements. Row scorers should return numeric `score` and textual `feedback`; feedback is what GEPA reflection consumes. Set scorers can be selection or tracked scorers, but they should not be used as reflection scorers.

If using DSPy externally, a metric takes `(example, prediction, trace=None)` and returns a number. Wrap each validated judge:

```python
def escalation_metric(example, prediction, trace=None) -> float:
    judge_result = run_escalation_judge(
        input={"customer_message": example.customer_message,
               "conversation_context": example.conversation_context},
        output={"response": prediction.response,
                "should_escalate": prediction.should_escalate},
    )
    return 1.0 if judge_result["pass"] else 0.0


def case_ref_metric(example, prediction, trace=None) -> float:
    return 1.0 if has_case_reference(prediction.response) else 0.0


def combined_metric(example, prediction, trace=None) -> float:
    # Equal weighting; adjust if some failure modes are more critical.
    return (escalation_metric(example, prediction) +
            case_ref_metric(example, prediction)) / 2
```

**Weighting note:** if one failure mode is much more costly (escalation miss = lost trust; missing case ref = annoyance), weight accordingly. Don't hide critical failures inside an averaged score.

## Step 3: Build the dataset

Convert your labeled export into `dspy.Example` objects:

```python
import json
import dspy

def load_examples(path: str) -> list[dspy.Example]:
    examples = []
    with open(path) as f:
        for line in f:
            row = json.loads(line)
            ex = dspy.Example(
                customer_message=row["customer_message"],
                conversation_context=row["conversation_context"],
                # Outputs are unused as targets here — judges produce the signal.
            ).with_inputs("customer_message", "conversation_context")
            examples.append(ex)
    return examples


examples = load_examples("./labels.jsonl")
trainset, devset = examples[:int(0.7 * len(examples))], examples[int(0.7 * len(examples)):]
```

## Step 4: Run GEPA-Style Optimization

For Orizu, use `orizu optimizations run-gepa` first. It starts the run, fetches candidate/scorer contexts, executes local runners, logs seed validation, minibatches, reflection, child candidates, validation, Pareto updates, and optionally promotes.

`run-gepa` also writes a local trace directory by default:

```text
logs/<optimization_run_id>/
  run.json
  prompt_context.json
  scorer_context.json
  trainset.json
  valset.json
  events.jsonl
  evaluations.jsonl
  reflections.jsonl
  result.json
```

Use this directory as the preferred artifact for coding-agent analysis. It contains the full row inputs, model outputs, scores, feedback, scorer responses, reflection prompts, reflection responses, candidate text, and final result. Override the root with `--log-dir <dir>`; disable persistence with `--no-local-log` only when raw rows/reflection context must not be written to disk.

If the local log is missing or the run happened elsewhere, export the server-side archive:

```bash
orizu optimizations export <optimization-run-id> --out ./optimization.json
```

Export returns one JSON object with raw events plus derived seed-vs-best, Pareto frontier, candidates, score-over-time, iterations, minibatch rows, validation rows, scorer context, prompt versions, and dataset split information. It fetches all optimization events and rehydrates row inputs from dataset artifacts when possible. Server events redact row snapshots and reflection prompts by default, but bundled `run-gepa` includes reflection responses in the event stream.

After the run ends, write a markdown report before the context is lost. Use the authoritative ordered sections in `optimization-reports.md`: Promotion Decision; Run And Evidence; Candidate Comparison (Validation Data); Optimizer Health; Scenario Classes; What Changed In The Selected Version; Final-held-out Result: Seed vs Selected Candidate; Recommendation And Named Next Moves; Reproducibility; and Report Completeness Checklist.

DSPy GEPA example for customers already on DSPy:

```python
from dspy.teleprompt import GEPA

# Configure the LM that DSPy uses for both the program and the optimizer.
dspy.configure(lm=dspy.LM("openai/gpt-4o", temperature=0.0))

program = SupportAgent()

optimizer = GEPA(
    metric=combined_metric,
    auto="medium",          # GEPA budget preset; "light" / "medium" / "heavy"
    reflection_lm=dspy.LM("openai/gpt-4o", temperature=0.7),
)

optimized_program = optimizer.compile(
    student=program,
    trainset=trainset,
    valset=devset,
)

optimized_program.save("./optimized_support_agent.json")
```

GEPA will:
1. Run the program on `trainset`, score with `metric`.
2. Use `reflection_lm` to propose instruction edits based on failures.
3. Score candidate programs on the trainset, keep the best.
4. Validate on `valset` to avoid overfitting.

Orizu's bundled optimizer is intentionally narrower than DSPy GEPA today: text candidates only, local runner/scorer directories, and Orizu event logging built in.

## Step 5: Compare before / after on Final-held-out

This is the step teams skip and regret.

```python
def evaluate(program, examples) -> dict:
    scores = []
    per_metric = {"escalation": [], "case_ref": []}
    for ex in examples:
        pred = program(**ex.inputs())
        per_metric["escalation"].append(escalation_metric(ex, pred))
        per_metric["case_ref"].append(case_ref_metric(ex, pred))
        scores.append(combined_metric(ex, pred))
    return {
        "combined": sum(scores) / len(scores),
        "escalation": sum(per_metric["escalation"]) / len(examples),
        "case_ref": sum(per_metric["case_ref"]) / len(examples),
    }


# Hold out a fresh set the optimizer never saw.
held_out = load_examples("./final-held-out.jsonl")

before = evaluate(SupportAgent(), held_out)
after = evaluate(optimized_program, held_out)

print(f"Before: {before}")
print(f"After:  {after}")
```

**Read the per-metric numbers, not just the combined score.** A combined improvement of +5 points might hide a regression on one failure mode. If any individual metric drops, investigate before shipping.

## Step 6: Ship and feed the loop

If the optimized profile holds up on Final-held-out:
- Promote the validated profile version to production; never promote one component by itself.
- Sample new production traces over the next week.
- Upload them as a new dataset (`primer.md` Step 1).
- Annotate failures the optimized system *now* exhibits — they'll be different from the ones the previous version had.
- Build judges for the new failure modes if they're frequent enough.
- Re-optimize.

Each pass through the loop reveals the next layer.

## Common pitfalls

- **Optimizing against an unvalidated judge.** You'll improve the metric and degrade the system. Always validate first.
- **No Final-held-out comparison.** "It's better, look at the metric" without Final-held-out is meaningless — GEPA will overfit if you let it.
- **Hiding regressions in the average.** Track per-failure-mode metrics, not just combined.
- **Over-budgeting GEPA.** Heavy budgets give diminishing returns and burn LM spend. Start with `auto="light"`, scale up only if needed.
- **Ignoring temperature.** Run optimization with the same LM config (model, temperature) you use in production. Optimizing against gpt-4o at temp=0 doesn't transfer to gpt-4o-mini at temp=0.7.
- **Recreating Orizu logging by hand for instruction sets.** Use `orizu optimizations run-gepa` unless the optimizer is genuinely custom.

## Checklist

Before declaring an optimization run successful:

- [ ] Each metric is backed by a validated judge that clears its agreed judge trust bar (see `building-judges.md`)
- [ ] Train and validation partitions plus Final-held-out, which stays genuinely untouched during optimization
- [ ] Per-metric numbers reviewed (not just combined)
- [ ] Same LM/temperature in eval as in production
- [ ] Optimization report written from logs/export and attached with `--report-file` when the run is finished, failed, or cancelled
- [ ] Optimized program saved/version-controlled before shipping
- [ ] Plan in place to sample new traces post-deploy and run the loop again
