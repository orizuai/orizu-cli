# Migrate a hand-rolled instruction layout

Use this guide when an application already vendors instruction snapshots and has its own hashes JSON, verify script, generated index, or loader. The goal is **content identity**, not preservation of the bespoke wrapper: Component bytes, per-Component hashes, and `profileVersionId` remain identical when the source Profile Version is the same; Orizu replaces the wrapper in one reviewable diff.

Read [Orizu in your codebase](orizu-in-your-codebase.md) for Pointer, ownership, verification, and runtime rules. Confirm all commands against the [public CLI reference](https://orizu.ai/docs/references/cli-reference). `--out` is the app root that contains `orizu/`, not the `orizu/` directory: `<app-root>/orizu/` is the paved tree, so from a monorepo root `--out apps/http-gateway` writes `apps/http-gateway/orizu/`. `--project` is `<team-slug>/<project-slug>`, exactly the value recorded in the Lock's `project` field.

## 1. Map the old tree to the paved tree

| Hand-rolled concern | Paved-path destination |
| --- | --- |
| Snapshot directory | `<out>/orizu/instruction-sets/<set>/<profile-slug>/vN/components/*.prompt.md` |
| Provider/model directory such as `openai-gpt-5.6` | Profile identity `openai/gpt-5.6`, mapped to filesystem slug `openai__gpt-5.6` |
| Hashes JSON | Per-Component hashes in `orizu/orizu.lock.json`; do not copy the old JSON over the new Lock |
| Bespoke Version metadata | Machine-owned `vN/manifest.json` |
| String-object module | Machine-owned `vN/components.generated.ts` |
| Version registry/index | Machine-owned `orizu/generated/index.ts` |
| Verify script | `orizu instructions verify --out .` and `helpers/verify.ts` |
| Loader | `helpers/load.ts` |
| Helper self-checks | `helpers/load.selfcheck.ts`, `helpers/provenance.selfcheck.ts`, and `helpers/verify.selfcheck.ts`, exporting `runLoadSelfCheck()`, `runProvenanceSelfCheck()`, and `runVerifySelfCheck()` |

The paved Version manifest exports frozen `settings`. Provider and model are represented by the Profile's Model Config identity. Use the identity exactly as Orizu reports it—suffixes such as `-luna` are significant. Find it with `orizu instructions show <set> --project <team/project>` and read `modelConfigIdentity`; an old manifest may call the equivalent field `model.configIdentity`. Bespoke fields such as `model.provider`, `model.protocol`, and `model.strictJsonSchema` are **not exported yet**; a hydrated model-config object is coming in separate follow-up work. Customer-only identifiers such as an internal model ID have no Orizu mapping and stay in customer code if still needed.

A paved `manifest.json` contains this shape (IDs and hashes abbreviated):

```json
{
  "manifestVersion": 1,
  "instructionSetId": "<uuid>",
  "instructionSetName": "Planner",
  "instructionSetSlug": "planner",
  "profileVersionId": "<uuid>",
  "modelConfigIdentity": "openai/gpt-5.6-luna",
  "profileSlug": "openai__gpt-5.6-luna",
  "versionNumber": 2,
  "components": { "system": "sha256:<hex>" },
  "digest": "sha256:<hex>",
  "settings": { "model": "gpt-5.6", "reasoning_effort": "medium" },
  "provenance": {
    "instructionSetId": "<uuid>",
    "profileVersionId": "<uuid>",
    "digest": "sha256:<hex>"
  }
}
```

The old bespoke `project`, `optimizationRunId`, `runnerVersionId`, `model.protocol`, `model.strictJsonSchema`, and customer-specific model ID fields do not map to this file. The optional paved `sourceProvenance` is server-provided lineage, not a copy of those fields.

## 2. Do not repair an incompatible pre-CLI Lock

A canonical Lock round-trips byte for byte:

```ts
serializeLock(parseLock(text)) === text
```

“Conforming” means both that the serializer round-trip succeeds **and** that every Profile uses the paved slug form. Although such a hand-written Lock can be adopted, the normal migration lets first sync produce it and discourages hand-repair. In practice, early hand-rolled Locks often use a hyphenated Profile key such as `openai-gpt-5.6`; the paved slug is `openai__gpt-5.6`. Such a Lock is refused as `lock_default_slug_invalid`. Do not edit machine-owned identity fields into shape and do not add a lock-repair script.

This guide covers only a hand-rolled layout: the customer's own Lock or hashes file, wherever it lives, and whatever snapshot directories, loader, and verifier its tooling created. An incompatible paved-shaped Lock may fail with `lock_default_slug_invalid`; do not repair its machine-owned fields. Read every deployed or referenced Version from that customer-owned metadata and convert its address to a canonical Specifier—for example, `planner/openai-gpt-5.6-luna@v1` becomes `planner/openai/gpt-5.6-luna@v1`.

If your tree came from the retired `orizu instruction-sets sync`, it lives at `<out>/<set-slug>/`; `sync` refuses to write over it (`instruction_set_sync_legacy_layout`), so move each such set directory outside `<out>` first. Its hash and pinned-component formats are not covered here.

## 3. Prove content identity on a branch

Follow this manual procedure; do not turn it into an unattended migration script. Replace the sample project, output root, Set, Profile, Version, and backup paths with the customer's values. Run one command at a time and check its outcome before continuing.

1. Check the worktree before touching the old tree:

   ```bash
   git status --short
   ```

   It must print nothing. Never do the first conversion on a deploy branch.

2. Create a migration branch:

   ```bash
   git switch -c orizu-paved-path
   ```

   The new branch must be checked out before conversion work starts.

Now inventory every old-tree path that the conversion will delete, plus every deployed or referenced Version and its canonical `set/profile@vN` Specifier. For each one, note its old Profile Version id wherever the customer's tool recorded it. If that metadata has no Profile Version id, take it from `orizu instructions show <set> --project <team/project> --json`; the selected Version in its JSON output has `profileVersionId`. Move `<app-root>/orizu` to a directory outside the repository and keep it until the migration branch is merged; if any step fails, remove the partial `<app-root>/orizu` tree first, then move the backup back, then revert `.gitattributes`.

3. For each affected Set, inspect the authoritative Profile identities:

   ```bash
   orizu instructions show planner --project core/evals --json
   ```

   Confirm every canonical Profile identity before syncing it.

4. Exact-sync each deployed or referenced Version, running this command separately for every retained Specifier:

   ```bash
   orizu instructions sync planner/openai/gpt-5.6@v2 --project core/evals --out <app-root>
   ```

   Each command must succeed and create the paved Version named by that exact Specifier. Exact sync does not populate Production.

5. Verify the replacement tree:

   ```bash
   orizu instructions verify --out <app-root>
   ```

   It must exit 0.

6. Compare Component files for each old/new Version pair:

   ```bash
   git diff --no-index /tmp/orizu-backup/orizu/instruction-sets/planner/openai-gpt-5.6/v2/components/ <app-root>/orizu/instruction-sets/planner/openai__gpt-5.6/v2/components/
   ```

   It must print no diff and exit 0. For a paved-shaped hand-rolled tree, the old side is `<backup>/instruction-sets/<set>/…`; for any other hand-rolled shape, use wherever your layout kept the Component files. If the old tree used `<key>.md`, rename only the external backup's comparison copy to `<key>.prompt.md`, or compare each corresponding file separately. Also compare each old Component hash with the new Lock entry. Compare the old Profile Version id noted before the move with the paved manifest's `profileVersionId`; every value must match. Stop on the first mismatch.

Before committing, replace the bespoke verify script and CI wiring with `orizu instructions verify --out <app-root>`. Remove old byte/hash/layout checks only after that paved check is green; retain checks for metadata Orizu does not export. Also migrate every import and call of the bespoke loader to `orizu/helpers/load.ts`, wire the three Helper self-check functions into customer tests, and run the customer's build and tests. Retain a compatibility adapter until all consumers move if they cannot be changed atomically.

7. Inspect the complete conversion, including verifier and loader consumers:

   ```bash
   git status --short
   ```

   It must show the expected replacement files, consumer changes, managed attributes, and every inventoried old-tree deletion.

8. Stage the new tree, attributes, consumer changes, and every old-tree path inventoried before the move; replace the sample old paths with the real ones:

   ```bash
   git add -- <app-root>/orizu <app-root>/.gitattributes path/to/consumer-code path/to/old-snapshots path/to/old-lock-or-hashes path/to/old-loader path/to/old-verifier
   ```

   Review the staged diff and confirm it contains every deletion before continuing.

9. Commit the complete, working conversion as the final step of this section:

   ```bash
   git commit -m "Adopt Orizu paved instruction layout"
   ```

   Keep the external backup after the commit.

The first `git status --short` is **not empty**. It reports deletion or relocation of the customer's old wrapper and additions under these paths (with one Component row per key):

```text
?? .gitattributes
?? orizu/orizu.lock.json
?? <out>/orizu/instruction-sets/<set>/<profile-slug>/vN/manifest.json
?? <out>/orizu/instruction-sets/<set>/<profile-slug>/vN/components/<name>.prompt.md
?? <out>/orizu/instruction-sets/<set>/<profile-slug>/vN/components.generated.ts
?? orizu/generated/index.ts
?? orizu/helpers/load.ts
?? orizu/helpers/load.selfcheck.ts
?? orizu/helpers/provenance.ts
?? orizu/helpers/provenance.selfcheck.ts
?? orizu/helpers/verify.ts
?? orizu/helpers/verify.selfcheck.ts
```

If `.gitattributes` already exists it is modified rather than added. `sync` appends only the managed lines that are not already present. If the existing file lacks a trailing newline, sync first writes one separating newline, then the missing managed lines:

```gitattributes
orizu/** -text
orizu/generated/** linguist-generated=true
```

These lines prevent Git from normalizing CRLF or missing-final-newline Component bytes and mark the generated index. First sync legitimately changes Profile directory slug, manifest fields, digest formula, generated modules, Helpers, the Lock `helpers` map, and `syncedAt`. Those wrapper differences are expected.

The Lock's `helpers` map contains pristine byte fingerprints for exactly six vendored Helpers—load, provenance, verify, and their three self-checks. `verify` group 4 checks that every fingerprinted Helper exists and reports customer edits as warnings.

The no-op proof has three independent checks:

1. `git diff --no-index` is empty for every `components/*.prompt.md`, including whitespace and line endings. Directory comparison pairs by filename; if the bespoke tree used `<key>.md`, rename its comparison copy to `<key>.prompt.md` first or compare each old/new Component file explicitly.
2. Compare the metadata source for the applicable starting point with the new Lock and paved manifest: each Component hash and `profileVersionId` is identical. Do **not** require the whole-Version digest to match; older layouts may have used a different digest formula.
3. After committing the conversion, the second identical `sync` leaves `git status --short` empty and `git diff --exit-code` exits 0. In particular, it preserves `syncedAt`.

A prefix pair such as `system` and `system-extra`, CRLF text, and a Component without a trailing newline require no exceptions: comparison remains byte-for-byte.

### Choose exact or Pointer-form runtime loading

The migration's exact `set/profile@vN` sync deliberately leaves that Profile's Production value `null` in the new Lock; exact sync never resolves or writes Production. Choose one valid runtime path:

- Keep customer call sites on the exact `set/profile@vN` Specifier. It loads the synced Version whether Production is set or unset.
- To use the Profile-qualified pointer `loadInstructions('planner/openai/gpt-5.6')`, first have a human set that Profile's Production in Orizu, then fill its Lock Pointer with a scoped Profile-form sync:

```bash
orizu instructions sync planner/openai/gpt-5.6 \
  --project core/evals \
  --out <app-root>
```

A Lock-wide `update` is an alternative only after **every** recorded Profile has Production set; otherwise one unresolved Profile refuses the whole update. A bare `loadInstructions('planner')` additionally selects the set's Default Profile. `sync` preserves the Lock's set-level Default. If a human moves Default in Orizu after a multi-Profile migration, first confirm every recorded Profile has Production set, then run `orizu instructions update --out <app-root>` to re-resolve the Set's Default and Pointers; a Profile-form sync will not change the bare-Set selection. If retaining the existing Default, sync that Default Profile and its Production before using the bare Set. A missing selected Profile fails as unknown, while an unfilled selected Production refuses with `instruction_set_pointer_unresolved:production`; neither case falls back.

## 4. Prove post-commit idempotency

Run one command at a time after §3's commit:

1. Repeat each retained exact sync separately:

   ```bash
   orizu instructions sync planner/openai/gpt-5.6@v2 --project core/evals --out <app-root>
   ```

2. Require the worktree report to print nothing; if not, stop and report:

   ```bash
   git status --short
   ```

3. Require the tracked-diff check to exit 0; if not, stop and report:

   ```bash
   git diff --exit-code
   ```

4. Require offline verification to exit 0:

   ```bash
   orizu instructions verify --out <app-root>
   ```

The repeat sync preserves `syncedAt`. `verify` is offline, needs no credentials, exits 1 for any failure, and exits 0 when findings are warnings only. Its four output groups cover:

1. Version manifests against the Lock;
2. exact Component bytes plus `components.generated.ts`;
3. bytes returned through `loadInstructions()` and `verifyIntegrity()`;
4. Pointer, folder, static import-map, and Helper consistency.

Use the same boundary in CI:

```yaml
- name: Verify synced Orizu instructions
  env:
    APP_ROOT: apps/http-gateway
  run: npx orizu instructions verify --out "$APP_ROOT"
```

## 5. Loader contract used before commit

Complete this replacement before §3 step 9. Import `loadInstructions()` from `orizu/helpers/load.ts`. It resolves only the generated map and Lock embedded at sync time, returns Components, settings, and Provenance atomically, and never calls Orizu. Registries, deployment-key adapters, and model-call assembly outside `orizu/` remain customer-owned. Before deleting the old loader, grep the repository for imports and calls of its exported functions, then migrate every call site to the vendored Helper.

The `*.selfcheck.ts` files deliberately export plain functions without test-runner globals. Call `runLoadSelfCheck()`, `runProvenanceSelfCheck()`, and `runVerifySelfCheck()` from ordinary Bun, Vitest, or another customer-owned test wrapper. This proves the production-default Helper wiring rather than a copied fake.

If the repository uses Orizu's **earlier shipped loader**, remove it: only that earlier Orizu loader throws `instruction_set_legacy_loader_retired` when it sees a paved tree. An arbitrary hand-written loader does not emit that code; replace it with the vendored `helpers/load.ts` after migrating its consuming call sites.

## 6. Roll back or handle a refusal

The migration branch is discardable, and `sync` never deletes the external backup. Keep that backup until the conversion is reviewed and deployed. On failure, remove the partial `<app-root>/orizu` tree, move the backup back to its original path, and revert `.gitattributes`.

If sync reports `instruction_set_sync_legacy_layout`, this hand-rolled guide does not cover that source format. Follow §2: move each detected `<out>/<set-slug>/` directory outside `<out>` before retrying, and do not use this guide to interpret its hashes or pinned Components.
