# Optimization With GEPA

How to optimize text candidates against validated judges/scorers. For Orizu-tracked runs, prefer `prompt-control-plane.md` and the bundled `orizu optimizations run-gepa` command when optimizing one text candidate. Use this reference for GEPA mechanics, custom optimizer implementations, and optional DSPy context for customers already using DSPy.

## Inputs

You should arrive here with:
- One or more **validated judges** (TPR > 90%, TNR > 90% on a held-out test set).
- A **dataset** of inputs to optimize against — usually the same exported labels, plus any harder cases you've added since.
- A **starting prompt or program** for the LLM application you want to improve.

If you don't have a validated judge, stop. Optimizing against an unvalidated judge means you'll hill-climb on a noisy or biased signal — Goodhart's law in action.

## Why GEPA-Style Optimization

- **GEPA** is a gradient-free prompt optimizer that uses an LLM to propose prompt edits, scores candidates against your metric, and keeps the best. It's well-suited to prompt-level optimization where you can't backprop through the model.
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
              │ Optimized prompt        │
              │ Compare before/after    │
              └─────────────────────────┘
```

## Orizu-tracked optimization

Use the prompt control plane when you want runs, candidates, score charts, Pareto/frontier views, and promotions in Orizu:

1. Push the candidate runner and prompt/judge prompt.
2. Register a row scorer for reflection. GEPA reflection requires row-level feedback.
3. Snapshot a dataset version and create a train/validation split set.
4. Use `orizu optimizations run-gepa` for the common text-candidate case, or `orizu optimizations start` plus event logging for a custom optimizer.
5. Use set scorers for selection/tracked reporting when the meaningful metric is batch-level; execute builtin set scorers with `orizu scorers exec` or submit precomputed aggregates with `orizu scores submit --aggregate`.
6. Promote only candidates that passed validation.
7. Write and attach an optimization report from the local logs or export artifact; see `optimization-reports.md`.

The bundled Orizu GEPA-style optimizer supports configurable budget, minibatch size (default 3), candidate selection strategy, reflection model/template, reflection provider settings, evaluation caching, and optional auto-promotion. It redacts row snapshots and reflection text by default; only pass `--log-row-snapshots` when raw data in event logs is intentional.

Reflection output contract:
- The reflective LM's final text is used verbatim as the next candidate prompt.
- The default reflection prompt asks for only the complete updated prompt body. Do not ask the model to wrap the candidate in markdown fences or tags; real prompts often contain those characters.
- Put provider-native reasoning controls in `--reflection-provider-settings <json|@file>`, not in the prompt body. For OpenAI reasoning models, use a shape such as `{"reasoning":{"effort":"medium","summary":"auto"}}`. For Anthropic Claude models with thinking controls, use a shape such as `{"thinking":{"type":"adaptive","display":"omitted"},"output_config":{"effort":"medium"}}`.
- Reflection max-token limits are explicit. `--reflection-max-tokens <n>` maps to Anthropic `max_tokens` and OpenAI `max_output_tokens`; Anthropic native Messages reflection requires it, while OpenAI may omit it when no cap is desired.

Full command syntax and event contracts: `prompt-control-plane.md`.

## Step 1: Wrap your application as an Orizu runner

For Orizu-tracked optimization, the candidate runner receives one dataset row and one candidate text body through the file contract. The scorer runner receives the source row plus candidate output and returns a score and feedback. See `prompt-control-plane.md` for the exact runner I/O shape.

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

If your real application is multi-step (retrieval + generation + tool use), build a multi-Module program. GEPA can optimize each step's prompt independently.

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

Use this directory as the primary artifact for coding-agent analysis. It contains the full row inputs, model outputs, scores, feedback, scorer responses, reflection prompts, reflection responses, candidate text, and final result. Override the root with `--log-dir <dir>`; disable persistence with `--no-local-log` only when raw rows/reflection context must not be written to disk.

If the local log is missing or the run happened elsewhere, export the server-side archive:

```bash
orizu optimizations export <optimization-run-id> --out ./optimization.json
```

Export returns one JSON object with raw events plus derived seed-vs-best, Pareto frontier, candidates, score-over-time, iterations, minibatch rows, validation rows, scorer context, prompt versions, and dataset split information. It fetches all optimization events and rehydrates row inputs from dataset artifacts when possible. Server events redact row snapshots and reflection prompts by default, but bundled `run-gepa` includes reflection responses in the event stream.

After the run ends, write a markdown report before the context is lost. Use `optimization-reports.md` for the report structure: headline score and confusion matrix, what changed, per-row fixed/regressed/persistent failures, optimizer health, recommendations, and what not to do next.

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
2. Use `reflection_lm` to propose prompt edits based on failures.
3. Score candidate prompts on the trainset, keep the best.
4. Validate on `valset` to avoid overfitting.

Orizu's bundled optimizer is intentionally narrower than DSPy GEPA today: text candidates only, local runner/scorer directories, and Orizu event logging built in.

## Step 5: Compare before / after on a held-out set

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
held_out = load_examples("./held-out.jsonl")

before = evaluate(SupportAgent(), held_out)
after = evaluate(optimized_program, held_out)

print(f"Before: {before}")
print(f"After:  {after}")
```

**Read the per-metric numbers, not just the combined score.** A combined improvement of +5 points might hide a regression on one failure mode. If any individual metric drops, investigate before shipping.

## Step 6: Ship and feed the loop

If the optimized prompt holds up on held-out:
- Replace the production prompt.
- Sample new production traces over the next week.
- Upload them as a new dataset (`primer.md` Step 1).
- Annotate failures the optimized system *now* exhibits — they'll be different from the ones the previous version had.
- Build judges for the new failure modes if they're frequent enough.
- Re-optimize.

Each pass through the loop reveals the next layer.

## Common pitfalls

- **Optimizing against an unvalidated judge.** You'll improve the metric and degrade the system. Always validate first.
- **No held-out comparison.** "It's better, look at the metric" without a held-out set is meaningless — GEPA will overfit if you let it.
- **Hiding regressions in the average.** Track per-failure-mode metrics, not just combined.
- **Over-budgeting GEPA.** Heavy budgets give diminishing returns and burn LM spend. Start with `auto="light"`, scale up only if needed.
- **Ignoring temperature.** Run optimization with the same LM config (model, temperature) you use in production. Optimizing against gpt-4o at temp=0 doesn't transfer to gpt-4o-mini at temp=0.7.
- **Recreating Orizu logging by hand for text prompts.** Use `orizu optimizations run-gepa` unless the optimizer is genuinely custom.

## Checklist

Before declaring an optimization run successful:

- [ ] Each metric is backed by a validated judge (TPR/TNR > 90%)
- [ ] Train / val / held-out splits, and the held-out set is genuinely untouched during optimization
- [ ] Per-metric numbers reviewed (not just combined)
- [ ] Same LM/temperature in eval as in production
- [ ] Optimization report written from logs/export and attached with `--report-file` when the run is finished, failed, or cancelled
- [ ] Optimized program saved/version-controlled before shipping
- [ ] Plan in place to sample new traces post-deploy and run the loop again
