# ALI-1501 red-set hazards and mutation matrix

The tests in `tests/` are the Phase A red set. Each expectation comes from the
approved ALI-922 plan and its observability inventory, not from connector
output. They construct real `gepa==0.1.4` callback TypedDicts and drive its
real `optimize()` loop; the only fake is the adapter, which is the permitted
evaluation seam.

| Hazard prevented | Outer boundary test | Named mutant it must kill |
| --- | --- | --- |
| An official-GEPA run loses candidate identity, mean, or per-row evidence; a validation candidate is cut by the payload cap; or a sample output over the cap passes through unbounded. | `test_real_gepa_callback_translates_validation_components_and_truncation` | Drop envelope/payload candidate IDs, `score_mean`, a required row-result field, or the `validation` alias; bound `components` (ORI-2027); leave a row-result `output` unbounded or hide its cut from `truncation.fields`. |
| A candidate longer than `max_payload_chars` reaches the dashboard and the local `events.jsonl`/`reflections.jsonl` as `…[truncated]`, so the prompt that was evaluated can never be read back or promoted. | `test_accepted_candidate_stays_whole_on_the_wire_and_in_the_local_log_under_the_cap` (real `MandatoryEventSink` + real `LocalOptimizationLogger`) | Re-add `_bounded` to `candidate_proposed` components or `body`; bound `reflection_completed.candidate_text`; or stop bounding the reflection `response` (the cap must still bite on provider material). |
| The translator bounds seed/validation candidate components while the sample outputs the cap exists for pass through whole. | `test_translator_keeps_seed_and_validation_components_whole_and_bounds_row_outputs` | Pass the cap into `_components`; leave `row_results[].output` unbounded; report `components.*` in `truncation.fields`. |
| Under `--component-selector all`, only one of N reflections survives in `reflections.jsonl` and on the wire, and the surviving prompt is the last component's prompt attributed to another component. | `test_all_selector_reflection_logs_one_row_per_component_with_its_own_prompt` (real GEPA loop, real `GepaReflectionLM`) | Write one `reflections.jsonl` row per iteration; reuse the last provider prompt for every row; take every row's `candidate_text` from the first component; drop the `component` key; drop the `responses` map from `reflection_completed`. |
| Per-component reflection prompts leak in clear text under the default (redacting) policy. | `test_reflection_completed_redacts_per_component_prompts_unless_row_snapshots_are_logged` | Ship `prompts` without `log_row_snapshots`; drop `responses`. |
| A component GEPA rewrote gets no reflection row because one of its per-component maps lacks the entry. | `test_reflection_row_is_written_for_a_component_missing_from_raw_lm_outputs` | Take the row component list from `raw_lm_outputs` keys only. |
| A rejected proposal takes the old bounding path or logs one reflection row because rejection is a second copy of acceptance. | `test_rejected_candidate_stays_whole_and_logs_every_component_reflection` | Bound components on `on_candidate_rejected`; write one row; reuse one prompt; drop the `component` key. |
| GEPA's seed validation is rendered as a child and the dashboard loses its seed baseline. | `test_real_gepa_seed_valset_callback_uses_the_legacy_seed_wire_event` | Map candidate zero's iteration-zero validation callback to `child_val_set_completed`. |
| Lower-is-better optimization values leak into the dashboard as if they were raw scorer results. | `test_lower_is_better_callback_restores_raw_scores_for_the_dashboard` | Publish GEPA's inverted scores without converting them at the event boundary. |
| Reflection is no longer reconstructible in the dashboard. | `test_real_gepa_proposal_callback_preserves_reflection_and_candidate_shape` | Drop `raw_lm_outputs` or the candidate `components` map. |
| A large candidate is redacted or cut on the wire while the reflection response bypasses the cap. | `test_production_callback_redacts_only_prompt_and_bounds_large_event_fields` | Redact `response`/`candidate_text`; bound `body`, `components` or `candidate_text`; leave `response` unbounded. |
| A budget stops mid-iteration. | `test_real_gepa_engine_stops_only_after_a_completed_iteration` | Return true before the engine has emitted `on_iteration_end`. |
| Progress reports an invented unit or wrong counter. | `test_real_gepa_budget_event_translates_in_the_selected_unit` | Always report an iteration budget or alter the GEPA metric-call values. |
| A malformed scorer or all-worst seed reaches an expensive GEPA run. | `test_real_preflight_refuses_a_degenerate_seed_before_any_budget_is_spent` | Remove the bounded preflight refusal. |
| A promotion's server-written system event collides with the next connector event. | `test_production_sink_reserves_a_server_sequence_between_connector_events` | Increment connector sequences by one rather than reserving the interleaving server slot. |
| GEPA emits a merge that the one-parent lineage UI silently misrepresents. | `test_real_gepa_merge_callback_is_refused_with_an_explicit_run_note` | Translate a merge as an ordinary candidate rather than reject it with a named note. |
| The adapter bypasses Orizu's checked runner subprocess contract, drops feedback, sends out-of-range scores, or reverses a lower-is-better metric. | `test_real_runner_adapter_uses_the_legacy_file_contract_and_keeps_row_side_info` | Bypass `make_candidate_runner` / `make_scorer_runner`, omit side-info, remove score clamping, or skip direction normalization. |
| A default GEPA scorer is rejected by a resolved candidate field, a malformed scorer is mistaken for a degenerate seed, or the adapter hides the actual dataset row ID. | `test_default_gepa_contract_scorer_launches_without_candidate_field` | Reintroduce resolved `model_output` forwarding, reimplement scorer extraction, coerce a missing numeric score to zero, or use GEPA positional row indices. |
| Multiple runner subprocess rows execute serially despite an approved thread plan. | `test_runner_adapter_parallelizes_file_contract_evaluations_with_the_frozen_plan` | Replace the frozen bounded parallel evaluator with a serial adapter loop. |
| GEPA exposes a proposed text before assigning the child candidate id, leaving dashboard lineage unjoinable. | `test_real_callback_buffers_a_proposal_until_gepa_assigns_the_child_id` | Emit proposal/reflection in `on_proposal_end` rather than after `on_candidate_accepted`. |
| GEPA's generic evaluation callbacks never materialize the dashboard's parent/child comparison. | `test_real_callback_shapes_gepa_evaluations_as_dashboard_minibatches` | Forward generic evaluation events or omit per-row feedback / accepted totals. |
| A rejected GEPA child loses its only per-row dashboard evidence. | `test_rejected_gepa_child_still_materializes_its_minibatch_rows` | Flush child minibatches only from the accepted-candidate callback. |
| A rejected proposal loses lineage/reflection because GEPA has not assigned an id. | `test_rejected_proposal_keeps_lineage_and_reflection_before_its_decision` | Suppress buffered proposal/reflection on rejection. |
| Reflection errors and skipped perfect parents have unusable diagnostics. | `test_callback_diagnostics_preserve_reflection_error_and_skip_mean` | Emit empty errors or a score list instead of a mean. |
| The callback translation only accepts hand-assembled event shapes. | `test_real_gepa_engine_invokes_the_production_callback` | Disconnect the actual GEPA callback object from `optimize()`. |
| Every later GEPA proposal reflects on the seed rather than its selected parent. | `test_reflection_bridge_reads_the_current_gepa_parent_context_per_call` | Capture the initial seed text/results instead of reading the adapter context per reflection call. |
| A merge refusal reaches only an injected test callback instead of the production mandatory logger. | `test_real_production_run_note_sink_durably_posts_the_merge_refusal` | Replace `OrizuCallback`'s production `sink.run_note` wiring with a no-op. |
| A system promotion event collides with the connector's next event. | `test_production_sink_reserves_a_server_sequence_between_connector_events` | Increment connector sequences by one rather than reserving the interleaving server slot. |
| GEPA swallows a callback exception and a terminal success PATCH overwrites the durable logging failure. | `test_runtime_post_engine_check_blocks_success_after_a_swallowed_logging_failure` | Remove the production post-engine mandatory-logging check. |
| The full-validation budget interrupts the engine before a safe iteration boundary. | `test_full_evaluation_stopper_waits_for_the_completed_iteration_boundary` | Stop at `i=-1`, or require more than the configured completed full evaluations. |
| A degenerate seed creates an official GEPA run despite the launch-time refusal contract. | `test_seed_validated_hook_refuses_before_the_official_engine_starts` | Ignore a failed preflight verdict before `optimize()`. |
| The public entrypoint silently falls back to the retired synthetic event stream when real runner inputs are absent. | `test_public_entrypoint_refuses_to_fallback_to_the_retired_fixture_lifecycle` | Remove required runner/context environment validation and emit fixture events. |
## Manual end-to-end validation

The handler/Supabase/Python full-chain checks are **covered by manual
validation**, not an automated test. Run one development-machine optimization
against the production-parity API path and inspect the real dashboard
derivation, terminal PATCH, score-run materialization, promotion sequencing,
local `events.jsonl` after a forced API failure, scorer refusal before launch,
and perfect-seed skip behavior.

After the normal CLI wrapper has exported its verified runner paths and the
listed `ORIZU_*` context IDs, the direct development command is:

```sh
PYTHONPATH=packages/orizu-gepa/src:packages/orizu-gepa-python/src \
  .venv-gepa/bin/python -m orizu_gepa_connector
```

It requires `ORIZU_API_URL`, `ORIZU_TOKEN`, `ORIZU_PROJECT`, the optimizer,
prompt, dataset, split-set, scorer, and runner-version IDs, both verified
runner directories. Every launch has a hard stop: explicit `ORIZU_MAX_*`
limits win, otherwise the resolved legacy `ORIZU_BUDGET` preset is passed to
the official GEPA engine as its metric-call ceiling. The
production CLI export/wrapper remains ALI-1502 scope.

The complete launcher-facing environment contract is:

- transport/identity: `ORIZU_API_URL`, `ORIZU_TOKEN`, `ORIZU_PROJECT`,
  `ORIZU_OPTIMIZER_VERSION_ID`, `ORIZU_PROMPT_VERSION_ID`,
  `ORIZU_DATASET_VERSION_ID`, `ORIZU_SPLIT_SET_ID`,
  `ORIZU_SCORER_VERSION_ID`, `ORIZU_RUNNER_VERSION_ID`,
  `ORIZU_CANDIDATE_RUNNER_DIR`, `ORIZU_SCORER_RUNNER_DIR`, and optional
  `ORIZU_SCORER_RUNNER_VERSION_ID`;
- dataset/runner: `ORIZU_TRAIN_SPLIT`, `ORIZU_VALIDATION_SPLIT`,
  `ORIZU_SCORER_INPUT_CONTRACT`, `ORIZU_SCORER_CANDIDATE_FIELD`, and
  `ORIZU_VERIFIED_RUNNER_DIRS`;
- budget/execution: `ORIZU_BUDGET`, `ORIZU_MAX_METRIC_CALLS`,
  `ORIZU_MAX_ITERATIONS`, `ORIZU_MAX_FULL_EVALS`,
  `ORIZU_MAX_CANDIDATE_PROPOSALS`, `ORIZU_MINIBATCH_SIZE`,
  `ORIZU_NUM_THREADS`, `ORIZU_SEED`, `ORIZU_DISABLE_EVALUATION_CACHE`,
  `ORIZU_ALLOW_DEGENERATE_SEED`, `ORIZU_LOG_ROW_SNAPSHOTS`,
  `ORIZU_NO_LOCAL_LOG`, `ORIZU_LOCAL_LOG_DIR`, `ORIZU_MAX_PAYLOAD_CHARS`
  (bounds sample outputs and reflection prompts/responses in streamed
  events, default 16000 characters; never candidate components), and
  `ORIZU_METADATA`;
- reflection/selection: `ORIZU_REFLECTION_MODEL`,
  `ORIZU_REFLECTION_TEMPERATURE`, `ORIZU_REFLECTION_MAX_TOKENS`,
  `ORIZU_REFLECTION_RETRY_ATTEMPTS`,
  `ORIZU_REFLECTION_HTTP_TIMEOUT_SECONDS`,
  `ORIZU_REFLECTION_PROMPT_TEMPLATE`,
  `ORIZU_REFLECTION_PROVIDER_SETTINGS`, `ORIZU_EPSILON`,
  `ORIZU_CANDIDATE_SELECTION_STRATEGY`, `ORIZU_OBJECTIVE`, and
  `ORIZU_SKIP_PERFECT_PARENT_REFLECTION`; and
- promotion and named preflight refusals: `ORIZU_AUTO_PROMOTE`,
  `ORIZU_PROMOTION_LABEL`, `ORIZU_USE_MERGE`,
  `ORIZU_MAX_MERGE_INVOCATIONS`, `ORIZU_SAMPLING_STRATEGY`, and
  `ORIZU_SELECTION_STRATEGY`.

`ORIZU_SKIP_PERFECT_PARENT_REFLECTION=0` is the legacy
`--no-skip-perfect-parent-reflection`; every non-false value is the legacy
`--skip-perfect-parent-reflection`. The reflection variables are passed to the
imported frozen reflection provider. `ORIZU_EPSILON` is supplied through
official GEPA's public epsilon-greedy selector rather than its fixed-0.1 string
shortcut. The only deliberate refusals are merge and P×N selection because the
M1 official-engine bridge cannot faithfully represent those legacy topologies;
their explicit errors name ALI-1506/ALI-1507 before a run is created.

The imported frozen execution helpers additionally read
`ORIZU_GEPA_AUTO_THREADS_MAX` and `ORIZU_GEPA_WORKER_MEMORY_MB` for their
bounded-thread plan, and set/read `ORIZU_RUNNER_INPUT_PATH` and
`ORIZU_RUNNER_OUTPUT_PATH` inside each runner subprocess. They are internal
execution plumbing, not `run-gepa` launcher flags.

The connector intentionally imports the frozen `orizu_gepa` sources through
`PYTHONPATH`; packaging that sibling source as a pip dependency is M2 /
ALI-1503 scope, so this package must not add it as a dependency.

## Local result contract

`result.json` records `best_candidate_text` as a string for a one-component
candidate, preserving the legacy prompt artifact exactly. For a genuine
multi-component candidate (a map with more than one key), it records the full
component map so no rewritten component is discarded.

The TS wrapper resolves the real GEPA package from the vendored CLI copy when
available, otherwise from `.venv-gepa`. If neither import location exists, it
fails rather than silently skipping the official engine.

That manual pass also verifies candidate-id stability (seed `0`, descendants
with a persisted parent), inclusive `[0, 1]` score values, optimizer-family
tab unlock, terminal PATCH materialization, and the validation split alias.
The decided character-cap truncation rule is prefix plus `…[truncated]`, with
`payload_truncated: true` and original byte lengths in `truncation.fields`.
The cap applies to sample outputs (row-result `output`) and to reflection
prompts and responses only. Candidate components (`candidate_proposed`
`components`/`body`, `run_started` seed components, valset `components`,
`reflection_completed` `candidate_text`/`components`) are never bounded, on
the wire or in the local log: a cut candidate could not be read back or
promoted as evaluated (ORI-2027). `payload_truncated` is therefore false
unless a bounded field was actually cut.
For legacy parity, `log_row_snapshots` redacts only the reflection prompts
(`prompt` and the per-component `prompts` map); the reflection `response`,
the per-component `responses` map and `candidate_text` remain visible
dashboard evidence. Under `--component-selector all`, `reflections.jsonl`
holds one row per reflected component, each with a `component` key and that
component's own provider prompt, response and new text (ORI-2030); the wire
`response`/`prompt` keep the legacy first-entry shape beside the full maps.
Preflight evaluates at most three validation rows solely to reject a broken
scorer/degenerate seed before creating a run; GEPA performs the single
authoritative full seed validation after launch, so the preflight does not
double-charge a full validation pass.
