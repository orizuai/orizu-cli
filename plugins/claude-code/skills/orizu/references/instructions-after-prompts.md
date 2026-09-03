# Instructions After Prompts

Use instruction sets for customer-owned model instructions. The older prompt
read surface remains available for locating legacy artifacts, but standalone
prompt content and production mutations deliberately redirect to `orizu
instructions`.

## Find Existing Material

Legacy prompts appear as one-component sets in the instruction inventory:

```bash
orizu instructions list --project <team/project> --status all --json
orizu instructions show <slug-or-exact-name> --project <team/project> --status all --json
```

Use prompt reads only when you need to correlate an old prompt identifier or
download its files:

```bash
orizu prompts list --project <team/project> --status all
orizu prompts pull <prompt-id-or-name> --project <team/project> --out ./legacy-prompt
```

The text output ends with the owning instruction set's stable slug and
component key. List and pull include the prompt display name and identifier:

```text
Owner: Generator (prompt-1) -> planner-agent / system
```

Use the slug after `->` for instruction commands and the final segment for the
component key. Address scorer bindings directly with that instruction-set slug
and component key. An ownerless judge or draft prompt may have no owner line.

## Understand Deliberate Refusals

Standalone prompt content, production-pointer mutations, and prompt-addressed
scorer bindings fail before making a request. The CLI prints these exact
replacements:

- `Use: orizu instructions push <manifest> --project <team/project>`
- `Use: orizu instructions archive <slug-or-exact-name> --project <team/project>`
- `Use: orizu instructions restore <slug-or-exact-name> --project <team/project>`
- `Use: orizu instructions profiles promote <set> --project <team/project> --model-config <identity> --version <n>`
- `Use: orizu instructions scorers set-headline <set> --key <component-key> --scorer-version <id> --project <team/project>`
- `Use: orizu instructions scorers add <set> --key <component-key> --scorer-version <id> --project <team/project>`

Older clients and direct API callers can reach two additional server-side
prompt-write conflicts. Both fail closed with an exact JSON error:

| Write path | Conflict | Measured response | Next action |
| --- | --- | --- | --- |
| Sessionless prompt registration from an older client or direct API call | The name has set-owned storage and no ownerless lineage. | 409 — `Use: orizu instructions push; prompt name belongs to an instruction set` | Use the owning set's manifest through `orizu instructions`; the current CLI redirects before HTTP. |
| Session-scoped prompt draft (`prompts push ... --session ...`) | The name belongs to components in more than one instruction set and has no ownerless lineage. | 409 — `session draft prompt name is ambiguous across instruction sets` | Do not guess by name. Inventory the sets and component keys, then prepare the intended instruction-set manifest. |

These client redirects and server conflicts do not apply to prompt reads, judge
artifacts, prompt reports, instruction-addressed scorer bindings, unambiguous
session-scoped drafts, or non-production prompt labels.

## Agent preparation

From a hosted session, inventory every active and archived set, choose a stable
target name, component keys, model-config profiles, and complete component
text, then prepare a manifest such as:

```json
{
  "name": "planner-agent",
  "description": "Instructions used by the planner agent.",
  "shape": ["system", "tools"],
  "components": [
    { "key": "system", "path": "./system.md" },
    { "key": "tools", "path": "./tools.md" }
  ]
}
```

Commit the complete manifest and its component files, then follow the
[Authority map](authority-map.md) for each mutation.

## Consolidation

Consolidation changes ownership and visibility. Create the consolidated set
through the surface selected by the [Authority map](authority-map.md) and inspect its complete
profiles before changing any pointer:

```bash
orizu instructions create ./orizu.instruction-set.json --project <team/project> --model-config <identity> --json
orizu instructions show <slug-or-exact-name> --project <team/project> --status all --json
```

After verifying the new set, archive each redundant one-component
set. Archive changes visibility only; the archived set still resolves and
syncs until the pointer move is complete, so it remains a recovery
source.

```bash
orizu instructions archive <slug-or-exact-name> --project <team/project> --json
```

Promote the named model-config Profile first, then move the consolidated set's
Default Profile through the Authority map:

```bash
orizu instructions profiles promote <set> --project <team/project> --model-config <identity> --version <n> --json
orizu instructions default move <set> --project <team/project> --model-config <identity> --json
```

Confirm the resolved default and every production profile after the move. If a
redundant set must become visible again, restore it through the Authority map:

```bash
orizu instructions restore <slug-or-exact-name> --project <team/project> --json
```
