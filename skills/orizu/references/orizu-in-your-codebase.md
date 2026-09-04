# Orizu in your codebase

Orizu is the authoring plane for instruction sets. Your repository is the deployment plane. Treat a synced instruction set like a vendored dependency: select an immutable version, commit its readable bytes and metadata, review the diff, verify it in CI, and load it without contacting Orizu at runtime.

The canonical command surface is in the [public CLI reference](https://orizu.ai/docs/references/cli-reference). For an existing bespoke snapshot/hashes/loader arrangement, use [Migrate a hand-rolled instruction layout](migrate-hand-rolled-instruction-layout.md).

## Mental model

| Dependency concept | Orizu equivalent |
| --- | --- |
| Package | Instruction Set |
| Build for one runtime | Profile for one Model Config |
| Immutable release | Profile Version |
| Floating release pointer | Default or Production Pointer |
| Vendored source | `components/*.prompt.md` |
| Lockfile | `orizu/orizu.lock.json` |
| Install/integrity check | `instructions sync` / `instructions verify` |

A fixed Component shape spans all Profiles in one Instruction Set. Each Profile contains the complete Components for one provider-qualified Model Config, such as `openai/gpt-5.6`, and has an immutable Version lineage. The set-level Default names a **Profile**. Each Profile's Production names a **Version**. Versions include their frozen settings and are used atomically.

An Instruction Set's `description` is unversioned authoring metadata shown by `instructions show` and `instructions list`. It is deliberately absent from Version manifests, generated modules, and the Lock.

## Specifiers and pointers

Use the Model Config identity exactly as Orizu shows it; every suffix is part of the identity, so `-luna` in `openai/gpt-5.6-luna` is significant. Find it with:

```bash
orizu instructions show planner --project core/evals --json
```

Read the Profile's `modelConfigIdentity`; during migration, the equivalent old field may be `model.configIdentity`. The slash is part of the Profile identity. `--project` is `<team-slug>/<project-slug>` and is the same string recorded in the Lock's `project` field.

| Specifier | Meaning at `sync` |
| --- | --- |
| `set` | the set's Default Profile, then that Profile's Production Version |
| `set/profile` | that Profile's Production Version |
| `set/profile@vN` | exactly Version `vN` of that Profile |

For example, `planner/openai/gpt-5.6@v3` is exact. Its filesystem Profile slug is `openai__gpt-5.6`.

ADR-030's Pointer rules are intentionally strict:

1. The pointer forms `set` and `set/profile` read Production during `sync`; `update` re-resolves Pointers Lock-wide and does not accept a Specifier. Resolved values are written into the Lock.
2. Exact `set/profile@vN` sync never resolves or writes Production. It is allowed whether Production is set or unset, and the exact Version remains loadable by its exact Specifier.
3. Runtime reads the Lock and never contacts Orizu or re-resolves a Pointer. A promotion changes no repository until a later pointer-form `sync` fills a null Pointer or `update` is reviewed and committed.
4. When `set` or `set/profile` must resolve an unset Production, resolution is a hard error and never falls back to Default, another Profile, latest, or an unpromoted Version.

For a pointer-form sync, the exact refusal is:

```text
instruction_set_sync_production_unset: run orizu instructions profiles promote planner --model-config openai/gpt-5.6 --version <n>
```

An already-synced unresolved Pointer fails in the Helper with `instruction_set_pointer_unresolved:production`.

## Lifecycle commands

```bash
orizu instructions sync planner/openai/gpt-5.6@v3 \
  --project core/evals \
  --out . --target ts
orizu instructions verify --out .
orizu instructions update --project core/evals --out . --yes
orizu instructions prune --out . --keep planner/openai/gpt-5.6@v2 --yes
```

| Verb | Contract |
| --- | --- |
| `sync` | Materializes one Specifier and is idempotent. Pointer forms record resolved Pointers; exact `@vN` does not write Production. `--out` selects the app root; `--target ts` is the default and only target. `--force-helpers` deliberately overwrites edited Helpers. |
| `verify` | Runs four offline verification groups and exits non-zero on a failure; warnings alone exit zero. |
| `update` | The only verb that re-resolves Pointers already recorded in the Lock, across the whole Lock. It always fetches current Pointer state and prints a plan; it changes nothing without `--yes`. `--no-sync` still fetches Pointers but skips materializing absent Versions. |
| `prune` | Verifies first, retains Production, reserved Lock Pins, and every repeatable `--keep`, then prints a plan. It deletes nothing without `--yes`; today, use `--keep <set/profile@vN>` once per retained Version. |

To inspect a prune plan without deleting anything:

```bash
orizu instructions prune --out . # plan only
```

## Emitted layout and ownership

One app owns one output root. `--out` names the **app root that contains `orizu/`**, not the `orizu/` directory itself. From a monorepo root, for example, use `--out apps/http-gateway` to write `apps/http-gateway/orizu/`. A monorepo may have a separate tree per app.

| Path under `<out>` | Owner and review rule |
| --- | --- |
| `orizu/orizu.lock.json` | Machine-owned. `pins` is reserved for future tooling and must not be hand-edited because the generated index embeds the Lock. |
| `<out>/orizu/instruction-sets/<set>/<profile-slug>/vN/components/*.prompt.md` | Orizu-owned exact API bytes; humans review them in place. |
| `<out>/orizu/instruction-sets/<set>/<profile-slug>/vN/manifest.json` | Machine-owned Version manifest. Settings live here, not in the Lock. |
| `<out>/orizu/instruction-sets/<set>/<profile-slug>/vN/components.generated.ts` | Machine-owned generated runtime module. |
| `orizu/generated/index.ts` | Machine-owned static import map; the only file that imports Version modules. |
| `orizu/helpers/load.ts` | Customer-editable, fingerprinted vendored Helper. |
| `orizu/helpers/load.selfcheck.ts` | Customer-editable, fingerprinted self-check exporting `runLoadSelfCheck()`. |
| `orizu/helpers/provenance.ts` | Customer-editable, fingerprinted provenance Helper. |
| `orizu/helpers/provenance.selfcheck.ts` | Customer-editable, fingerprinted self-check exporting `runProvenanceSelfCheck()`. |
| `orizu/helpers/verify.ts` | Customer-editable, fingerprinted integrity Helper. |
| `orizu/helpers/verify.selfcheck.ts` | Customer-editable, fingerprinted self-check exporting `runVerifySelfCheck()`. |
| `.gitattributes` | Machine-managed, append-only lines protecting exact bytes and marking generated output. |

The managed attribute lines are:

```gitattributes
orizu/** -text
orizu/generated/** linguist-generated=true
```

There are exactly six vendored Helpers: load, provenance, and verify, each with one matching self-check. The Lock's `helpers` map stores the pristine byte fingerprint of all six; `verify` group 4 checks those paths and fingerprints.

`sync` refreshes a pristine Helper. If its bytes differ from both its recorded fingerprint and the current template, `sync` preserves it and warns. Use `--force-helpers` only after reviewing the replacement.

## Three trust boundaries

### 1. Orizu to repository: sync

`sync` binds the response to the requested Specifier and any immutable Version already recorded in the Lock. It computes hashes over the exact served Component bytes and writes those facts into the Version manifest and Lock. There is no second server-supplied content hash; review remains the trust boundary for a deliberate coordinated repository edit.

### 2. Repository to CI: offline verify

```bash
orizu instructions verify --out .
```

The four groups check: Version manifests against the Lock; exact Component and generated-module bytes; bytes returned through the vendored loader and verifier; and Pointer, folder, import-map, and Helper consistency. A missing or changed Component is a failure. `verify` reports `helper_modified` as a warning only when the Lock already fingerprints that Helper. If first sync preserves a pre-existing edited Helper, sync warns but cannot record a pristine fingerprint; `verify` then fails with `helper_fingerprint_missing`. A missing fingerprinted Helper is also a failure.

A GitHub Actions step is enough:

```yaml
- name: Verify synced Orizu instructions
  run: npx orizu instructions verify --out .
```

### 3. Repository to runtime bytes: `verifyIntegrity`

A bundler can transform content while disk hashes remain valid. Verify the loaded bytes, not a directory. `settings` is required, including `{}`, and the digest must be the one selected by Provenance:

```ts
import { lock } from './orizu/generated/index.js'
import { loadInstructions } from './orizu/helpers/load.js'
import { verifyIntegrity } from './orizu/helpers/verify.js'

const loaded = loadInstructions('planner/openai/gpt-5.6@v3')
verifyIntegrity({
  components: loaded.components,
  settings: loaded.settings,
  provenance: loaded.provenance,
  generatedProvenance: loaded.generatedProvenance,
  digest: loaded.provenance.digest,
}, lock)
```

A digest belonging to a different locked Version fails with `instruction_set_integrity_digest_unselected`; a digest absent from the Lock fails with `instruction_set_integrity_digest_unknown`.

## Runtime rules

- **Load atomically.** Components, settings, and Provenance are one tested Synced version. Never combine pieces from different Versions.
- **Fail closed to a whole fallback.** Choose a complete, explicit fallback deployment before constructing messages. Do not interpret an unresolved Orizu Pointer as fallback permission.
- **Keep rollout policy in customer code.** Feature flags and cohorts select explicit `set/profile@vN` Specifiers. The Lock's `pins` field is reserved and never hand-edited: the generated index embeds the Lock, so an isolated edit causes `generated_module_drift`. When pruning today, pass repeatable `--keep <set/profile@vN>` for every cohort or fallback Version.
- **Keep consuming seams outside `orizu/`.** Registries, deployment-key adapters, and model-call assembly remain customer-owned code. When replacing an old integration, grep for imports and calls of its loader functions before deleting them, then route those call sites through `helpers/load.ts`.
- **Attach Provenance to every model call.** Record `orizu.instruction_set.id`, `orizu.profile_version.id`, and `orizu.instruction_set.digest`. See the [public CLI reference](https://orizu.ai/docs/references/cli-reference) for read-back commands.

## Shipping a new Version

1. A human reviews evidence and promotes a Profile Version in Orizu.
2. Run exact `sync`, or run `update` to propose changed recorded Pointers.
3. Review the Component and generated-artifact diff; run `verify` in CI.
4. Register an explicit `@vN` deployment in customer code before exposing a cohort; retain it during every prune with `--keep <set/profile@vN>`.
5. Deploy both candidate and whole fallback, then move the customer's flag.
6. When a Version is no longer referenced, review a `prune` plan and apply it with `--yes`.

## Design FAQ

### Why fully materialize every Version?

Reviewability beats deduplication. A reviewer sees the effective prompt without mentally merging inheritance layers, and runtime has no merge behavior to get wrong.

### Why vendored Helpers?

Runtime remains self-contained and does not acquire an Orizu library dependency. The Helpers are local and editable; fingerprints let `sync` preserve customer changes rather than silently overwrite them.

### Why not follow Production live?

A movable control-plane Pointer must not change deployed behavior without a repository diff. `update` makes movement explicit and reviewable.

### May I edit a synced Component directly?

Not as a durable authoring path. `verify` correctly treats that as drift. Make the change in Orizu, approve a new immutable Version, and sync it so authoring history, eval evidence, and deployed bytes remain connected.

### Can apps in one monorepo use different Versions?

Yes. Give each app its own output root and Lock; each app then reviews, verifies, and traces exactly what it ships.
