# Optimization with DSPy + GEPA (Offline)

How to optimize prompts against validated judges today, in code. Orizu platform support for optimization is coming; until then, follow this workflow once you have at least one validated judge from `building-judges.md`.

## Inputs

You should arrive here with:
- One or more **validated judges** (TPR > 90%, TNR > 90% on a held-out test set).
- A **dataset** of inputs to optimize against — usually the same exported labels, plus any harder cases you've added since.
- A **starting prompt or program** for the LLM application you want to improve.

If you don't have a validated judge, stop. Optimizing against an unvalidated judge means you'll hill-climb on a noisy or biased signal — Goodhart's law in action.

## Why DSPy + GEPA

- **DSPy** lets you express LLM applications as composable, typed programs (Modules with Signatures), so prompts become parameters that an optimizer can search over.
- **GEPA** is a gradient-free prompt optimizer that uses an LLM to propose prompt edits, scores candidates against your metric, and keeps the best. It's well-suited to prompt-level optimization where you can't backprop through the model.
- Together: judges become metrics, prompts become parameters, optimization becomes a tight loop.

## Workflow at a glance

```
┌─────────────────────────────┐
│ Dataset (labeled inputs)    │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐     ┌─────────────────────┐
│ DSPy Program (your LLM app) │ ◄── │ Validated Judges    │
│ wrapped as a Module         │     │ as DSPy metrics     │
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

## Step 1: Wrap your application as a DSPy program

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

## Step 2: Wire judges as DSPy metrics

A DSPy metric takes `(example, prediction, trace=None)` and returns a number. Wrap each validated judge:

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

## Step 4: Run GEPA

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

## Checklist

Before declaring an optimization run successful:

- [ ] Each metric is backed by a validated judge (TPR/TNR > 90%)
- [ ] Train / val / held-out splits, and the held-out set is genuinely untouched during optimization
- [ ] Per-metric numbers reviewed (not just combined)
- [ ] Same LM/temperature in eval as in production
- [ ] Optimized program saved/version-controlled before shipping
- [ ] Plan in place to sample new traces post-deploy and run the loop again
