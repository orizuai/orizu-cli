# Assess & plan

This journey turns evidence from the customer's codebase into an evals-first improvement plan. It ends before dataset construction: the durable exit artifact is a human-ratified `improvement-plan.md` written to the canonical path in section 7 and committed before data access.

## 1. Hold the data boundary

Survey code, configuration, documentation, and the names and wiring of integrations. Inventory candidate customer data, but do not open or read, export, sample, transform, or upload it. Do not call a provider, run a production query, copy traces, or create an Orizu dataset during this journey. Inspect secret names and configuration shape only; never read credential values.

Only after the user ratifies the plan and the ratified plan is committed at its canonical path, together with the required workbench memory pointer, may J3 — Build the dataset access the approved sources. If the user asks to move data while decisions remain open, show the missing decisions and ask for ratification first.

## 2. Survey the codebase

Locate every LLM surface, not only obvious instruction files. Search for model SDK and API calls, agent entry points, RAG or retrieval pipelines, tool definitions, structured-output parsers, instruction and template files, Model Config identity and settings, and fallbacks. For each surface, record:

- the user-visible job, owner, entry point, and execution flow;
- its instruction set or candidate seed, using the instructions CLI command surface when it is already registered;
- Model Config identity and settings, tools, retrieval dependencies, output contracts, and safety boundaries;
- observed failure reports and other evidence, clearly separated from hypotheses;
- existing evals, tests, judges, golden labels, and deployment or monitoring gates;
- where Orizu could add measurement leverage and where it would add no value.

Do not collapse multiple surfaces into one optimization target. Call out repeated infrastructure and dependencies, but keep each surface's failures and evidence attributable.

## 3. Inventory candidate data sources

Build a source inventory from code and integration metadata without accessing the underlying records. Include unavailable sources and explain the gap; absence is a planning fact, not permission to substitute synthetic data silently.

| Candidate source | What to establish without opening records | Decision to bring to the user |
|---|---|---|
| Production logs | Owning system, retention window, schema, volume, sampling hooks, redaction boundary | Whether access is allowed and which representative sampling policy is acceptable |
| Observability providers | Wired provider and project, trace shape, feedback or score fields, export boundary | Whether this provider is authoritative and which fields may leave it |
| User-behavior signals | Feedback controls, retries, abandonments, escalations, edits, or downstream outcomes | Which signals mean success or failure and how selection bias will be handled |
| Existing golden datasets | Location, provenance, scenario coverage, label meaning, freshness, and split history | Whether the labels remain trusted ground truth or need human spot-checking |

Also note synthetic generation as a possible gap-filler, never as an automatic replacement for missing real evidence. Record privacy, security, consent, residency, retention, and identifier-handling constraints for every candidate source.

## 4. Surface the judgment calls

Convert survey gaps into an explicit decision ledger. The human owns these calls; evidence may support a recommendation, but the agent does not decide by omission. At minimum, surface:

- the user outcome, baseline, success measure, acceptable regressions, and priority order;
- the observed failure modes and scenario class boundaries worth measuring first;
- the data-source decision, including access, sampling, privacy, retention, and whether synthetic cases may fill a named gap;
- whether existing labels are trusted ground truth, whether humans must annotate, and who can make that judgment;
- the judge type for each failure mode and the judge trust bar appropriate to the decision it will power;
- the customer-facing instruction set, model-config profile, components, and other code that are in or out of the optimization target;
- Final-held-out validation, per-scenario regression limits, cost and latency limits, rollback evidence, and who owns the promotion decision.

Mark each item **decided**, **proposed**, or **open**, with its evidence and owner. Never convert a default, convention, inferred preference, or agent recommendation into a user decision.

## 5. Run the guided conversation

Use a pointed, grilling-style conversation to resolve the ledger, not a generic intake questionnaire:

1. Present the codebase assessment first: observed facts, hypotheses, gaps, Orizu opportunities, and the decisions they create.
2. Ask the highest-leverage open question in context. Explain why it matters, give concrete options and tradeoffs when useful, and state a recommendation separately from the decision.
3. Probe vague goals. Ask what observable outcome would disprove success, which scenario class matters first, and what regression would block shipping.
4. Challenge contradictions and hidden assumptions respectfully. For example, a source cannot be both unavailable and the required ground truth; a judge cannot gate promotion before its trust bar is agreed and validated.
5. Reflect the answer into the ledger and confirm the consequence. Then take the next open decision.

Never answer your own questions, infer approval from silence, or bury a choice in implementation detail. If the repository or supplied context already records an answer, use it and cite it; do not re-ask the user unless the records conflict or the decision is explicitly stale.

After the ledger is resolved, present the complete plan and ask the user to revise, reject, or explicitly ratify it. “Looks plausible,” lack of objection, and approval of one source are not plan ratification. Change the plan from **Proposed** to **Ratified** only when the user explicitly ratifies the complete plan.

## 6. Write `improvement-plan.md`

Write a specific plan that another agent can execute without reconstructing the conversation. Use this outline, adapting detail rather than deleting unresolved decisions:

1. **Status and ratification** — Proposed or Ratified; Orizu `team/project`; ratifier, date, and the user statement or recorded decision that constitutes approval.
2. **Desired outcome and success measures** — user-visible goal, current evidence, target measures, constraints, and non-goals.
3. **Codebase assessment** — every LLM surface, its entry point and flow, instruction set or seed, Model Config, dependencies, owner, existing evals, and Orizu opportunity.
4. **Failure modes and scenario classes** — observed evidence, priority, coverage boundary, and explicit hypotheses that still need data.
5. **Source inventory and data-source decision** — all candidate sources, the chosen sources and rejected alternatives, access owner, sampling, privacy, retention, redaction, and spot-check plan.
6. **Ground truth and annotation** — trusted golden labels or human labeling path, decision owner, and how label quality will be checked.
7. **Judge plan and trust bars** — code assertion or LLM judge per failure mode, validation evidence required, and the user-owned judge trust bar for each downstream decision.
8. **Instruction set and optimization target** — target profile and complete component map, other code in scope, exclusions, and the held-constant environment.
9. **Final-held-out validation and promotion decision** — split strategy, scenario-class measures, regression limits, cost and latency bounds, ship/rollback evidence, and the human promotion owner.
10. **Phased work and handoffs** — ordered dataset, annotation, judge, optimization, and report work with human gates before irreversible or production-impacting actions.
11. **Open decisions** — owner, evidence needed, and why each item blocks ratification or a later phase.

Do not disguise open decisions as assumptions. If any ratification-blocking item remains, keep the status Proposed and continue the conversation. Once the user ratifies, update the status and ratification record, remove resolved items from Open decisions, and write `improvement-plan.md` to the canonical path below. Complete its required memory update and commit before accessing any approved data source.

## 7. Persist only what Orizu supports today

The plan artifact is always named `improvement-plan.md`; its canonical path depends on the workspace:

- **Orizu workbench:** resolve the selected project's `directorySlug` through the same per-project manifest that locates `projects/<directorySlug>/memory.md`: find the `projects/<directorySlug>/orizu.project.json` whose project identity matches the resolved Orizu `team/project`, then use that containing directory. Write `projects/<directorySlug>/improvement-plan.md`. Add a concise decision summary and relative plan link to the sibling `memory.md`; do not duplicate the whole plan there.
- **Plain repository:** write `improvement-plan.md` at the repository root and record the resolved Orizu `team/project` inside it.

If the matching `projects/<directorySlug>/orizu.project.json` is absent, or a resolved project directory lacks its sibling `memory.md` or any required primitive directory, do not guess the directory slug or create missing entries by hand.
With existing authenticated CLI credentials, run `orizu setup --team <teamSlug> --project <projectSlug> --non-interactive --verbose` from the workbench root; the current directory is the default workspace.
Authenticated setup reconciles each required project path independently: it creates missing files and directories while preserving existing ones.
Empty project directories are not committed and must be recreated after a fresh clone.
This per-path seeding does not require `--fix`. Use a separate `orizu setup --team <teamSlug> --fix --non-interactive --verbose` run only when independently diagnosed ADR-004 case or pointer damage also needs repair.
Verbose output shows the actions.
When setup completes, re-resolve `orizu.project.json` and continue only from the directory whose manifest identity matches the resolved Orizu project.
If the manifest is still absent, another required entry remains missing, or setup reports an authentication or repair error, stop and ask the user to repair the workbench instead of writing the plan to a guessed path.
Setup repairs the local checkout only: it does not commit or push.
Track newly materialized project-stub files and commit them together with the plan and memory pointer.

The repo is truth for the plan contents. In a workbench, both `projects/<directorySlug>/improvement-plan.md` and its sibling `memory.md` pointer must be tracked and committed together. In a plain repository, the root plan must be tracked and committed. These commits make the ratified plan durable and keep later work in the approved project.

There is no dedicated CLI command for uploading an improvement plan or arbitrary project context. The generic `orizu workspace apply <path>` command can promote a registered repo-owned resource such as project `memory.md`; it does not make the plan a DB-native artifact or introduce a plan-specific storage format. Richer structured persistence is arriving through the **J2 — Assess & plan** project; until it ships in the installed CLI, use only the Git-backed files above.

## Exit criterion

J2 is complete only when the user has explicitly ratified the complete plan and `improvement-plan.md` records that ratification and the resolved Orizu project. The canonical plan must be tracked and committed; in a workbench, its sibling `memory.md` pointer must be tracked and committed together with it. Otherwise remain in assess-and-plan; do not start dataset work.
