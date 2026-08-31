# Onboard

the single on-ramp: in a repo Orizu hasn't touched, inventory where the prompts/skills/instructions live, lay it out, and recommend the quick win.

Reach for Onboard when Orizu has not yet established an improvement plan for this repo.

## Assess fit

Explain that Orizu uses observed failures and validated evals to improve an LLM application, with agents doing the legwork and humans supplying labels, trust bars, plan ratification, and promotion decisions. Inspect only context the user has supplied. Recommend adoption when repeated iteration would benefit from measurable evaluation; step aside for generic instruction-writing theory or a one-off edit the user will not validate with evals.

## Inventory the repo

Follow `references/assess-and-plan.md` to identify every LLM instruction surface, where its prompts, skills, and instructions live, how it is invoked, its owners and model configs, available traces and labels, existing evals, and known failures. Present the inventory before recommending where to start.

## Recommend the quick win

the recommended starting point for a repo new to Orizu: the instruction surface with the shortest credible path to a **measured, promotable model improvement**.

Compare the inventoried surfaces using source metadata only: availability, provenance, coverage, known failure-mode metadata, execution access, and whether a credible labeling and promotion path exists. Do not open, read, export, or sample customer records before the plan is ratified and committed. Recommend one surface and explain the metadata supporting that choice. An eval is instrumental; the win is the improved model realized through Promote, not the first eval, a demo, or a POC.

## Install and establish the project

After the human chooses Orizu, check whether `orizu` is available and record `orizu --version`. If it is missing, require Node.js 20+ and install the CLI with `npm i -g orizu`. Then run `orizu setup`; verify authentication and runtime with `orizu whoami --json` and `orizu capabilities --json`, and verify the installed skill separately with `orizu skills status --json` (use `orizu skills update` when stale). Use `references/cli-reference.md` for authentication and team/project commands. Follow `references/authority-map.md` for who executes each action. Do not rely on remembered commands.

## Ratify the improvement plan

Use the survey, decision, conversation, and persistence workflow in `references/assess-and-plan.md`. Resolve the target surface, dataset and ground-truth strategy, judge trust bars, optimization target, final validation, regression limits, and promotion owner with the human.

## Exit criterion

A human-ratified improvement plan is committed at the location required by `references/assess-and-plan.md`, and it names the quick win that First win will run.
