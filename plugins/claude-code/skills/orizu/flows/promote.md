# Promote

the actual customer win: report the run, support the human's promotion decision (learnings, tradeoffs, regressions), and guide validation (blind side-by-sides, replay on past traffic, staged rollout).

Reach for Promote when First win or a later optimization cycle has completed and the human needs evidence for a ship, gather-more-evidence, or do-not-promote decision.

## Build the decision record

Follow `references/optimization-reports.md` for the run's recorded outcome:

- When the run has no valid candidate, take its no-valid-candidate report branch: omit candidate comparison and Final-held-out candidate evaluation, attach the reproducible report, explain why search produced no valid option, and recommend **Do not promote** without a promotion or result version.
- When GEPA selects the seed (`0` for the official engine or `seed` for legacy), take the seed-selected report branch: omit promotion and a result version, explain why optimization did not beat the seed, attach the reproducible report, and recommend **Do not promote**. Do not request a seed-versus-itself comparison or candidate Final-held-out evidence.
- When a non-seed candidate is selected, compare it with the seed, evaluate Final-held-out evidence when supported, explain learnings and tradeoffs in the user's terms, call out regressions, and attach the reproducible markdown report.

Recommend a decision without moving a production pointer.

## Guide human validation

Choose validation proportional to risk and available infrastructure. These are method patterns, not a requirement to invent unsupported product surfaces:

- **Blind side-by-side:** show randomized, identity-hidden outputs from the current and candidate versions to qualified reviewers; record preferences, reasons, disagreements, and scenario classes before revealing identities.
- **Replay on past traffic:** run the candidate over representative historical inputs and show what outputs, scores, costs, latency, and decisions would have changed without affecting users.
- **Staged rollout or experiment:** expose a small bounded cohort, define success and regression limits in advance, monitor the agreed measures, and retain an explicit rollback path before expanding.

Present the report and validation evidence. The human makes the promotion decision and executes every production/default pointer move through `references/authority-map.md`.

## Ship the approved Version to the repository

When an authorized multi-component instruction-set promotion produces a Profile Version, follow `references/orizu-in-your-codebase.md`: run `orizu instructions sync <set/profile@vN>` for the exact approved Version (or use the documented `update` plan for an existing Pointer), then review the Component, generated-artifact, and Lock diff. Plain-prompt promotions do not produce a Profile Version and have nothing to sync through this step. Do not move a customer rollout flag until the repository's offline verification and runtime-byte check are green.

## Offer the post-win flows

After the decision, offer Recurse for cadence-driven improvement on this surface, Triage for a reported incident, and Expand when the user wants to improve another inventoried surface. Offer them by the user's own interest, never as a forced sequence.

## Exit criterion

The human has made and recorded the promotion decision from the report and validation evidence; if shipping, the selected version is live through the authorized human action. The relevant post-win choices have been offered without forcing a sequence.
