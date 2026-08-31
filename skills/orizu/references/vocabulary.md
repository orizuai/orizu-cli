# Vocabulary

Use these terms exactly across Orizu's method, skill, references, and reports.

## Workflow vocabulary

- **Evals-first** — understand observed failures, build and validate evaluations, then optimize the LLM application against that evidence.
- **Journey step** — one ordered stage in the workflow: J0 — Discover & evaluate, J1 — Install & set up, J2 — Assess & plan, J3 — Build the dataset, J4 — Ground truth via annotation (conditional), J5 — Build & validate judges, or J6 — Optimize & promote.
- **Exit criterion** — the checkable evidence required before leaving one journey step for the next.
- **Human-only** — an action the agent prepares with exact evidence and an authorized human executes.
- **Local surface** — a CLI action executed under the user's token; the authority map, not the surface, determines whether an agent or human executes it.
- **Hosted session** — a platform-managed coding-agent session authenticated with session credentials and bound to its signed team and project scope.
- **Instruction set** — the customer-facing identity for one agent or LLM experience, with a fixed ordered component shape and model-config profiles that own component values.
- **Judge trust bar** — the user-agreed metric thresholds a judge must clear for a named downstream decision and failure mode.
- **Decision class** — the judge's downstream use: gatekeeper, optimization signal, or triage / monitoring.
- **Scenario class** — a named, meaningful family of cases from the ratified improvement plan whose coverage and results are tracked separately.
- **Final-held-out** — the application partition reserved for J6's single seed-versus-selected-candidate comparison.

## Method vocabulary

- **Flow** — one named, top-level path through the Orizu method that an agent (or human) works end to end: a defined entry condition ("reach for X when Y"), ordered steps, and an exit criterion.
- **Quick win** — the recommended starting point for a repo new to Orizu: the instruction surface with the shortest credible path to a **measured, promotable model improvement**.
- **Onboard (flow)** — the single on-ramp: in a repo Orizu hasn't touched, inventory where the prompts/skills/instructions live, lay it out, and recommend the quick win.
- **First win (flow)** — the first pass through the loop on the recommended surface: curate the dataset, gather ground truth (annotation only when approved labels don't exist), build and validate judges, hill-climb to a completed optimization run.
- **Promote (flow)** — the actual customer win: report the run, support the human's promotion decision (learnings, tradeoffs, regressions), and guide validation (blind side-by-sides, replay on past traffic, staged rollout).
- **Recurse (flow)** — post-win, cadence-driven: fresh traces become a new dataset version and the loop reruns on the same surface on an agreed cadence.
- **Triage (flow)** — post-win, incident-driven: a reported issue leads to trace analysis and the eval-gap decision — does an existing eval catch it, does an eval need fixing, is an eval missing — before any optimizing or fixing.
- **Expand (flow)** — post-win, appetite-driven: pick the next instruction surface from Onboard's inventory by the same quick-win criterion and run the loop there.
