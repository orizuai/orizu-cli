# First win

the first pass through the loop on the recommended surface: curate the dataset, gather ground truth (annotation only when approved labels don't exist), build and validate judges, hill-climb to a completed optimization run.

Reach for First win after Onboard exits with a human-ratified improvement plan and recommended quick win, or when Recurse starts a later cycle on the same ratified surface with refreshed evidence.

## Curate the dataset

Follow `references/dataset-design.md` for the ratified source, scenario-class coverage, immutable dataset version, split set, mini-batches, Final-held-out reservation, and pre-annotation mutation guard.

## Gather ground truth

Decide by label existence, not perceived effort:

- When approved labels supply all required ground truth, record their source, approval, and scenario-class coverage, then skip annotation.
- When approved labels cover only some required questions or rows, follow `references/eval-strategy.md` mixed path and annotate every uncovered question or row.
- When no approved labels supply required ground truth, follow `references/eval-strategy.md` annotation path to define the task, validate labelers, publish only after approval, complete labeling, export labels, and publish the approved task report. Use `references/building-apps.md` when the labeling task needs an app.

## Build and validate judges

Follow `references/building-judges.md`. Prefer deterministic assertions for deterministic rules and LLM judges for nuanced criteria. Validate against human labels, agree the judge trust bar for each downstream decision and failure mode, register the runner and scorer, submit measured evidence, and obtain the required human score acceptance before the judge gates optimization.

Use `references/prompt-control-plane.md` for artifact contracts and the Authority map in `SKILL.md` for mutation custody.

## Optimize

Optimize only against validated judges. Use `references/optimization-with-gepa.md` and `references/cli-reference.md` rather than remembered commands. Target one model-config profile and treat its complete component map as the candidate. Select on validation evidence and preserve Final-held-out for Promote's seed-versus-selected-candidate decision evidence.

## Exit criterion

The optimization run is completed with a selected candidate or a recorded no-valid-candidate outcome, and all run artifacts needed by `flows/promote.md` are available. A completed optimization run ends First win; the customer win is realized only through the human promotion decision in Promote.
