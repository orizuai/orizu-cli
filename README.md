# Orizu CLI

## What is Orizu

Orizu is a platform that helps you build continually learning agents and other LLM applications. It does so in a scientific, measurable manner by first helping you build evals and then helping you hill climb on them.

## How Orizu works

There are 3 key pillars to Orizu:
1. **Human evaluation:** We consider human evaluation to be the gold standard, particularly when the humans involved are people with deep context and understanding of the output being evaluated. This is often the cross-functional team behind a product (product managers, engineers, designers, content writers, researchers, etc) or external experts (lawyers, engineers, writers, etc). Any good evaluation system relies on the presence of such high quality judgment to compare to. We provide tools that simplify the process of collecting the feedback from this audience.
2. **Auto evaluation:** Ultimately, human experts can only review so much. As your data scales, you need to encode their knowledge, their opinions, their taste and judgment into auto-evaluations. We automate this for you using the data we help you collect above.
3. **Optimization:** We turn your evals into an asset for you by building an automated hill-climbing workflow. We've started with prompt optimization because multiple studies and our own experience with our customers has shown strong measurable lifts with even relatively small datasets. Over time, we'll introduce additional capabilities, including optimizing your skills and other contextual information, and even model weights if your model provider allows finetuning.

## CLI and Agent Skills

We've created a CLI for you to use so that you can perform any task that you can on our platform – from admin stuff like creating teams and projects to uploading datasets and assigning reviews – from your terminal. The obvious reason we did this is so that you can have your coding agents do this for you.

Note: the one task we do _not_ let you perform from your CLI is any reviews assigned to you. We want to ensure that the data being collected is from the intended human expert.

## Requirements

- [Node.js 20+](https://nodejs.org/en/download)
- Access to an Orizu web app/API
- A valid Orizu account

By default, the CLI talks to `https://orizu.ai`.

## Install

Install the CLI globally with your package manager:

| Package manager | Command |
| --- | --- |
| npm | `npm i -g orizu` |
| pnpm | `pnpm add -g orizu` |
| Bun | `bun add -g orizu` |

Then run the guided setup — it signs you in, initializes the local workspace
contract, installs global coding-agent skill symlinks, and shows the next
command for repo-specific Orizu adoption:

```bash
orizu setup
```

To repair or customize skill installs later, run the companion skill installer
directly:

```bash
orizu install-skill --agent claude --agent codex --yes
```

Experimental plugin packages for Codex and Claude Code live under `plugins/`
in this repository. The CLI-installed skill remains the default onboarding path
for now; the CLI is the runtime either way.

```bash
# Codex
codex plugin marketplace add <owner>/<this-repo>
codex plugin add orizu@orizu-plugins

# Claude Code (inside a session)
/plugin marketplace add <owner>/<this-repo>
/plugin install orizu@orizu
```

The npm package ships the skill alongside the CLI. Run
`orizu install-skill --agent claude --agent codex --yes` for an explicit global
install, or use `orizu install-skill --help` for project-scope installs, sync
modes, and advanced targets including the managed `AGENTS.md` section for
non-workspace repos. Keep installs in sync after CLI upgrades with
`orizu skills status` and `orizu skills update`.

Coding agents can also read the bundled skill directly without installing it:

```bash
orizu skills path --json
```

This prints the skill location plus source metadata (`name`, `root`, `skillMd`,
`source`, `cliVersion`, `skillHash`), so an agent can go from `npx orizu --help`
to reading `SKILL.md` in two commands and verify the guidance matches the CLI
that supplied it.

Agents are first-class users of this CLI: **every command supports `--json`**
(as a prefix, `orizu --json teams list`, or a trailing flag) and emits a single
machine-readable JSON document instead of formatted text. Discover the full
command surface, including global options, with `orizu capabilities --json`.

## Authentication

**Sign in**

```bash
orizu login
```

This will open a browser tab for you to login with. You must either have an account on the [Orizu platform](https://orizu.ai) or it will help you create one.
Approving the login creates a personal access token for the CLI and stores it in your local Orizu credentials file. You can revoke CLI tokens from the Personal Tokens page in Orizu.

**Check the signed-in user**

```bash
orizu whoami
```

**Sign out**

```bash
orizu logout
```

## Common Commands

<table>
  <tr>
    <th>Task</th>
    <th>Command</th>
  </tr>
  <tr>
    <td colspan="2"><strong>Agent setup</strong></td>
  </tr>
  <tr>
    <td>Install the bundled agent skill</td>
    <td><code>orizu install-skill --target codex-user --yes</code></td>
  </tr>
  <tr>
    <td>Locate the bundled skill (read-only)</td>
    <td><code>orizu skills path --json</code></td>
  </tr>
  <tr>
    <td>Inspect CLI capabilities as JSON</td>
    <td><code>orizu capabilities --json</code></td>
  </tr>
  <tr>
    <td colspan="2"><strong>Teams</strong></td>
  </tr>
  <tr>
    <td>List teams</td>
    <td><code>orizu teams list</code></td>
  </tr>
  <tr>
    <td>Create a team</td>
    <td><code>orizu teams create --name "Ops Eval"</code></td>
  </tr>
  <tr>
    <td>List team members</td>
    <td><code>orizu teams members list --team ops-eval</code></td>
  </tr>
  <tr>
    <td>Add a team member</td>
    <td><code>orizu teams members add --email person@example.com --team ops-eval</code></td>
  </tr>
  <tr>
    <td colspan="2"><strong>Projects</strong></td>
  </tr>
  <tr>
    <td>List projects</td>
    <td><code>orizu projects list --team ops-eval</code></td>
  </tr>
  <tr>
    <td>Create a project</td>
    <td><code>orizu projects create --name "Support QA" --team ops-eval</code></td>
  </tr>
  <tr>
    <td colspan="2"><strong>Prompts</strong></td>
  </tr>
  <tr>
    <td>List prompts</td>
    <td><code>orizu prompts list --project ops-eval/support-qa [--status active|archived|all]</code></td>
  </tr>
  <tr>
    <td>Archive or restore a prompt</td>
    <td><code>orizu prompts archive &lt;promptIdOrName&gt; --project ops-eval/support-qa</code><br><code>orizu prompts restore &lt;promptIdOrName&gt; --project ops-eval/support-qa</code></td>
  </tr>
  <tr>
    <td colspan="2"><strong>Report comments</strong></td>
  </tr>
  <tr>
    <td>List report comments</td>
    <td><code>orizu comments list --prompt &lt;promptIdOrName&gt; --project ops-eval/support-qa</code><br><code>orizu comments list --run &lt;runId&gt;</code><br><code>orizu comments list --task &lt;taskId&gt;</code></td>
  </tr>
  <tr>
    <td>Add or update comments</td>
    <td><code>orizu comments add --run &lt;runId&gt; --body @comment.md --anchor "Summary" --lines 4:6</code><br><code>orizu comments reply &lt;commentId&gt; --body "Fixed"</code><br><code>orizu comments resolve &lt;commentId&gt;</code></td>
  </tr>
  <tr>
    <td colspan="2"><strong>Datasets</strong></td>
  </tr>
  <tr>
    <td>Upload a dataset</td>
    <td>
      <pre><code>orizu datasets upload \
  --project ops-eval/support-qa \
  --file ./datasets/support.jsonl \
  --name "Support Batch 1"</code></pre>
    </td>
  </tr>
  <tr>
    <td>Download a dataset</td>
    <td><code>orizu datasets download --dataset &lt;datasetId&gt; --format jsonl --out ./dataset.jsonl</code></td>
  </tr>
  <tr>
    <td>Append dataset rows</td>
    <td><code>orizu datasets append --dataset &lt;datasetId&gt; --file ./datasets/support-extra.jsonl</code></td>
  </tr>
  <tr>
    <td>Delete a dataset</td>
    <td><code>orizu datasets delete --dataset &lt;datasetId&gt;</code> (interactive confirmation required)</td>
  </tr>
  <tr>
    <td>Lock a dataset</td>
    <td><code>orizu datasets lock --dataset &lt;datasetId&gt; --reason "Finalize for labeling"</code></td>
  </tr>
  <tr>
    <td colspan="2"><strong>Apps</strong></td>
  </tr>
  <tr>
    <td>List apps</td>
    <td><code>orizu apps list --project ops-eval/support-qa</code></td>
  </tr>
  <tr>
    <td>Create an app</td>
    <td>
      <pre><code>orizu apps create \
  --project ops-eval/support-qa \
  --name "Support Labeler" \
  --dataset &lt;datasetId&gt; \
  --file ./apps/SupportLabeler.tsx \
  --input-schema ./schemas/support-input.json \
  --output-schema ./schemas/support-output.json</code></pre>
    </td>
  </tr>
  <tr>
    <td>Update an app</td>
    <td>
      <pre><code>orizu apps update \
  --app &lt;appId&gt; \
  --file ./apps/SupportLabeler.tsx \
  --input-schema ./schemas/support-input.json \
  --output-schema ./schemas/support-output.json</code></pre>
    </td>
  </tr>
  <tr>
    <td>Preview an app locally</td>
    <td>
      <pre><code>orizu apps preview \
  --file ./apps/SupportLabeler.tsx \
  --input-schema ./schemas/support-input.json \
  --output-schema ./schemas/support-output.json \
  --sample-row ./fixtures/sample-row.json \
  --screenshot ./preview.png</code></pre>
    </td>
  </tr>
  <tr>
    <td>Preview runtime</td>
    <td>The CLI uses the live Orizu web checkout when it is nearby, otherwise it uses the bundled preview runtime snapshot shipped in this package.</td>
  </tr>
  <tr>
    <td>Link a dataset to an app</td>
    <td><code>orizu apps link-dataset --app &lt;appId&gt; --dataset &lt;datasetId&gt;</code></td>
  </tr>
  <tr>
    <td>Export app source</td>
    <td><code>orizu apps export --app &lt;appId&gt; --project ops-eval/support-qa --out ./apps/SupportLabeler.tsx</code></td>
  </tr>
  <tr>
    <td colspan="2"><strong>Tasks</strong></td>
  </tr>
  <tr>
    <td>Create a task</td>
    <td>
      <pre><code>orizu tasks create \
  --project ops-eval/support-qa \
  --dataset &lt;datasetId&gt; \
  --app &lt;appId&gt; \
  --title "Support QA Round 1" \
  --labels-per-item 2</code></pre>
    </td>
  </tr>
  <tr>
    <td>Publish a draft task</td>
    <td><code>orizu tasks publish --task &lt;taskId&gt; --assignees &lt;userId1,userId2&gt;</code></td>
  </tr>
  <tr>
    <td>Update a draft task</td>
    <td><code>orizu tasks update --task &lt;taskId&gt; --title "Support QA Round 1b" --labels-per-item 2</code></td>
  </tr>
  <tr>
    <td>Discard a draft task</td>
    <td><code>orizu tasks discard --task &lt;taskId&gt; --yes</code></td>
  </tr>
  <tr>
    <td>Check task status</td>
    <td><code>orizu tasks status --task &lt;taskId&gt;</code></td>
  </tr>
  <tr>
    <td>Pause a task</td>
    <td><code>orizu tasks pause --task &lt;taskId&gt;</code></td>
  </tr>
  <tr>
    <td>Upload a task report</td>
    <td><code>orizu tasks report set --task &lt;taskId&gt; --report-file ./report.md</code></td>
  </tr>
  <tr>
    <td>Read a task report</td>
    <td><code>orizu tasks report get --task &lt;taskId&gt;</code></td>
  </tr>
  <tr>
    <td>Resume a task</td>
    <td><code>orizu tasks unpause --task &lt;taskId&gt;</code></td>
  </tr>
  <tr>
    <td>Export task results</td>
    <td><code>orizu tasks export --task &lt;taskId&gt; --format csv --out ./support-round1.csv</code></td>
  </tr>
</table>

## Supported Data Formats

Dataset upload, append, and edit-rows commands support:

- `.csv`
- `.json` files containing an array of objects
- `.jsonl` files containing one object per line

Task and dataset export support:

- `csv`
- `json`
- `jsonl`

## Interactive And Automated Usage

Many commands can prompt for missing team, project, app, dataset, or task selections in an interactive terminal. In scripts and CI, pass explicit flags instead:

```bash
orizu tasks export --task <taskId> --format jsonl --out ./labels.jsonl
```

Use `--json` on supported task and app commands when automation needs structured output.

## More Documentation

- [docs/cli.md](docs/cli.md): complete CLI guide and command reference
- [skills/orizu-cli/references/cli-reference.md](skills/orizu-cli/references/cli-reference.md): compact command matrix and end-to-end flows
