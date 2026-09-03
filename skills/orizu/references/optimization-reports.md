# Optimization Reports

Use this reference to turn one Orizu optimization run into a decision a human can make. The report must explain what promoting the selected candidate changes, how every candidate traded gains for losses, what each scenario class taught, and what happens next where results stalled or regressed. It is education for a promotion decision, not a dump of optimizer statistics.

For execution mechanics only, read `optimization-with-gepa.md`. This reference starts after the run and does not duplicate launch flags or runner contracts. If that mechanics guide's brief summary of report contents differs from the copyable template below, this template and its completeness checklist are authoritative. In particular, do not apply an unconditional Profile-promotion summary to a set-of-one run; distinguish the selected Profile's Production state from whether that Profile is named Default.

Submit the final markdown with the finish form that matches the recorded run subject. `run-gepa` records only a genuine multi-component instruction set (shape length greater than one) with an `instruction_set_profile_version_id`. A plain prompt and a set-of-one instruction set are both recorded as prompt-version runs, but they do not share a shipping path: a prompt-label move ships the plain prompt and cannot repoint an instruction-set profile.

```bash
# Multi-component instruction-set run: promote returns profileVersionId; finish without --result-prompt-version.
orizu optimizations promote <run-id> --candidate <candidate-id>
orizu optimizations finish <run-id> --best-candidate <candidate-id> --report-file ./reports/<run-id>.md

# Plain prompt run: the human's only promotion goes live immediately and returns promptVersionId.
# Human-only: this combined materialize-and-label command must be run by a human curator.
orizu optimizations promote <run-id> --candidate <candidate-id> --label production
# Agent: finish only after the human returns promptVersionId.
orizu optimizations finish <run-id> --best-candidate <candidate-id> --result-prompt-version <prompt-version-id> --report-file ./reports/<run-id>.md

# Set-of-one instruction-set run: optimizations promote cannot ship the selected component.
# Agent-run on all supported surfaces: export evidence, then inspect the selected Profile's Production and the separate Default Profile pointer.
orizu optimizations export <run-id> --out <run-id>.optimization.json
orizu instructions show <set> --project <team/project> --json
orizu instructions default show <set> --project <team/project> --json
# STOP when complete local prompt_context.json evidence is absent; the server export cannot recover the execution runner.
# STOP also because the current CLI cannot prove the required model-config settings-version equality.
# Agent: finish with Gather more evidence; there is no result prompt version.
orizu optimizations finish <run-id> --best-candidate <candidate-id> --report-file ./reports/<run-id>.md

# Seed candidate selected: use 0 for official and seed for legacy; finish without promotion or a result version.
# Official engine (default) records the seed as candidate 0.
orizu optimizations finish <run-id> --best-candidate 0 --report-file ./reports/<run-id>.md
# Legacy engine (--engine legacy) records the seed as candidate "seed".
orizu optimizations finish <run-id> --best-candidate seed --report-file ./reports/<run-id>.md

# No valid candidate: finish without promotion, a candidate, or a result version.
orizu optimizations finish <run-id> --report-file ./reports/<run-id>.md

orizu optimizations fail <run-id> --reason "<reason>" --report-file ./reports/<run-id>.md
orizu optimizations cancel <run-id> --reason "<reason>" --report-file ./reports/<run-id>.md
```

For budget-exhausted runs, `run-gepa` pauses the optimization before human-only auto-promotion. For a multi-component instruction-set run with a selected non-seed candidate, the coding agent may materialize the selected profile with unlabeled `optimizations promote`, then finish the paused run with `--best-candidate` and `--report-file` only. Finishing records the outcome but does not move a serving pointer. Multi-component promotion is idempotent, so a human curator can later run the same promotion with `--label production`. Do not pass the returned `profileVersionId` to `--result-prompt-version`: the finish field accepts only a `prompt_versions` id.

For a plain-prompt non-seed run, the agent never promotes: a human performs the candidate's single promotion with `--label production`, which goes live immediately, returns the `promptVersionId`, and the agent records it with `--result-prompt-version <prompt-version-id>` when finishing. A repeat promotion is rejected with HTTP 409, but the error text is path-dependent: the common identical-content path returns `Prompt version is identical to the current prompt version.` before the finalizer, while a finalizer-level repeat can return `Candidate was already promoted`. The CLI accepts either an unlabeled promotion or `--label production`, but no other promotion label. An unlabeled call consumes the candidate's only promotion, and the CLI refuses the later `prompts labels set ... production` pointer move, so it does not create a materialize → test → production flow.

For a set-of-one instruction-set run, never call `optimizations promote`: its legacy prompt-label path cannot repoint the Instruction Set Profile that serving resolves. If a human nevertheless runs that legacy promotion, it creates a Prompt Version and moves the `prompt_labels` Production pointer for direct Prompt-label consumers only. Consumers continue using the selected Profile's existing Production; if that Profile is unpromoted, they continue refusing with `instruction_set_profile_not_promoted`. The new Prompt Version has no Profile-component association, and Default is never substituted. A valid Instruction Set shipping flow must not use the `promptVersionId` that this legacy promotion would return. `instructions profiles new` copies the Default Profile's component map into a new model-config Profile, and `instructions profiles promote --version` can select only a Version already in that Profile; neither command can wrap the legacy promotion's returned Prompt Version. Before choosing a serving-pointer command, the agent uses `instructions show --json` to inspect the selected Profile's Production and `instructions default show --json` to inspect the separate Default Profile pointer.

Agent-run evidence resolution is allowed on all supported surfaces. Set-of-one transfer has two provenance preconditions. First, when a complete local log directory exists, use the evidence written by `run-gepa` from its actual exec context. Read `<printed-local-log-directory>/prompt_context.json`, require its sibling `run.json` to name the same `optimization_run_id`, and use `prompt_context.json`'s top-level `runner_version_id` as `<run-runner-version-id>`. Do not use the export's `promptVersions[].runnerVersionId`: that is the component prompt version's historical runner, which can differ from the explicit runner that executed the optimization. If complete local evidence is absent, `prompt_context.json` lacks `runner_version_id`, or the run used `--no-local-log`, stop, recommend **Gather more evidence**, and do not run the push or either serving-pointer command. The server does not currently expose the execution runner recorded for this set-of-one run; the fix-forward is to persist and export that run-level execution-runner id. When both provenance preconditions can eventually be proven, the push must use the exact form `orizu instructions push ./orizu.instruction-set.json --project <team/project> --set <set> --runner-version <run-runner-version-id>` rather than allowing `instructions push` to select the newest sealed runner.

Second, before pushing, require the target profile's `model_config_settings_version_id` to equal the optimization run's recorded `model_config_settings_version_id`. The run row stores that id, and `instructions push` snapshots the target profile's current settings id into the new profile version, but storage is not a curator proof surface. The current `optimizations export`, `optimizations list --json`, `instructions show --json`, and `instructions push --json` responses do not expose both settings-version ids, so the CLI cannot prove that equality today: stop, recommend **Gather more evidence**, and do not run the push or either serving-pointer command. Record this product gap explicitly. The agent may still finish with `--best-candidate` and the report but without `--result-prompt-version`.

Once a supported surface can prove equality, the agent may copy the selected value exactly into the complete manifest while preserving every other override and pin, then use the runner-pinned push above on the local surface. Moving exactly one verified serving pointer remains human-only. An existing Production Profile would be promoted by the human and recover with `orizu instructions profiles rollback <set> --project <team/project> --model-config <identity> --to <previous-production-version-number>`. A human managing Default would first confirm the target Profile has a reviewed Production Version, move Default to that Profile identity, and recover by moving the prior Default Profile identity back. If a change must affect only one identity, a curator establishes a dedicated Profile only when none exists and confirms a recovery target; an existing unpromoted Profile makes `profiles new` reject and remains unusable until promoted. These are blocked flow shapes, not permission to bypass the settings proof.

If the blocked set-of-one run should instead become a profile-recorded optimization, change the instruction-set shape to more than one real, separately optimized component, validate the new multi-component manifest and dataset contract, and only then rerun. Repeating the same one-component shape remains a prompt-version run. If that material redesign is not warranted, keep the current run at **Gather more evidence**.

Pre-promotion Final-held-out confirmation is unsupported for a plain-prompt run today: the selected prompt version does not exist until its live pointer move. The report must present validation-only evidence, mark Final-held-out as **not obtainable before promotion**, and never describe Final-held-out proof as completed. If policy requires Final-held-out evidence before production, recommend **Gather more evidence** and do not run the promotion command. If a human explicitly accepts live-first verification, phrase the ship recommendation as a **post-promotion verification plan**: name the watch window, failure threshold, and confirmed rollback path before promotion. The current CLI has no plain-prompt rollback command, so do not invent one; if no external/manual rollback path is confirmed, recommend **Gather more evidence**. A set-of-one run also stops today when complete local runner evidence is unavailable and, even when that runner is known, because run-versus-target settings equality cannot be proven through the supported CLI.

If the selected candidate is the seed, do not call `optimizations promote`; use the candidate id recorded by the run's engine. The official engine records candidate `0`, so finish it with `--best-candidate 0`; `--engine legacy` records candidate `"seed"`, so finish it with `--best-candidate seed`. In either case, omit `--result-prompt-version` and explain why optimization did not beat the seed. If no valid candidate exists, omit `--best-candidate` as well as promotion and `--result-prompt-version`. Both branches recommend **Do not promote** and name the next dataset, scorer, application, or search move.

`optimizations finish --report-file` uploads the report markdown only. It has no evidence-file upload surface, so record each evidence artifact path inside the report markdown; include a content hash when paths may move or files may change.

## Evidence Boundaries

Keep the three data roles separate:

- Training data teaches the optimizer which changes to propose.
- Validation data ranks every candidate that received a full validation evaluation. A candidate comparison must use this data, because the optimizer is allowed to inspect validation results while choosing.
- Use Final-held-out only for the untouched final check after selecting one candidate, and compare only the seed with that selected candidate. Do not rank candidates on Final-held-out or use its results to choose a different candidate.

For a multi-component instruction-set run, the **seed** is the customer-authored profile version the run started from, and each candidate is a complete proposed profile version. A plain prompt and a set-of-one instruction set are both recorded with a `prompt_version_id` and no `instruction_set_profile_version_id`; that storage fact makes legacy promotion available but does not make it a valid shipping path for the set-of-one run. Report each scenario class from the ratified improvement plan separately, such as “refund requests with missing order details”; never replace scenario-class results with pass/fail buckets.

Prefer the local log directory printed by `run-gepa`. Core files (conditional files are listed below):

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

Conditional files may also appear. `preflight.json` records conditional preflight warnings; carry those warnings into the report's scorer caveats. `lm_stats.json` records reflection-model usage. Skilled-proposer runs may add `proposal-observability/` and `proposal-failures/` directories.

Complete local logs include row inputs, outputs, scores, feedback, candidate text, and reflection material. Read `result.json` for the terminal result, `reflections.jsonl` for proposal reasons, and `events.jsonl` for iteration order, candidate lineage, budget state, and Pareto updates. `evaluations.jsonl` mixes full-validation records with training-minibatch records. Before using it as validation evidence, filter to `split == "validation"` and require that `stage` is `seed_val_set` or `child_val_set`; also confirm the expected validation row count or completed validation event. `parent_minibatch` and `child_minibatch` have `split == "train"`. Training minibatch records must never be reported as full-validation outcomes. `evaluations.jsonl` contains no separately executed Final-held-out result. In the legacy local engine's raw `pareto_front_updated` payload, the **Pareto frontier** means candidates that achieve the best score on at least one validation row, including ties. The server-derived exported `paretoFrontier.candidateIds` is broader: it can include every candidate with recorded per-row or aggregate validation scores. Treat that export field as a scored-candidate inventory, not textbook non-domination. Do not infer a row-winner frontier from the export; identify row winners from a raw legacy payload or compute them from its per-example score matrix.

If local logs are unavailable, export the server-side archive:

```bash
orizu optimizations export <run-id> --out <run-id>.optimization.json
```

Server events redact row snapshots and reflection prompts by default, so an export may support less detailed diagnosis than complete local logs. State any missing evidence instead of inventing a scenario explanation.

## How To Build The Report

1. Confirm the seed, all candidate ids, their parent/child relationships, and their validation results. Include rejected, failed, or incomplete candidates and mark unavailable comparisons plainly; a score from one small training batch is not a substitute for a full validation score. A failed proposal that produced no child candidate id is a run event, not another candidate.
2. Map every evaluation row to a scenario class named in the improvement plan or dataset. If the logs lack a class, record the classification gap and recommend **Gather more evidence**; do not silently invent a class or leave the in-progress Promote flow. Keep the gap in the decision record and complete Promote's human decision; after Promote exits, route the recorded review incident through `flows/triage.md`.
3. Select the candidate on validation evidence. Explain why each other candidate was not selected, including any useful strength the selected candidate gives up.
4. Diagnose optimizer health from the frontier size, proposal acceptance rate, budget state, and validation score-over-time trajectory. This is what distinguishes a plateau from a promising search stopped by its budget.
5. Determine whether the current execution surfaces can reproduce the selected system before claiming a Final-held-out comparison. The optimization run does not execute the Final-held-out split: `run-gepa` and its logs contain only training and validation data.

   For a plain-prompt run, the human's single combined materialize-and-label promotion must have returned the selected `promptVersionId` before the CLI can execute that version, so this measurement is necessarily post-promotion. Execute the seed and selected prompt versions independently against exactly the Final-held-out split:

   ```bash
   orizu runners exec --prompt-version <selected-prompt-version-id> --runner-version <runner-version-id> --dataset-version <final-held-out-dataset-version-id> --split-set <split-set-id> --split <final-held-out-split-name> --out ./final-held-out-selected.jsonl
   orizu runners exec --prompt-version <seed-prompt-version-id> --runner-version <runner-version-id> --dataset-version <final-held-out-dataset-version-id> --split-set <split-set-id> --split <final-held-out-split-name> --out ./final-held-out-seed.jsonl
   ```

   For a standalone plain-prompt run, these commands faithfully execute the seed and selected prompt versions as-is. A valid set-of-one instruction-set shipping flow must not use the `promptVersionId` that `optimizations promote` would return; the current flow stops at the provenance gap above, and any later pushed profile remains subject to the instruction-set execution limits below.

#### Flat-row scorer contract

   The two `runners exec --prompt-version` commands above produce real seed and selected Final-held-out output files, but stop there. Do not send the GEPA selection scorer to `scorers exec`: that command accepts only set-mode `builtin_metric` scorers, while `run-gepa` resolves a `prompt_runner` scorer with a backing prompt and runner. `runners exec --scorer-version` reads a registered dataset rather than either generated output file and sends the bare dataset row without GEPA's candidate injection, `candidate_error`, or `gepa` provenance. `scorers verify-parity --outputs <outputs.jsonl>` does feed normalized `row_id` plus string `model_output` rows to the frozen flat-row scorer with GEPA's enriched payload. Normal `runners exec` artifacts are not guaranteed to have that normalized shape, and `verify-parity` reports aggregate parity, mismatches, and errors rather than exporting every successful per-row scorer result or comparing seed scores with selected scores. The missing supported capability is normalization plus per-row score export and paired seed-versus-selected comparison, so the paired Final-held-out score artifact cannot be produced today. Record both runner-output paths, mark Final-held-out scoring unavailable, recommend **Gather more evidence**, and name that missing capability. Do not substitute separately reconstructed output-bearing datasets or label a spot-check as Final-held-out decision evidence.

#### Default GEPA scorer contract

   For a run that used the default `gepa` scorer contract, stop rather than improvising a local adapter. No supported Orizu CLI or vendored-Python command-line entrypoint currently accepts the two runner-output JSONL files and applies the default `gepa` scorer contract. The vendored `orizu-gepa` and `orizu-gepa-connector` entrypoints launch optimizations; the Python package exposes `make_scorer_runner` only as a library function; `scorers verify-parity` refuses the `gepa` contract; and `--runner-dir` only selects a hash-verified registered runner snapshot. None is a post-hoc file scorer. The run's recorded seed and selected-candidate metric outputs may be compared as a validation-only workaround when both have complete validation coverage; they do not score the Final-held-out rows or satisfy the Final-held-out gate. Record the filtered validation artifacts and both Final-held-out runner-output paths, mark Final-held-out scoring unavailable, recommend **Gather more evidence**, and name a supported post-hoc GEPA scorer surface over runner-output files as the required product capability.

   For either scorer contract, record the two runner-output paths and the unsupported-scoring limitation; do not claim score artifacts, a paired comparison, or Final-held-out evidence that no supported command produced. For default-`gepa`, also record any complete validation-only workaround artifacts and label them validation-only. `scores submit` accepts either a prompt-version subject or an optimization-run/candidate subject, but submission is not required for the report and a `profileVersionId` itself is not a score-submission subject.

#### Instruction-set execution limits

   Current `runners exec` cannot address an instruction-set profile version. Multi-component promotion returns a `profileVersionId` plus component statuses without the component prompt-version ids needed by that command, and one prompt-version execution cannot reproduce the complete profile. For a set-of-one instruction set, `instructions push` creates the profile version that carries the selected component value, but the optimization run does not supply that profile as its result and `runners exec` still cannot address its `profileVersionId`. Execute by component prompt-version id only when an independently confirmed association identifies that exact pushed profile and supplies its manifest, settings, and pins. Do not infer a profile through a component prompt-version id: implicit resolution can select a newer profile that shares that component. If the required exact profile context cannot be established, mark instruction-set Final-held-out execution unavailable, recommend **Gather more evidence**, and name exact profile-addressed runner execution as the required product capability. Never reuse validation rows or reopen candidate ranking with Final-held-out.
6. Decide whether the improvement is larger than expected noise and whether any regression is unacceptable. **Run-to-run noise** means score movement caused by sampling or model variation rather than by the instruction change. The stored `confidence_interval_95` describes one system's single score run; it is not a confidence interval for the seed-to-selected change. Comparing two per-system intervals for overlap is not a significance test. Use `evaluations.jsonl` only for validation diagnostics; Final-held-out significance requires the separately generated Final-held-out comparison artifact. Sanctioned change evidence is repeated Final-held-out seed and selected runs or paired per-row differences from that Final-held-out artifact. Otherwise write “significance was not measured.” Statistical significance means the measured change is unlikely to be explained by measured chance variation alone; it does not make a tiny gain useful. The **practical threshold** is the smallest improvement the team agreed would matter; if none exists, state that no threshold was agreed and recommend agreeing one before the next run. A **scenario guardrail** is the largest decline the team agreed to accept for one scenario class.
7. Write a recommendation and named next move for every scenario that did not improve or regressed. When the move changes examples, coverage, labels, or split design, keep it as a named next move until Promote records the human decision; after Promote exits, route the recorded review incident through `flows/triage.md` rather than changing instructions without measurement or jumping into an internal First win stage.

For a rate, report the change in percentage points: 72% to 81% is +9 percentage points, not +9%. If judge alignment is reported, define **Cohen's kappa** as agreement after removing the amount expected by chance. Define a **confusion matrix** as the counts of correct and incorrect decisions for each class. Define any other statistical term in one plain sentence when it first appears.

## Copyable Report Template

Copy the template below and replace every bracketed instruction. Keep the section order. A section with unavailable evidence remains present and says what is missing.

```markdown
# Optimization Report: [instruction set] / [model config]

## Promotion Decision

**Recommendation:** [Promote / Do not promote / Gather more evidence]

**Why:** [One plain-language sentence that weighs the Final-held-out result—or the exact reason it is unavailable—the practical size of the change, uncertainty, and scenario regressions. Use the settled term Final-held-out when referring to the untouched final check.]

**What promotion changes:** [Describe the behavior users should notice and the main new risk. For a multi-component instruction-set run, name the complete profile version that would become production for this model config and state that other profiles and individual components do not move independently. For a plain-prompt run, name the prompt version. For a set-of-one instruction-set run, state that shipping is blocked when complete local execution-runner evidence is absent and because the CLI cannot prove run-versus-target settings equality; do not name a legacy optimization-promoted prompt version as the serving result.]

**Ship guidance:** [Say whether the Final-held-out improvement is larger than measured run-to-run noise and clears the pre-agreed practical threshold—the smallest improvement the team agreed would matter—or state that no threshold was agreed and recommend agreeing one before the next run. Name the change evidence: repeated runs, paired per-row differences, or the honest statement “significance was not measured.” For a plain-prompt run whose Final-held-out check was not obtainable before promotion, state that the decision uses validation-only evidence and either recommend Gather more evidence or provide the explicitly accepted post-promotion verification plan; never imply a completed Final-held-out proof. For a set-of-one run, recommend Gather more evidence and record that no winning-value push or pointer move was allowed when complete local execution-runner evidence is unavailable or because settings equality is unprovable through the current CLI. Never infer change significance from overlap between two single-system intervals. A statistically significant result is unlikely to be explained by measured chance variation alone; it is not automatically large enough to matter. Define each scenario guardrail as the largest decline the team agreed to accept for that class.]

**Human handoff:** [Name the exact production-pointer command for a human curator, or say why no command should be run. A plain-prompt run uses the human's single optimization promotion, which materializes the prompt and moves its prompt label immediately. A set-of-one instruction-set run never uses that command and currently has no authorized push or pointer command: record the execution runner only from the matching complete local `prompt_context.json`, record any missing runner or settings-version proof, then stop. Never substitute the exported component prompt's historical runner. The coding agent does not move a production pointer.]

## Run And Evidence

- Run: [id and dashboard link]
- Instruction set / subject / model config: [slug; recorded multi-component profile subject or recorded prompt subject; for a set-of-one run, record the execution runner from matching complete local `prompt_context.json` evidence or mark it unavailable, and mark the run-versus-target settings-version comparison unavailable; model-config identity and settings version when exposed]
- Dataset: [dataset version, split set, train, validation, and Final-held-out names and row counts]
- Scorer / runner / optimizer: [names and version ids]
- Local logs or export: [path]
- Limits: [missing files, redaction, small sample, scorer caveats, or “none known”]

Validation data ranked candidates. Final-held-out was reserved exclusively for the seed-versus-selected-candidate comparison. Record the real seed and selected runner-output paths when those commands ran, but for either the flat-row or default-`gepa` scorer contract mark Final-held-out scoring unavailable because no supported path produces the required normalized per-row paired score artifact; never invent score or paired-comparison paths. For default-`gepa`, record any complete validation-only workaround artifacts and label them validation-only. For a plain-prompt report written before promotion, write “not obtainable before promotion” and identify all evidence as validation-only rather than implying that the comparison already ran. For a set-of-one report, record the blocked settings-version proof and state that no winning-value push or pointer move occurred.

## Candidate Comparison (Validation Data)

Include the seed and every candidate found in the run logs. Do not omit a rejected, failed, or incomplete candidate; mark its validation score unavailable and explain why. When reading `evaluations.jsonl`, use only `split == "validation"` records whose `stage` is `seed_val_set` or `child_val_set`, and verify full validation coverage. Do not present a score from a training minibatch as a validation score.

| Candidate | Parent | Status | Validation result | Scenario gains | Scenario losses | Practical tradeoff | Why selected or not |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Seed | — | starting version | [score and row count] | [strengths] | [weaknesses] | [current behavior] | comparison point |
| [candidate id] | [parent id] | [retained/rejected/failed/incomplete] | [full validation score and row count, or unavailable] | [classes improved] | [classes regressed] | [what users gain and give up] | [reason] |

**Selection:** [Name the selected candidate and explain why its validation tradeoff is preferable to every fully evaluated alternative. If the engine-recorded seed candidate was selected, say optimization did not beat the seed. If no valid candidate exists, state that plainly. Neither branch has a promotion command.]

## Optimizer Health

- Frontier size: [legacy raw-event row-winner count when that payload is available; separately name the broader export inventory if used, and never relabel it as row winners]
- Proposal acceptance rate: [accepted child proposals / attempted child proposals, or “unavailable — event stream does not distinguish acceptance”]
- Budget state: [terminal state, budget kind, limit, observed usage, and whether the limit was binding]
- Validation score over time: [improving, plateaued, regressed, or unavailable; cite `scoreOverTime` / iteration evidence]

**Health diagnosis:** [Say whether search was still learning, plateaued, or could not be diagnosed, and connect that evidence to the budget next move.]

## Scenario Classes

Group outcomes by real scenario from the improvement plan or dataset, not only by confusion-matrix cell. The confusion matrix can support this section but cannot replace it. If a row has no trustworthy class, record the data-design gap instead of inventing one.

| Scenario class | Why it matters | Coverage | Seed -> selected on validation | What this class teaches | Next move and owner |
| --- | --- | --- | --- | --- | --- |
| [class] | [user/system consequence] | [training row count / validation row count] | [fixed, unchanged failures, regressions, and row ids] | [plain-language lesson] | [named action, owner, and flow] |

For each class that did not improve or regressed, choose and tailor a named move in the Promote decision record without leaving the in-progress flow. Complete Promote's human decision first; after Promote exits, route through `flows/triage.md` before executing any move below. Triage owns the eval-gap decision and any admitted transition into a complete improvement flow.

- **Add coverage — Triage:** establish the missing-coverage branch before collecting or creating more examples, creating a new dataset version, revisiting split and optimizer-batch coverage, and rerunning optimization.
- **Repair ground truth — Triage:** establish the broken-eval branch before sending named contested rows for human re-review, correcting rationales or labels, creating a new dataset version, and revalidating the judge before optimizing again.
- **Improve evaluator feedback — Triage:** establish the broken-eval branch before making the scorer explain the concrete disagreement, revalidating it, and rerunning.
- **Change the application — Triage:** establish that the failure needs retrieval, tools, state, or code rather than instructions, amend the ratified improvement plan when required, and name the engineering change.
- **Guard a regression — Triage:** establish the missing-coverage branch before adding the regressed rows and nearby counterexamples to a new dataset version, preserving them in validation, and rerunning candidate selection.

## What Changed In The Selected Version

- [Targeted change]: [Which scenario failure it addresses and evidence from logs.]
- [General restructuring]: [What behavior or output contract changes.]
- [Over-correction risk]: [Which scenario might get worse and how the Final-held-out check addresses it.]

For a multi-component instruction-set run, summarize the complete seed-to-selected profile diff; do not paste a large raw diff or describe one component as independently promotable. For a plain-prompt run, summarize the prompt-version diff. For a set-of-one instruction-set run, summarize the winning component change but state that it was not transferred or shipped because the required settings-version equality could not be proven.

## Final-held-out Result: Seed vs Selected Candidate

This section contains exactly the seed and the candidate selected on validation; do not rank candidates on Final-held-out. Results must come from a separate runner/scorer comparison, not from optimization training or validation logs. For a pre-promotion plain-prompt report, keep the section, mark every result “not obtainable before promotion,” and state that any later measurement is post-promotion verification. If exact instruction-set execution is unavailable, mark every result unavailable, name the missing profile-addressed execution or component-id surface, and use Gather more evidence rather than Promote. For both the flat-row and default `gepa` contracts, record real runner outputs if produced but mark Final-held-out scoring unavailable; no supported command turns those files into the required paired score artifact today. Identify any comparison of recorded run metrics as validation-only evidence, not a Final-held-out result.

| Measure | Seed | Selected candidate | Change | What it means |
| --- | --- | --- | --- | --- |
| [headline measure] | [value] | [value] | [absolute and percentage-point change for a rate] | [plain-language impact] |
| [scenario measure] | [value] | [value] | [change] | [benefit or regression] |

- Final-held-out row count: [count; note when fewer than 30]
- Run-to-run noise: [measured range or “not measured”]
- Change uncertainty: [repeated-run result, paired per-row-difference result, or “significance was not measured”; do not compare two single-system intervals for overlap]
- Fixed rows: [ids and scenario classes]
- Regressed rows: [ids, scenario classes, and operational cost]
- Still failing: [ids, scenario classes, and likely cause]

## Recommendation And Named Next Moves

1. **[Promote / Do not promote / Gather more evidence] — [owner]:** [Decision and reason.]
2. **[Scenario class] — [owner]:** [Specific dataset, annotation, judge, or application action; artifact to create; admitted flow to resume.]
3. **[Post-promotion monitoring, if promoting] — [owner]:** [Metric, scenario class, sample source, review point, and rollback trigger.]

- **Extend the search —** budget was binding and validation was still improving; rerun with a larger budget.

Use that named move only when validation scores were still climbing and the run exhausted its budget before plateauing. Name the validation trajectory, the exhausted limit, and the proposed new limit. Do not recommend more optimizer budget when results have plateaued or failures come from missing data, disputed labels, weak evaluator feedback, or capabilities outside the instruction set.

## Reproducibility

- Commands used: [start/export/finish commands with secrets omitted]
- Versions and settings: [runner, scorer, optimizer, inference/reflection model settings, component selector, optimizer batch size, thread count, budget, random seed, and cache settings. For a set-of-one execution runner, use only the matching complete local `prompt_context.json`; the export's component-prompt runner is not equivalent. Take other values from `run.json` or the export when recorded; otherwise recover them from the saved launch command. If an authoritative source lacks a value, write “unavailable — not recorded by the run” instead of guessing.]
- Links: [`optimization-with-gepa.md`, relevant dataset/judge references, dashboard and artifacts]

## Report Completeness Checklist

A report is incomplete if any required box below is unchecked.

- [ ] The recommendation says promote, do not promote, or gather more evidence, and explains what will change for the system.
- [ ] Every retained candidate is compared on validation data, including its gains, losses, and practical tradeoffs.
- [ ] Rejected, failed, or incomplete candidates are named and their missing evidence is explained.
- [ ] Optimizer health records frontier size, proposal acceptance rate, budget state, and validation score-over-time trajectory, or marks unavailable evidence explicitly.
- [ ] Every scenario class says what the run taught us and names the next move for any class that did not improve or regressed.
- [ ] Final-held-out evidence compares only the materialized seed and candidate selected on validation and records only artifacts actually produced by a supported surface. For flat-row and default-`gepa` scorer runs, the report may record the two real runner outputs but must mark scoring unavailable, name the missing normalization/per-row paired-score capability, route to Gather more evidence, and omit invented score or paired-comparison paths. A plain-prompt pre-promotion report says “not obtainable before promotion” and routes to Gather more evidence or an explicitly accepted post-promotion verification plan; an instruction-set execution gap also routes to Gather more evidence.
- [ ] Improvement beyond run-to-run noise is supported by evidence or marked honestly as unmeasured.
- [ ] Every statistical term has a one-line plain-language meaning at first use.
- [ ] The production decision is handed to a human curator; no coding-agent step moves a production pointer.
- [ ] Run ids, artifact paths, versions, split names, row counts, settings, and commands are recorded well enough to reproduce the comparison; an unrecorded setting is marked “unavailable — not recorded by the run.”
```

## Decision Rules

Recommend **Promote** when the selected materialized version beats the seed on untouched Final-held-out by more than measured noise, clears the pre-agreed practical threshold, no critical scenario breaches its guardrail, and the prompt or complete profile change is understood. State the post-promotion monitoring and rollback trigger. The plain-prompt path cannot meet that evidence ordering: if a human accepts live-first verification, phrase Promote only as a post-promotion verification plan based on validation-only evidence, disclose that Final-held-out was not obtainable before promotion, and name the watch window plus a confirmed external/manual rollback path. A set-of-one instruction-set run cannot currently receive Promote when complete local execution-runner evidence is unavailable and cannot receive Promote while the supported CLI cannot prove that the target profile settings version matches the optimization run. Legacy optimization promotion is never the set's ship or rollback path. If no practical threshold or rollback path was agreed, do not invent one; recommend Gather more evidence.

Recommend **Do not promote** when the seed was selected, no valid candidate exists, a critical scenario regresses, the Final-held-out result is worse, the gain is too small to matter, or evidence exposes a data, label, scorer, or application problem that another optimizer run will not fix. Seed-selected and no-valid-candidate runs finish without any promotion or result prompt version.

Recommend **Gather more evidence** when exact instruction-set Final-held-out execution is unavailable, either scorer contract lacks the normalization and per-row paired-score path needed for a Final-held-out decision, plain-prompt policy requires Final-held-out proof before production, a plain-prompt live-first decision lacks a confirmed external/manual rollback path, set-of-one runner/settings provenance cannot be proven, the Final-held-out sample is too small, run-to-run noise was not measured and could plausibly explain the gain, no practical threshold was agreed, candidate evaluations are incomplete, or redaction prevents scenario diagnosis. Name the cheapest next measurement and do not imply that uncertainty is improvement.

When a class is absent or thin in training, labels or rationales are contested, the scorer gives vague feedback or disagrees with human judgment, or the system needs tools, state, retrieval, or code, keep the finding in the Promote decision record and recommend Gather more evidence or Do not promote as the evidence supports. Complete the human decision without leaving Promote; after Promote exits, route through `flows/triage.md`. Triage decides whether coverage is missing, an eval is broken, or an application change is required; it amends the ratified plan when required and enters the complete admitted flow for any instruction optimization. Do not jump directly into a First win internal stage or force an application capability into instructions.

If a run ends with budget exhausted, the coding agent may finish the run. A multi-component instruction-set non-seed finish records `--best-candidate` and the report but omits the prompt-only `--result-prompt-version`; its earlier unlabeled profile materialization is agent-safe and its later idempotent production-label move is human-only. For a plain-prompt non-seed run, the human performs the candidate's single production-labelled optimization promotion and the agent records the returned `promptVersionId` when finishing. For a set-of-one instruction-set non-seed run, the agent never calls optimization promotion, push, or a serving-pointer command under the current provenance gap; it recommends Gather more evidence and finishes without a result prompt version. Seed-selected and no-valid-candidate runs finish without promotion or a result version. Auto-promotion is human-only; coding agents must not enable it or configure a run to trigger it.
