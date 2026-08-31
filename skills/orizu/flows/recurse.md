# Recurse

post-win, cadence-driven: fresh traces become a new dataset version and the loop reruns on the same surface on an agreed cadence.

Reach for Recurse after Promote when the user wants a repeatable improvement habit for the same instruction surface.

## Agree the cadence

Propose a cadence based on traffic volume, drift risk, labeling capacity, and the cost of running evals and optimization. Start recurring work only after the human agrees the cadence, ownership, evidence threshold, and pause condition.

## Refresh the evidence

Identify the currently deployed version and record its immutable identity before collecting fresh representative traces from it, including when the preceding Promote decision did not ship a candidate. Never attribute current-production traces to an unshipped candidate. Preserve provenance, redaction, scenario classes, and the prior version. Follow `references/dataset-design.md` to create a new immutable dataset version rather than mutating the dataset used by the previous run.

Review changed failure modes and coverage with the human. Gather approved labels or follow `references/eval-strategy.md` when new annotation is required. Revalidate any judge whose data, failure mode, or downstream decision changed.

## Rerun the loop

Run `flows/first-win.md` on the same instruction surface using the new evidence, then run `flows/promote.md` for the next human promotion decision. Reuse validated artifacts only while their trust evidence still applies; do not let cadence move a production pointer without the human decision in Promote.

## Exit criterion

The human-agreed cadence, ownership, evidence threshold, and pause condition are recorded, and the first scheduled cycle is complete through Promote with a new dataset version and a recorded promotion decision. Future cycles repeat only while the agreement remains active.
