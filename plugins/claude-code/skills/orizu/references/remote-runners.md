# Build a remote runner

A **remote runner** is your agent behind a URL you host. Orizu calls it instead of starting a **packaged runner**, an uploaded copy of your code. Your endpoint runs the candidate with your own model-provider keys, on your bill. Return outputs, not grades: scoring stays on Orizu's side.

**Supported contract:** registration, checks, candidate-loading helpers, pinned profile settings, execution and optimization with inline or callback replies, including spans passed to scorers. Exec and optimization share parallel-call limits, retries, and one deployed version per run. Bare exec writes results for separate scoring/submission; optimization runs the scorer and saves its run evidence. Hosted optimization additionally requires an explicitly stored secret and a passed check for the exact runner version; see [Hosted optimization](#7-hosted-optimization).

Availability depends on your installed CLI and the team's hosted activation. A human owns CLI release and production activation. Remote scorers remain unsupported.

## 1. Choose a versioned URL and isolate side effects

Register **one remote runner per deployed variant**, each with its own versioned URL: planner v1, planner v2, or planner with and without a summary step. Keep old variants reachable so earlier evaluations can be repeated. Containers or Harbor are optional ways to keep them running, never requirements; Orizu does not host them.

Run the real agent code path, with integrations pointed at **sandboxes or mocks**: isolated test accounts or stand-ins. **Never use production accounts.** Evaluations must not create real pages, issues, conversations, messages, or other production changes. Use only data and outputs approved for these evaluations.

A repeated `request_id` means the same logical call. The endpoint must reuse earlier in-flight work or a saved answer rather than repeat external actions. Sending the same label does not itself prevent repeated actions. A timeout, cancellation, or lost connection can follow work your server already completed; closing the connection does not undo it.

## 2. Accept an authenticated JSON POST

Require a long-lived service secret scoped to the eval route, not an expiring staff login token. Read it from an environment variable such as `REMOTE_RUNNER_PLANNER_SECRET`; arrange the same secret in the local CLI environment. Refuse startup or requests if your endpoint's secret is unset. Check:

```http
Content-Type: application/json
Authorization: Bearer <secret>
```

Return 401 or 403 for a missing or wrong secret. Keep secrets out of URLs, rows, request logs, replies, and saved results. Orizu sends no model-provider keys. Registration stores only the secret environment variable's **name**, which must start with `REMOTE_RUNNER_`.

Use HTTPS. Plain HTTP is allowed only for local `localhost`, `127.0.0.1`, or `::1`. URLs cannot contain a username or password. Redirects are not followed: register the final URL.

### Request

Here are the core fields of an instruction-set request. Row and component names are examples; choose the inputs and complete component shape your agent needs.

```json
{
  "run_id": "11111111-1111-4111-8111-111111111111",
  "request_id": "22222222-2222-4222-8222-222222222222",
  "row_id": "example-1",
  "row": { "text": "hello", "calendar": [] },
  "candidate": {
    "components": { "system": "SHOUT the answer." },
    "model_config": {
      "identity": "acme/planner",
      "settings_version_id": "33333333-3333-4333-8333-333333333333",
      "provider_settings": { "temperature": 0.2, "reasoning": { "effort": "high" } }
    }
  }
}
```

- `run_id` identifies an execution; optimization preflight can run before the saved optimization run exists. `request_id` identifies one logical call and stays unchanged across its retries; `row_id` identifies the dataset row.
- `callback_url` is a single-use URL for a later result if you answer 202 instead of returning the result inline. It contains a secret token: keep the whole URL out of logs and replies. See [Callbacks](#callbacks).
- `row` contains the selected row as stored. Prefer captured row inputs over reading a live account.
- `candidate.components` is the complete instruction-text map to run, not a patch to Production. Use it in your normal agent path. `runners exec` uses saved candidates; local `run-gepa` also sends unsaved candidate text. The helpers accept either without requiring a candidate ID, saved profile version, or resolved Production pointer.
- `candidate.model_config` carries `identity`, `settings_version_id`, and `provider_settings` together.

`provider_settings` contains the frozen settings pinned by that Profile Version, never the Model Config's latest settings or a component's legacy settings. A Profile Version created without a settings pin sends `settings_version_id: null` and `provider_settings: {}`. If deleting the source settings row clears the ID, the retained frozen snapshot must still be sent. The legacy `prompt.provider_settings` field is omitted for instruction-set requests; use the candidate's supplied settings instead.

A standalone prompt sends its own `candidate.model_config.provider_settings`, with `identity: null`, `settings_version_id: null`, and `components: { "prompt": "<text>" }`. The candidate-loading helper below requires a non-empty identity: an endpoint built for instruction sets should refuse unsupported standalone requests rather than invent one.

`runners exec` also carries `prompt`, optional `instruction_set`, `subject`, `scorer`, `model_output`, `prompt_version_id`, and `runner_version_id`. Allow extra fields; use `candidate` as the instruction source. Optimization uses the same core contract, not a second endpoint format; optimization and checks can omit some companions. Components stored only in git are currently refused before an exec call; save their inline text first. Remote scorers are not supported.

## 3. Load the request candidate through the helper

Follow [offline instruction-set sync](cli-reference.md#offline-instruction-set-sync) to obtain current vendored TypeScript helpers from an exact profile version, such as `planner/acme/planner@v1`; use your own set, model identity, and version. `--out` selects the app root: synced material lands under `<app-root>/orizu/`, not directly in the root. Sync writes the helpers, `generated/index.ts` import map, and version-specific `components.generated.ts` modules there. Bundle these with your application, or compile JavaScript into a separate `outDir`, never beside the emitted TypeScript files. If a helper has local edits, sync preserves them; review before deliberately replacing it with `--force-helpers`.

In the eval handler, pass the **same request-local source** to both helpers:

```ts
import { loadInstructions } from './orizu/helpers/load.js'
import { loadModelConfig } from './orizu/helpers/model-config.js'

function loadCandidate(request: { candidate: unknown }) {
  const source = {
    candidate: request.candidate,
    expectedShape: ['system'], // Your agent's exact component names.
  }
  const loaded = loadInstructions(source)
  const config = loadModelConfig(source)
  return { loaded, config }
}

// After authentication and JSON parsing:
// const { loaded, config } = loadCandidate(request)
// Run your normal agent with request.row, loaded.components, and config.
```

Keep `expectedShape` in endpoint code, not in the request. Every component must be a string; missing, extra, or wrongly named components fail. The model identity must be a non-empty string. Malformed candidates throw named `InstructionSetLoadError` or `ModelConfigError` errors: return a refusal, **never fall back to synced Production instructions**.

The helpers map the explicitly supplied `provider_settings` into `loaded.settings` and `config.RAW`, with named settings such as `TEMPERATURE` available on the config. They do not look up settings by `settings_version_id` or borrow synced settings. For backwards compatibility, omitted `provider_settings` gives `loaded.settings: {}` and `config.RAW: {}`, with named settings undefined; current instruction-set calls send the frozen snapshot. `provider_settings` itself must be a JSON object, not `null`, an array, or a string. Its members may contain strings, booleans, nested objects, arrays, and `null`; numbers must be finite. Known settings still need the right types and non-conflicting aliases; unknown JSON members are preserved. `config.PROVIDER`, `config.MODEL`, and `config.CONFIG_IDENTITY` identify the requested model; `config.RAW` preserves supplied settings. Map these into your existing model call instead of silently substituting a feature-flag choice.

The endpoint MUST apply the supplied Model Config settings to its real model calls. If it cannot support the requested config or any supplied setting, it MUST return HTTP 422 with `{"error": {"code": "model_config_unsupported", "message": "…"}}` rather than silently ignore it. Loading the Helpers alone does not apply settings to a model call.

The helper copies candidate values per load and makes the model config immutable. Candidate provenance is `{ kind: 'candidate' }`, not a saved-version ID or digest. It cannot pass synced-version `verifyIntegrity`; do not invent saved provenance for it. Production can continue using `loadInstructions('set/profile@vN')` through the same agent code path.

## 4. Return the result

Return HTTP 200 with a JSON object, for example:

```json
{
  "model_response": { "action": "read_calendar" },
  "raw_api_response": { "output": "read_calendar" },
  "token_in": 1200,
  "token_out": 80,
  "latency_ms": 1800,
  "cost_usd": 0.003,
  "error": null,
  "deployed_version": "planner-v1-20261016-abc123",
  "live_data_inputs": ["user_context"]
}
```

The current validator requires:

- `deployed_version`: a non-blank string of at most 200 characters, **including on row errors**. It names the code that actually ran, not the candidate's instruction version or Orizu's registered `runner_version_id`. Candidate instruction changes alone should not change it; do not hide code changes behind a constant.
- A non-null `model_response` **or** a string `error`. Output may be text or structured JSON; `false`, `0`, and `""` are valid outputs.
- Optional `raw_api_response`: the raw model response, when available.
- Optional `token_in`, `token_out`, `latency_ms`, `cost_usd`: finite numbers or `null`. Omit unknown measurements rather than invent zeroes; missing usage or cost can leave cost unknown.
- Optional `error`: a string or `null`.
- Optional `live_data_inputs`: an array of input **names**, never values, for inputs filled from live data instead of the row. Omit it or use `[]` when none. Exec retains it in the row result. Local optimization also saves the affected row IDs and input names and shows them on the run detail page. Reporting fallback is not permission to use production accounts.

- Optional `spans`: JSON records of the agent's steps; see [Spans](#spans).

**Maximum result size: 10 MiB (10,485,760 bytes)** for every terminal remote result or error reply, including the output, raw response, and spans together. The callback receiver applies the same incoming-body limit; a 202 acknowledgment body is discarded, not treated as a result. This counts received UTF-8 body bytes, not characters. An over-limit inline reply fails the row with its ID and the limit. The callback receiver refuses an over-limit submission with HTTP 413; the CLI still waits for a valid callback until the row deadline. Neither path truncates or scores an over-limit result. Only the listed fields are retained. Unknown fields, including `score`, `judge_score`, and `passed`, are discarded. Orizu adds its own row and registered-version IDs.

The first validated reply sets the deployed version for the whole execution. Local optimization keeps that same version across preflight, seed evaluation, and all later candidates. A different string fails the run rather than mixing versions. Orizu does not send an expected deployed version for the endpoint to enforce.

### Spans

Spans work with `runners exec` and local or hosted `run-gepa`, through inline replies and callbacks. Return them in an optional top-level `spans` field, separate from `raw_api_response`. Use OpenTelemetry JSON and follow its [AI-call conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) for model and tool calls. For example, include trace/span IDs, parent links, timings, attributes, and events so a judge can grade the agent's actions, not just its final answer.

Orizu treats `spans` as opaque JSON: it preserves arrays, objects, and nested values without checking an OpenTelemetry schema, renaming fields, or shortening traces. Callback submissions also retain the coordinator's existing safety limits: at most 100 nesting levels and 100,000 object/array openings and separators outside strings. Local cleanup removes the known local remote secret from all fields, including trace keys or values; hosted secret safety follows the [hostname trust boundary](#7-hosted-optimization) below. Keep credentials and unapproved customer data out of traces yourself. Omit `spans` when unavailable; existing scorers need not change.

Where a scorer reads them:

- After `runners exec`, each result line retains `spans` beside `raw_api_response`. A set scorer's input mapping can select `$subject.spans` or a nested object field.
- In local or hosted `run-gepa`, a packaged scorer using the default `gepa` input contract receives `row.candidate_spans` beside `row.candidate_raw_response`.
- A packaged scorer using `flat_row` receives `gepa.candidate_spans` beside `gepa.candidate_raw_response`, outside the dataset row to avoid collisions.

Those Python companions are omitted when the candidate did not return spans. Both scorer contracts are described in [Scorer-runner input contracts](prompt-control-plane.md#scorer-runner-input-contracts-flat-row-vs-gepa).

The runner's 10 MiB per-result limit is not a whole-file upload allowance. Server-side `scorers exec --subject-results` currently sends the entire JSONL file in one app request, so large files may hit the app host's request limit before scoring. Large callback results are read through the app and may also hit its response limit. Local `run-gepa` avoids the server-scoring upload; its inline candidate-result path goes directly to the remote runner.

### Callbacks

For a long agent run, answer HTTP 202 and later POST the same result JSON to the supplied `callback_url` with `Content-Type: application/json`. Include `deployed_version`, output or a string row error, and optional raw response, usage, live-data names, and spans just as for an inline reply. A 202 acknowledgment alone cannot complete a row; its body is ignored. An inline HTTP 200 result remains supported.

The first valid callback consumes the URL; later submissions are refused. The receiver also refuses malformed, over-limit, expired, or credential-bearing deployed versions. Keep the single-use URL out of logs, traces and replies, and keep secrets out of the entire result. Orizu waits for the stored result without resubmitting an accepted endpoint request. A callback can arrive before Orizu finishes reading the acknowledgment. Exec and optimization apply their ordinary result checks and deployed-version rule before scoring or saving it. Checks report whether a callback arrived.

Registration, endpoint attempts, and callback waiting share one configured row budget; see [Shared execution limits and retries](#shared-execution-limits-and-retries). Use callbacks for long runs rather than holding the endpoint response open. Stopping the CLI stops waiting; it does not undo customer-side work.

### Row errors versus refusals

For an agent or model-output parsing failure on one row, return 200 with a string `error`, usually `model_response: null`, and `deployed_version`. Exec records that row failure without treating it as an HTTP refusal; it can even pass a contract check. Optimization may still stop if seed or scorer validation fails.

If you cannot serve the requested model configuration or any supplied setting, return HTTP 422:

```json
{
  "error": {
    "code": "model_config_unsupported",
    "message": "This endpoint only supports acme/planner."
  }
}
```

Other refusals use the same nested error shape, an appropriate non-2xx status, and their own code. Include a useful message without secrets. Refusals, invalid or oversized replies, unreachable endpoints, timeouts, and changed deployed versions stop `runners exec` without writing partial output files. In optimization, rejected remote results fail the run rather than being scored; a run already created can retain accepted evidence and logs for diagnosis. Neither command undoes endpoint work.

## 5. Register, check, then execute

Use a signed-in local CLI, outside a session (`--session` is not supported here). Provision the service secret in both environments before checking. `--secret-env` takes its name, never its value.

Save the core request example above as `remote-runner-check.json`, adapted to your real row, components, and supported model identity. Include the frozen settings and matching settings-version ID, as current exec calls do. Then:

```bash
orizu runners add-remote planner-v1 \
  --url https://staging.example.com/orizu/planner/v1 \
  --secret-env REMOTE_RUNNER_PLANNER_SECRET \
  --input ./remote-runner-check.json \
  --max-parallel 4 --timeout-seconds 120 \
  --project team/project --json
```

Registration checks the endpoint **before saving it**; a failed check refuses registration. Capture `runner_version_id` from the reply. `--no-check` skips the call and registers an unproven version, even without a local secret. A later check can prove that exact version:

```bash
orizu runners check planner-v1 \
  --version <runner-version-id> \
  --input ./remote-runner-check.json \
  --project team/project --json
```

Without `--version`, check selects the latest saved version for that runner name. `--input` must contain `row` and `candidate`, including `components` and `model_config` with `identity` and `settings_version_id`; `provider_settings` is optional for compatibility, but include it to check your actual settings. Check sends the supplied JSON; it does not fetch settings by ID or verify that the supplied settings match that ID. Extra top-level input is preserved. Orizu replaces any supplied `run_id`, `request_id`, and `row_id` with fresh IDs and leaves the file unchanged.

Without `--input`, add/check sends `row: { "text": "Reply OK" }`, `components: { "prompt": "Reply OK." }`, and model config `{ "identity": "openai/gpt-5.4-mini", "settings_version_id": null, "provider_settings": {} }`. A real endpoint will often need a custom sample rather than that generic shape.

### What the check verifies

Checks make one attempt, without retries; the execution retry policy below does not apply to checks. That call reports `reachable`, `secret` (`accepted`, `refused`, or `not_checked`), `result_shape` (`valid`, `invalid`, or `not_checked`), `callback` (`arrived`, `not_used`, `timed_out`, or `not_checked`), `deployed_version`, `passed`, and a diagnostic `message`. Stages not reached stay unknown or not checked. A successful command also saves a small passed-check receipt for that exact registered runner version, with the deployed version and server time, not the request, output, or secret.

A pass means the supplied secret got a successful response with a valid result for **one sample**. It does **not** test rejection of wrong secrets, answer quality, settings application, safe integrations, duplicate handling, version stability across rows, parallel calls, or callback timing and failure cases beyond that sample. Test wrong-secret rejection yourself. An HTTP 200 string row error still passes: this is a connection and contract check, not proof the agent succeeded.

### Execute a dataset split

With an existing saved component prompt version, immutable dataset version, and split set:

```bash
orizu runners exec \
  --prompt-version <prompt-version-id> \
  --runner-version <runner-version-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id-or-name> --split validation \
  --out ./results.jsonl
```

This downloads the registered remote-runner manifest and calls its URL; no `--runner-dir` is needed. Exec currently selects by component prompt-version ID, **not** an explicit instruction-set profile-version selector. Do not infer exact profile/settings reproduction from that ID alone. Inspect the resulting `deployed_version`, outputs, errors, and `live_data_inputs`. Scoring and run submission are separate steps in [Instruction control plane](prompt-control-plane.md).

## 6. Run local optimization

After preparing a validated row scorer and the dataset splits, follow [Optimization with GEPA](optimization-with-gepa.md) and the [Authority map](authority-map.md). Select the registered remote runner as the candidate runner and a **packaged runner** for the scorer:

```bash
orizu optimizations run-gepa \
  --project team/project \
  --optimizer-version-id <optimizer-version-id> \
  --instruction-set <set/profile@vN> --component-selector all \
  --runner-version-id <remote-runner-version-id> \
  --scorer-version-id <row-scorer-version-id> \
  --scorer-runner-version-id <packaged-scorer-runner-version-id> \
  --dataset-version-id <dataset-version-id> --split-set-id <split-set-id> \
  --train-split train --val-split validation \
  --engine official --budget light --reflection-max-tokens 2048
```

Omit the runner-directory flags to download and verify the registered versions. Both the official and legacy engines can call remote candidates. Python uses the same customer HTTP contract, settings, reply validation, and secret rules as exec; there is no second customer endpoint to build. The remote secret stays in the CLI launcher, not the Python optimizer or packaged scorer environment.

After a validated reply establishes the deployed version, the saved optimization and its run detail page show the remote runner name, registered runner version, deployed version, and live-data row IDs with input names. Before that, the page omits the remote-runner block, even if partial runner metadata has been saved. The evidence includes accepted rows gathered after preflight, not just the first sample. A failed or cancelled run can retain that evidence; cancelling does not undo endpoint work. Local logs also retain remote-runner metadata.

### Shared execution limits and retries

Both `runners exec` and local `run-gepa` respect the registered `max_parallel`: default 4, allowed range 1–64. It limits calls within that execution, not across independent CLI processes, and is not a shared rate limiter. Exec preserves dataset order in its output even when calls finish out of order.

Only connection failures and HTTP 502/503/504 are retried, **at most twice** (three attempts total), with the **same `request_id` and body**. Other statuses, including 500, 401/403, and 422, are not retried; neither are malformed replies, version mismatches, or timeouts. Your endpoint must reuse earlier work on repeated request IDs as required above.

The per-row timeout covers registration, all attempts, reading the result, and callback waiting: default 900 seconds (15 minutes), configurable from 1 to 3600 (one hour). Waiting for a parallel-call slot does not consume that row's timeout. Checks still make only one attempt. Scorers must remain packaged runners.

## 7. Hosted optimization

After the exact remote runner version passes a check, a human explicitly uploads its service secret:

```bash
orizu runners set-hosted-secret <runner-version-id> \
  --host staging.example.com \
  --secret-env REMOTE_RUNNER_PLANNER_SECRET --project team/project
```

Name the registered hostname and local secret variable explicitly. The command stores the value in Supabase Vault for **that project, runner version and host**, not for the variable name. Another version or host needs another explicit upload. Registration, checks and launch never upload a local secret automatically.

Add `--hosted` to the official optimization command above. The team must have hosted access, and its usual budget, capacity and provider checks still apply. An unchecked remote runner or missing stored credential is refused before a sandbox starts. Inline and callback replies use the same endpoint contract, including spans; hosted callbacks belong only to that run's agent session.

Hosted URLs require standard-port HTTPS with a normal DNS hostname, not local/private/IP targets. Only the registered hostname is added to that run's existing allowed hosts. The firewall adds Authorization outside the sandbox; the real secret is not delivered to sandbox processes or files. This trusts **every path at that hostname**. The receiver must never reflect Authorization in responses or logs: outbound header injection cannot prevent a receiver returning its own secret. Hosted HTTP refusals show status-only diagnostics rather than exposing response bodies.
