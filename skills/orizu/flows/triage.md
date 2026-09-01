# Triage

post-win, incident-driven: a reported issue leads to trace analysis and the eval-gap decision — does an existing eval catch it, does an eval need fixing, is an eval missing, or is the reported behavior expected — before any optimizing or fixing. The expected-behavior branch records a false-positive/no-change outcome, and only bounded emergency containment may precede the decision.

## Contain active harm when necessary

Evaluate active harm first, whether or not the affected surface has completed Promote. When an incident is actively harming traffic, a bounded emergency containment may precede eval repair only with explicit human authorization. Prefer the narrowest reversible action, such as a human-authorized rollback to a last-known-good profile; record its scope, owner, reason, and rollback or expiry condition. Containment is not the durable fix and does not admit the surface to post-win Triage: after immediate harm is bounded, continue to the durable-fix entry gate below.

## Enter the durable-fix path

Reach for the durable Triage path after a concrete production or review incident and a completed Promote on the affected instruction surface. It is the targeted sibling of Recurse, not a shortcut around evidence. If the surface has not completed Promote, route through `flows/onboard.md`, `flows/first-win.md`, and `flows/promote.md` to establish its plan, measured baseline, and promotion decision before returning to this post-win path.

## Analyze the reported issue and traces

Capture the reported behavior, expected behavior, impact, affected instruction surface and model config, and representative traces. Keep reproduction read-only unless a mutating reproduction follows the safeguarded-probe contract: dev-run only and never deployed, confined to a reserved disposable name prefix, self-cleaning on both success and failure, value-free in its output, and never pointed at customer data. Compare nearby successful traces and identify the scenario class and failure mode before proposing a durable change.

## Make the eval-gap decision

Test the incident against the current accepted evals and their underlying labels.

Before any branch adds incident evidence, compare its failure mode, scenario class, and trace source with the committed improvement plan. When any of those inputs is novel, first follow `references/assess-and-plan.md` to amend the plan's source and coverage decisions, obtain explicit human ratification, then write and commit the amended plan. Only the ratified plan can authorize the dataset and eval work below.

- **An existing eval catches it:** preserve the incident as a regression case, confirm the scorer signal and trust bar still fit the decision, then use that validated signal for the targeted improvement.
- **An existing eval should catch it but does not:** determine whether labels, rubric, judge, runner, scorer, or threshold are wrong. Correct the eval, add the incident as a regression case, and revalidate it using `references/building-judges.md` before improving the application.
- **No eval covers it:** define the missing failure mode, add representative cases and approved ground truth through `references/dataset-design.md` and `references/eval-strategy.md`, then build and validate the missing eval with `references/building-judges.md`.
- **Expected behavior / false positive:** when the accepted eval covers the scenario and correctly passes it, record the adjudication, supporting traces, applicable eval and labels, and why no production change is justified; then close with the no-change outcome below.

## Improve only after coverage

Only after the eval gap is resolved and validated, choose the artifact path supported by the evidence. The expected-behavior branch instead closes with its recorded no-change outcome and does not enter either change path.

- For an instruction-surface improvement, optimize through `flows/first-win.md`, prove the incident regression case and relevant neighboring scenarios, then use `flows/promote.md` only for the completed optimization-run branch.
- For an application fix outside the instructions, make the smallest justified code change, prove the incident regression case and relevant neighboring scenarios through the application's own test and deployment boundary, present the change, regressions, rollback path, and evidence to the human, and record their ship, gather-more-evidence, or do-not-ship decision. Use the application's authorized deployment process; do not invoke Promote or invent optimization-run artifacts.

## Exit criterion

The incident's eval-gap branch and its resolution, including an eval correction only when that branch required one, are recorded. A change branch exits when the incident is represented by a validated regression case and the resulting optimization or application fix has a human decision with regression evidence. The expected-behavior branch exits with a recorded no-change closure and its supporting adjudication evidence. If evidence cannot yet be validated, exit with a named evidence gap rather than an unmeasured fix.
