export interface CliOptionDoc {
  name: string
  help: string
  required?: boolean
  repeatable?: boolean
  choices?: string[]
}

export interface CliCommandDoc {
  path: string[]
  usage: string
  summary: string
  group: string
  aliases?: string[][]
  options?: CliOptionDoc[]
  examples?: string[]
}

interface CliGroupDoc {
  name: string
  summary: string
}

const GLOBAL_OPTIONS = [
  ['--json', 'Emit machine-readable JSON instead of human text. Available on every command, as a prefix (orizu --json <command>) or trailing flag.'],
  ['--local', 'Use http://localhost:3000.'],
  ['--server <url>', 'Use a specific server origin, for example https://preview.example.com.'],
  ['--version, -v', 'Print the orizu CLI version.'],
  ['--help, -h', 'Show help for the root command, a group, or a specific command.'],
]

const GROUPS: CliGroupDoc[] = [
  { name: 'Auth', summary: 'Sign in, sign out, and inspect the active CLI identity.' },
  { name: 'Agent setup', summary: 'Install the bundled Orizu coding-agent skill and inspect the CLI surface.' },
  { name: 'Teams', summary: 'Manage teams and team memberships.' },
  { name: 'Projects', summary: 'Manage projects inside teams.' },
  { name: 'Prompts and judges', summary: 'Work with versioned prompt and judge artifacts.' },
  { name: 'Report comments', summary: 'Review and mutate anchored report comments across prompt, optimization, and task reports.' },
  { name: 'Scorers and runners', summary: 'Register scorers, push runnable artifacts, execute runners, and submit scores.' },
  { name: 'Optimizations', summary: 'Start, run, export, and finalize optimization runs.' },
  { name: 'Apps', summary: 'Create, preview, update, inspect, and export review apps.' },
  { name: 'Tasks', summary: 'Create review tasks, mutate task status, assign reviewers, and export labels.' },
  { name: 'Datasets', summary: 'Upload, version, split, mutate, export, lock, clone, and delete datasets.' },
  { name: 'Workspace', summary: 'Metadata-first sync of the workbench contract: inspect status, reconcile, pull, and apply.' },
  { name: 'Sessions', summary: 'Start, inspect, and end durable workspace sessions for agent/operator work.' },
  { name: 'Workbench runs', summary: 'Start, inspect, tail, and finish resumable workbench runs.' },
  { name: 'Connectors', summary: 'Inspect project connector/integration readiness (read-only; secrets redacted).' },
  { name: 'Promotion manifests', summary: 'List, inspect, approve, reject, and idempotently apply promotion manifests.' },
]

export const COMMAND_DOCS: CliCommandDoc[] = [
  {
    path: ['login'],
    usage: 'orizu login [--no-prompt-if-logged-in]',
    summary: 'Open the browser login flow and store CLI credentials for the selected server.',
    group: 'Auth',
    options: [
      { name: '--no-prompt-if-logged-in', help: 'Return immediately when credentials already exist.' },
    ],
    examples: ['orizu login', 'orizu --local login'],
  },
  {
    path: ['logout'],
    usage: 'orizu logout',
    summary: 'Clear local credentials and best-effort revoke the active CLI token remotely.',
    group: 'Auth',
  },
  {
    path: ['whoami'],
    usage: 'orizu whoami',
    summary: 'Print the authenticated user and active server.',
    group: 'Auth',
  },
  {
    path: ['env'],
    usage: 'orizu env [--project <team/project>] [--project-id <projectId>]',
    summary: 'Print environment values for local runners and agent workflows.',
    group: 'Auth',
  },
  {
    path: ['log'],
    usage: 'orizu log <event_type> --run-id <id> --sequence <n> --payload @event.json',
    summary: 'Submit an optimization event payload.',
    group: 'Optimizations',
  },
  {
    path: ['comments', 'list'],
    usage: 'orizu comments list (--prompt <id-or-name> --project <team/project> [--label <label> | --version <id>] | --run <run-id> | --task <task-id>) [--json]',
    summary: 'List report comment threads with open/resolved status and replies.',
    group: 'Report comments',
    options: [
      { name: '--prompt <id-or-name>', help: 'Prompt report target. Requires --project.' },
      { name: '--project <team/project>', help: 'Project slug for prompt targets.' },
      { name: '--label <label>', help: 'Prompt version label to comment on.' },
      { name: '--version <id>', help: 'Prompt version ID to comment on.' },
      { name: '--run <run-id>', help: 'Optimization run report target.' },
      { name: '--task <task-id>', help: 'Task report target.' },
      { name: '--json', help: 'Emit the full comments payload.' },
    ],
    examples: [
      'orizu comments list --prompt Generator --project core/evals --label production',
      'orizu comments list --run <run-id>',
      'orizu comments list --task <task-id>',
    ],
  },
  {
    path: ['comments', 'add'],
    usage: 'orizu comments add (--prompt <id-or-name> --project <team/project> [--label <label> | --version <id>] | --run <run-id> | --task <task-id>) --body <text|@file> [--anchor <text>] [--lines <start:end>] [--via <name>] [--json]',
    summary: 'Add an anchored top-level comment to a report.',
    group: 'Report comments',
    options: [
      { name: '--body <text|@file>', help: 'Comment body or @file reference.', required: true },
      { name: '--anchor <text>', help: 'Quoted report text for the comment anchor.' },
      { name: '--lines <start:end>', help: 'One-based inclusive line range for the anchor.' },
      { name: '--via <name>', help: 'Tool or agent name to show in attribution.' },
      { name: '--json', help: 'Emit the created comment payload.' },
    ],
    examples: [
      'orizu comments add --run <run-id> --body @comment.md --anchor "Score summary" --lines 4:6',
      'orizu comments add --task <task-id> --body "Clarify this finding" --via Codex',
    ],
  },
  {
    path: ['comments', 'reply'],
    usage: 'orizu comments reply <comment-id> --body <text|@file> [--via <name>] [--json]',
    summary: 'Reply to a top-level report comment thread.',
    group: 'Report comments',
  },
  {
    path: ['comments', 'resolve'],
    usage: 'orizu comments resolve <comment-id> [--json]',
    summary: 'Resolve a top-level report comment thread.',
    group: 'Report comments',
  },
  {
    path: ['comments', 'unresolve'],
    usage: 'orizu comments unresolve <comment-id> [--json]',
    summary: 'Reopen a resolved report comment thread.',
    group: 'Report comments',
  },
  {
    path: ['comments', 'edit'],
    usage: 'orizu comments edit <comment-id> --body <text|@file> [--json]',
    summary: 'Edit one of your report comments or replies.',
    group: 'Report comments',
  },
  {
    path: ['setup'],
    usage: 'orizu setup [--team <slug>] [--agent <claude|codex>]... [--workspace [path]|--no-workspace] [--validate] [--fix] [--no-symlinks] [--verbose] [--no-install] [--handoff|--no-handoff] [--launch <claude|codex>] [--skip-login] [--yes] [--dry-run] [--no-input|--non-interactive] [--json]',
    summary: 'Guided onboarding: sign in, initialize the workbench contract, and install agent skills.',
    group: 'Agent setup',
    options: [
      { name: '--team <slug>', help: 'Team/workbench slug. Authenticated setup materializes all projects in this team.' },
      { name: '--workspace [path]', help: 'Initialize or validate a workspace path, or the current directory when no path is provided. If provided, the value must be a filesystem path.' },
      { name: '--service-origin <url>', help: 'Service origin written to setup metadata. Defaults to the active CLI server.' },
      { name: '--attach-workspace <id>', help: 'Record an existing Orizu workspace id for future attachment.' },
      { name: '--validate', help: 'Inspect the workspace contract without writing files.' },
      { name: '--fix', help: 'Apply safe idempotent repairs only.' },
      { name: '--no-symlinks', help: 'Write CLAUDE.md as a pointer file instead of a symlink to AGENTS.md.' },
      { name: '--verbose', help: 'Show per-file setup actions. Default setup output is summary-oriented.' },
      { name: '--agent <agent>', help: 'Install the global Orizu skill for this coding agent after workspace setup. Repeat for multiple agents.', repeatable: true, choices: ['claude', 'codex'] },
      { name: '--no-workspace', help: 'Skip workspace creation during guided setup. `--validate` and `--fix` still inspect or repair the workspace contract.' },
      { name: '--no-install', help: 'Skip the coding-agent skill install step.' },
      { name: '--handoff', help: 'Print the coding-agent setup prompt after setup. By default, setup points to `orizu setup prompt` instead of printing it inline.' },
      { name: '--no-handoff', help: 'Compatibility flag; suppresses --handoff/--launch. Setup does not print the handoff prompt by default.' },
      { name: '--launch <agent>', help: 'Launch a detected coding agent with the setup prompt (interactive terminals only).', choices: ['claude', 'codex'] },
      { name: '--skip-login', help: 'Skip the authentication phase.' },
      { name: '--yes', help: 'Replace existing managed skill links without prompting.' },
      { name: '--dry-run', help: 'Preview every planned change without writing.' },
      { name: '--no-input', help: 'Never prompt; behave as in a non-interactive terminal.' },
      { name: '--non-interactive', help: 'Alias for --no-input.' },
      { name: '--json', help: 'Emit the setup summary as JSON.' },
    ],
    examples: [
      'orizu setup',
      'orizu setup --team highlight',
      'orizu setup --team highlight --agent codex --agent claude --non-interactive --yes',
      'orizu setup --validate --workspace ./workbench',
    ],
  },
  {
    path: ['setup', 'prompt'],
    usage: 'orizu setup prompt',
    summary: 'Print the coding-agent setup prompt for repo-specific Orizu adoption.',
    group: 'Agent setup',
    examples: ['orizu setup prompt', 'claude "$(orizu setup prompt)"'],
  },
  {
    path: ['install-skill'],
    usage: 'orizu install-skill [--agent <claude|codex|opencode>]... [--scope global|project] [--mode auto|link|copy] [--target <target>]... [--yes] [--dry-run]',
    summary: 'Install or repair the Orizu coding-agent skill.',
    group: 'Agent setup',
    aliases: [['skills', 'install']],
    options: [
      {
        name: '--agent <agent>',
        help: 'Coding agent to set up. Repeat for multiple agents.',
        repeatable: true,
        choices: ['claude', 'codex'],
      },
      {
        name: '--scope <scope>',
        help: 'Where the install lives: global installs for you across all projects (default); project installs into the current repo.',
        choices: ['global', 'project'],
      },
      {
        name: '--mode <mode>',
        help: 'How installs stay in sync with the CLI: auto (default) symlinks when the CLI install path is stable and copies otherwise; link forces a symlink; copy forces a full copy with sync metadata. Project-scope installs always copy.',
        choices: ['auto', 'link', 'copy'],
      },
      {
        name: '--target <target>',
        help: 'Advanced: explicit install destination ID. Repeat for multiple targets.',
        repeatable: true,
        choices: ['codex-user', 'agent-user', 'agents-project', 'codex-project', 'claude-user', 'claude-project', 'agents-md'],
      },
      { name: '--yes', help: 'Replace an existing managed skill or AGENTS.md section without prompting.' },
      { name: '--dry-run', help: 'Show planned writes without changing files.' },
    ],
    examples: [
      'orizu install-skill --agent claude --agent codex --yes',
      'orizu install-skill --agent claude --scope project --yes',
      'orizu install-skill --target agents-md --dry-run',
    ],
  },
  {
    path: ['skills', 'status'],
    usage: 'orizu skills status [--json]',
    summary: 'Report installed Orizu skill targets and whether each is in sync with the CLI.',
    group: 'Agent setup',
    options: [
      { name: '--json', help: 'Emit machine-readable status for every known install target.' },
    ],
    examples: ['orizu skills status', 'orizu skills status --json'],
  },
  {
    path: ['skills', 'update'],
    usage: 'orizu skills update [--dry-run] [--json]',
    summary: 'Refresh stale copied skill installs and repair broken symlinks.',
    group: 'Agent setup',
    options: [
      { name: '--dry-run', help: 'Show which installs would be refreshed without changing files.' },
      { name: '--json', help: 'Emit machine-readable update results.' },
    ],
    examples: ['orizu skills update', 'orizu skills update --dry-run'],
  },
  {
    path: ['skills', 'path'],
    usage: 'orizu skills path [--skill-md] [--json]',
    summary: 'Print where the bundled Orizu skill lives so agents can read it without installing.',
    group: 'Agent setup',
    options: [
      { name: '--skill-md', help: 'Print the full path to SKILL.md instead of the skill root directory.' },
      { name: '--json', help: 'Emit machine-readable metadata: name, root, skillMd, source, cliVersion, skillHash.' },
    ],
    examples: [
      'orizu skills path',
      'orizu skills path --skill-md',
      'orizu skills path --json',
    ],
  },
  {
    path: ['capabilities'],
    usage: 'orizu capabilities [--json]',
    summary: 'List the CLI command surface in human-readable or JSON form.',
    group: 'Agent setup',
    options: [
      { name: '--json', help: 'Emit a machine-readable command manifest.' },
    ],
    examples: ['orizu capabilities --json', 'orizu --json capabilities'],
  },
  {
    path: ['teams', 'list'],
    usage: 'orizu teams list',
    summary: 'List teams available to the authenticated user.',
    group: 'Teams',
  },
  {
    path: ['teams', 'create'],
    usage: 'orizu teams create [--name <name>]',
    summary: 'Create a team. Prompts for a name in an interactive terminal if omitted.',
    group: 'Teams',
  },
  {
    path: ['teams', 'members', 'list'],
    usage: 'orizu teams members list [--team <teamSlug>]',
    summary: 'List team members with member IDs, canonical user IDs, emails, and roles.',
    group: 'Teams',
  },
  {
    path: ['teams', 'members', 'add'],
    usage: 'orizu teams members add --email <email> [--team <teamSlug>]',
    summary: 'Invite or add a team member by email.',
    group: 'Teams',
  },
  {
    path: ['teams', 'members', 'remove'],
    usage: 'orizu teams members remove --email <email> [--team <teamSlug>]',
    summary: 'Remove a team member by email.',
    group: 'Teams',
  },
  {
    path: ['teams', 'members', 'role'],
    usage: 'orizu teams members role --team <teamSlug> --email <email> --role <admin|curator|judge>',
    summary: 'Change a member role.',
    group: 'Teams',
  },
  {
    path: ['projects', 'list'],
    usage: 'orizu projects list [--team <teamSlug>]',
    summary: 'List projects, optionally scoped to one team.',
    group: 'Projects',
  },
  {
    path: ['projects', 'create'],
    usage: 'orizu projects create --name <name> [--team <teamSlug>]',
    summary: 'Create a project inside a team.',
    group: 'Projects',
  },
  {
    path: ['prompts', 'list'],
    usage: 'orizu prompts list --project <team/project> [--status active|archived|all]',
    summary: 'List prompt artifacts in a project.',
    group: 'Prompts and judges',
  },
  {
    path: ['prompts', 'archive'],
    usage: 'orizu prompts archive <prompt-id-or-name> --project <team/project> [--json]',
    summary: 'Mark a prompt artifact as archived.',
    group: 'Prompts and judges',
  },
  {
    path: ['prompts', 'restore'],
    usage: 'orizu prompts restore <prompt-id-or-name> --project <team/project> [--json]',
    summary: 'Restore an archived prompt artifact to active status.',
    group: 'Prompts and judges',
  },
  {
    path: ['prompts', 'pull'],
    usage: 'orizu prompts pull <prompt-id-or-name> --project <team/project> --out <dir> [--label <label> | --version <id>] [--json]',
    summary: 'Pull a prompt artifact version to a local directory.',
    group: 'Prompts and judges',
  },
  {
    path: ['prompts', 'push'],
    usage: 'orizu prompts push <dir> [--runner-version <id>] [--project <team/project>] [--parent <version-id>] [--session <session-id>] [--json]',
    summary: 'Push a local prompt artifact directory as a new version (with --session: a commit-first git draft).',
    group: 'Prompts and judges',
  },
  {
    path: ['prompts', 'labels', 'set'],
    usage: 'orizu prompts labels set <prompt-name> <label> --version <version-id> [--project <team/project>] [--json]',
    summary: 'Move or set a prompt label to a version.',
    group: 'Prompts and judges',
  },
  {
    path: ['prompts', 'scorers', 'set-headline'],
    usage: 'orizu prompts scorers set-headline <prompt-id> --scorer-version <id> [--dataset-version <id> --split-set <id> --split <name>] [--project <team/project>] [--json]',
    summary: 'Bind the headline scorer for a prompt.',
    group: 'Scorers and runners',
  },
  {
    path: ['prompts', 'scorers', 'add'],
    usage: 'orizu prompts scorers add <prompt-id> --scorer-version <id> [--dataset-version <id> --split-set <id> --split <name>] [--project <team/project>] [--json]',
    summary: 'Track an additional scorer for a prompt.',
    group: 'Scorers and runners',
  },
  {
    path: ['judges', 'list'],
    usage: 'orizu judges list --project <team/project> [--status active|archived|all]',
    summary: 'List judge prompt artifacts in a project.',
    group: 'Prompts and judges',
  },
  {
    path: ['judges', 'pull'],
    usage: 'orizu judges pull <judge-id-or-name> --project <team/project> --out <dir> [--label <label> | --version <id>] [--json]',
    summary: 'Pull a judge artifact version to a local directory.',
    group: 'Prompts and judges',
  },
  {
    path: ['judges', 'push'],
    usage: 'orizu judges push <dir> [--runner-version <id>] [--project <team/project>] [--parent <version-id>] [--session <session-id>] [--json]',
    summary: 'Push a local judge artifact directory as a new version (with --session: a commit-first git draft).',
    group: 'Prompts and judges',
  },
  {
    path: ['scorers', 'list'],
    usage: 'orizu scorers list --project <team/project>',
    summary: 'List scorers in a project.',
    group: 'Scorers and runners',
  },
  {
    path: ['scorers', 'register'],
    usage: 'orizu scorers register --project <team/project> --name <name> --manifest <manifest.json> [--prompt-version <id>] [--runner-version <id>] [--label <label>] [--json]',
    summary: 'Register a scorer from a local manifest.',
    group: 'Scorers and runners',
  },
  {
    path: ['scorers', 'detail'],
    usage: 'orizu scorers detail <scorer-id-or-name> --project <team/project> [--json]',
    summary: 'Show scorer details.',
    group: 'Scorers and runners',
  },
  {
    path: ['scorers', 'labels', 'set'],
    usage: 'orizu scorers labels set <scorer-name> <label> --version <scorer-version-id> [--project <team/project>] [--json]',
    summary: 'Move or set a scorer label to a version.',
    group: 'Scorers and runners',
  },
  {
    path: ['scorers', 'exec'],
    usage: 'orizu scorers exec --scorer-version <id> (--subject-version <prompt-version-id> | --optimization-run <id> --candidate <id>) --dataset-version <id> --split-set <id> --split <name> [--subject-results <jsonl>] [--dependency-score-run <alias=id>] [--dependency-results <alias=path>] [--no-submit] [--out <score.json>] [--project <team/project>] [--json]',
    summary: 'Execute a scorer locally for a prompt version or optimization candidate.',
    group: 'Scorers and runners',
  },
  {
    path: ['scores', 'submit'],
    usage: 'orizu scores submit <results.jsonl|results.json> --scorer-version <id> (--subject-version <prompt-version-id> | --optimization-run <id> --candidate <id>) [--aggregate] [--dataset-version <id> --split-set <id> --split <name>] [--project <team/project>] [--json]',
    summary: 'Submit score results for a scorer against a prompt version or optimization candidate.',
    group: 'Scorers and runners',
  },
  {
    path: ['runners', 'push'],
    usage: 'orizu runners push <dir> [--project <team/project>] [--name <name>] [--label <label>] [--json]',
    summary: 'Push a local runner artifact directory.',
    group: 'Scorers and runners',
  },
  {
    path: ['runners', 'list'],
    usage: 'orizu runners list [--project <team/project>] [--json]',
    summary: 'List runner artifacts with version counts, latest version ids, and labels.',
    group: 'Scorers and runners',
  },
  {
    path: ['runners', 'pull'],
    usage: 'orizu runners pull <runner-id-or-name> --project <team/project> --out <dir> [--label <label> | --version <version-id>] [--json]',
    summary: 'Pull a runner artifact version to a local directory.',
    group: 'Scorers and runners',
  },
  {
    path: ['runners', 'exec'],
    usage: 'orizu runners exec (--prompt <prompt-version-id> | --prompt-version <id> --runner-version <id> | --scorer-version <id>) --dataset-version <id> --split-set <id-or-name> --split <name> [--runner-dir <dir>] --out <results.jsonl|results.jsonl.gz>',
    summary: 'Execute a runner locally against a dataset split and write row results. --runner-dir bytes must match the registered runner version (ADR-007) — register with `orizu runners push` first.',
    group: 'Scorers and runners',
  },
  {
    path: ['optimizers', 'push'],
    usage: 'orizu optimizers push <dir> [--project <team/project>] [--name <name>] [--label <label>] [--json]',
    summary: 'Push a local optimizer artifact directory.',
    group: 'Optimizations',
  },
  {
    path: ['optimizers', 'list'],
    usage: 'orizu optimizers list [--project <team/project>] [--json]',
    summary: 'List optimizer artifacts with version counts, latest version ids, and labels.',
    group: 'Optimizations',
  },
  {
    path: ['optimizers', 'pull'],
    usage: 'orizu optimizers pull <optimizer-id-or-name> --project <team/project> --out <dir> [--label <label> | --version <version-id>] [--json]',
    summary: 'Pull an optimizer artifact version to a local directory.',
    group: 'Optimizations',
  },
  {
    path: ['runs', 'submit'],
    usage: 'orizu runs submit <results.jsonl|results.jsonl.gz> --prompt-version <id> --runner-version <id> --dataset-version <id> --split-set <id> --split <name> [--project <team/project>]',
    summary: 'Submit local prompt-run results.',
    group: 'Scorers and runners',
  },
  {
    path: ['optimizations', 'start'],
    usage: 'orizu optimizations start --project <team/project> --optimizer-version <id> --prompt-version <id[,id]> --selection-scorer <id> [--reflection-scorer <id>] [--pareto-scorer <id>] [--best-scorer <id>] --dataset-version <id> --split-set <id> [--train-split <name>] [--validation-split <name>] [--metadata <json|@file>] [--json]',
    summary: 'Create an optimization run record.',
    group: 'Optimizations',
  },
  {
    path: ['optimizations', 'run-gepa'],
    usage: 'orizu optimizations run-gepa --project <team/project> --optimizer-version-id <id> --candidate-version-id <id> --runner-version-id <id> --candidate-runner-dir <dir> --scorer-version-id <id> --scorer-runner-version-id <id> --scorer-runner-dir <dir> [--scorer-input-contract gepa|flat_row] [--scorer-candidate-field <row-field>] [--allow-degenerate-seed] --dataset-version-id <id> --split-set-id <id> [--train-split train] [--val-split validation] [--budget auto|light|medium|heavy | --max-metric-calls <n> | --max-full-evals <n> | --max-iterations <n>] [--num-threads auto|N] [--reflection-retry-attempts N] [--reflection-http-timeout-seconds N] [--log-dir logs]',
    summary: 'Run the bundled GEPA-style optimizer locally and stream events. Validates the scorer contract on the seed before iterating; judge runners built for flat-row score runs need --scorer-input-contract flat_row (ALI-1158).',
    group: 'Optimizations',
  },
  {
    path: ['optimizations', 'export'],
    usage: 'orizu optimizations export <run-id> [--out <path>] [--json]',
    summary: 'Export an optimization run to JSON.',
    group: 'Optimizations',
  },
  {
    path: ['optimizations', 'pause'],
    usage: 'orizu optimizations pause <run-id> [--reason <text>] [--json]',
    summary: 'Pause an optimization run.',
    group: 'Optimizations',
  },
  {
    path: ['optimizations', 'resume'],
    usage: 'orizu optimizations resume <run-id> [--json]',
    summary: 'Resume an optimization run.',
    group: 'Optimizations',
  },
  {
    path: ['optimizations', 'finish'],
    usage: 'orizu optimizations finish <run-id> [--best-score <n>] [--best-candidate <id>] [--result-prompt-version <id>] [--report <markdown|@file> | --report-file <path>] [--metadata <json|@file>] [--json]',
    summary: 'Mark an optimization run finished and attach final metadata/report data.',
    group: 'Optimizations',
  },
  {
    path: ['optimizations', 'fail'],
    usage: 'orizu optimizations fail <run-id> [--reason <text>] [--report <markdown|@file> | --report-file <path>] [--metadata <json|@file>] [--json]',
    summary: 'Mark an optimization run failed.',
    group: 'Optimizations',
  },
  {
    path: ['optimizations', 'cancel'],
    usage: 'orizu optimizations cancel <run-id> [--reason <text>] [--report <markdown|@file> | --report-file <path>] [--metadata <json|@file>] [--json]',
    summary: 'Cancel an optimization run.',
    group: 'Optimizations',
  },
  {
    path: ['apps', 'list'],
    usage: 'orizu apps list [--project <team/project>]',
    summary: 'List review apps in a project.',
    group: 'Apps',
  },
  {
    path: ['apps', 'create'],
    usage: 'orizu apps create --project <team/project> --name <name> --dataset <datasetId> --file <path> --input-schema <json-path> --output-schema <json-path> [--component <name>]',
    summary: 'Create a review app from a local component and schema files.',
    group: 'Apps',
    examples: [
      'orizu apps create --project core/evals --name "Support Labeler" --dataset <datasetId> --file ./App.tsx --input-schema ./input.json --output-schema ./output.json',
    ],
  },
  {
    path: ['apps', 'preview'],
    usage: 'orizu apps preview --file <path> --input-schema <json-path> --output-schema <json-path> --sample-row <json-path> [--screenshot <png-path>] [--headed] [--keep-open] [--component <name>]',
    summary: 'Render a local review app in the bundled preview runtime.',
    group: 'Apps',
  },
  {
    path: ['apps', 'update'],
    usage: 'orizu apps update [--app <appId>] [--project <team/project>] --file <path> --input-schema <json-path> --output-schema <json-path> [--component <name>]',
    summary: 'Create a new app version from local source and schemas.',
    group: 'Apps',
  },
  {
    path: ['apps', 'link-dataset'],
    usage: 'orizu apps link-dataset --dataset <datasetId> [--app <appId>] [--project <team/project>] [--version <n>]',
    summary: 'Link an app or app version to a dataset.',
    group: 'Apps',
  },
  {
    path: ['apps', 'detail'],
    usage: 'orizu apps detail --app <appId> [--project <team/project>] [--json]',
    summary: 'Show app detail.',
    group: 'Apps',
  },
  {
    path: ['apps', 'export'],
    usage: 'orizu apps export [--app <appId>] [--project <team/project>] [--version <n>] [--out <path>]',
    summary: 'Export app source for the selected app version.',
    group: 'Apps',
  },
  {
    path: ['tasks', 'list'],
    usage: 'orizu tasks list [--project <team/project>]',
    summary: 'List review tasks, optionally scoped to a project.',
    group: 'Tasks',
  },
  {
    path: ['tasks', 'create'],
    usage: 'orizu tasks create --project <team/project> --dataset <datasetId> --app <appId> --title <title> [--assignees <userIdOrEmail1,userIdOrEmail2> | --assignment-file <path>] [--publish] [--version <n>] [--instructions <text>] [--labels-per-item <n>] [--json]',
    summary: 'Create a draft review task by default, with auto distribution or an explicit row-assignment JSONL file.',
    group: 'Tasks',
  },
  {
    path: ['tasks', 'update'],
    usage: 'orizu tasks update --task <taskId> [--title <text>] [--description <text>|--description-file <path>] [--instructions <text>|--instructions-file <path>] [--dataset <datasetId>] [--app <appId> [--version <n>]] [--labels-per-item <n>] [--assignees <userIdOrEmail1,userIdOrEmail2> | --assignment-file <path>] [--json]',
    summary: 'Update a draft review task before publishing.',
    group: 'Tasks',
  },
  {
    path: ['tasks', 'discard'],
    usage: 'orizu tasks discard --task <taskId> [--yes] [--json]',
    summary: 'Permanently discard a draft review task.',
    group: 'Tasks',
  },
  {
    path: ['tasks', 'publish'],
    usage: 'orizu tasks publish --task <taskId> (--assignees <userId1,userId2> | --assignment-file <path>) [--json]',
    summary: 'Publish an approved draft task and assign reviewers.',
    group: 'Tasks',
  },
  {
    path: ['tasks', 'assign'],
    usage: 'orizu tasks assign --task <taskId> (--assignees <userId1,userId2> | --assignment-file <path>) [--replace-existing] [--json]',
    summary: 'Assign a task with auto distribution or an explicit row-assignment JSONL file.',
    group: 'Tasks',
  },
  {
    path: ['tasks', 'status'],
    usage: 'orizu tasks status --task <taskId> [--json]',
    summary: 'Show task assignment counts and progress.',
    group: 'Tasks',
  },
  {
    path: ['tasks', 'report', 'set'],
    usage: 'orizu tasks report set --task <taskId> (--report <markdown|@file> | --report-file <path>) [--json]',
    summary: 'Upload or replace a Markdown report for a paused or completed task.',
    group: 'Tasks',
    aliases: [['tasks', 'report', 'upload']],
    options: [
      { name: '--task <taskId>', help: 'Task ID to attach the report to.', required: true },
      { name: '--report <markdown|@file>', help: 'Inline Markdown or an @file reference.' },
      { name: '--report-file <path>', help: 'Markdown file to upload.' },
      { name: '--json', help: 'Emit the updated report payload.' },
    ],
    examples: [
      'orizu tasks report set --task <taskId> --report-file ./report.md',
      'orizu tasks report upload --task <taskId> --report @./report.md',
    ],
  },
  {
    path: ['tasks', 'report', 'get'],
    usage: 'orizu tasks report get --task <taskId> [--json]',
    summary: 'Read the Markdown report for a task.',
    group: 'Tasks',
    options: [
      { name: '--task <taskId>', help: 'Task ID whose report should be read.', required: true },
      { name: '--json', help: 'Emit the full report payload.' },
    ],
    examples: [
      'orizu tasks report get --task <taskId>',
      'orizu tasks report get --task <taskId> --json',
    ],
  },
  {
    path: ['tasks', 'pause'],
    usage: 'orizu tasks pause --task <taskId>',
    summary: 'Pause a task.',
    group: 'Tasks',
  },
  {
    path: ['tasks', 'unpause'],
    usage: 'orizu tasks unpause --task <taskId>',
    summary: 'Resume a paused task.',
    group: 'Tasks',
  },
  {
    path: ['tasks', 'complete'],
    usage: 'orizu tasks complete --task <taskId>',
    summary: 'Mark an active or paused task completed.',
    group: 'Tasks',
  },
  {
    path: ['tasks', 'export'],
    usage: 'orizu tasks export [--task <taskId>] [--format <csv|json|jsonl>] [--out <path>]',
    summary: 'Export task results.',
    group: 'Tasks',
  },
  {
    path: ['datasets', 'upload'],
    usage: 'orizu datasets upload --file <path> [--project <team/project>] [--name <name>] [--readme-file <README.md> | --readme-text <markdown>]',
    summary: 'Upload a dataset from CSV, JSON, or JSONL.',
    group: 'Datasets',
  },
  {
    path: ['datasets', 'push'],
    usage: 'orizu datasets push <path> [--project <team/project>] [--name <name>] [--readme-file <README.md> | --readme-text <markdown>] [--json]',
    summary: 'Upload a dataset with a path-first, automation-friendly command shape.',
    group: 'Datasets',
  },
  {
    path: ['datasets', 'readme', 'set'],
    usage: 'orizu datasets readme set <datasetId|dataset-name> [--project <team/project>] (--readme-file <README.md> | --readme-text <markdown>) [--json]',
    summary: 'Set or replace dataset README markdown.',
    group: 'Datasets',
  },
  {
    path: ['datasets', 'versions', 'create'],
    usage: 'orizu datasets versions create <datasetId|dataset-name> [--project <team/project>] [--label <label>] [--readme-file <README.md> | --readme-text <markdown>] [--json]',
    summary: 'Create a dataset version.',
    group: 'Datasets',
  },
  {
    path: ['datasets', 'splits', 'create'],
    usage: 'orizu datasets splits create <datasetVersionId> [--from-file <split.json>] [--json]',
    summary: 'Create a split set for a dataset version.',
    group: 'Datasets',
  },
  {
    path: ['datasets', 'download'],
    usage: 'orizu datasets download [--dataset <datasetId|datasetUrl>] [--project <team/project>] [--format <csv|json|jsonl>] [--out <path>]',
    summary: 'Download a dataset.',
    group: 'Datasets',
  },
  {
    path: ['datasets', 'append'],
    usage: 'orizu datasets append [--dataset <datasetId|datasetUrl>] [--project <team/project>] --file <path>',
    summary: 'Append rows to an unlocked dataset.',
    group: 'Datasets',
  },
  {
    path: ['datasets', 'edit-rows'],
    usage: 'orizu datasets edit-rows [--dataset <datasetId|datasetUrl>] [--project <team/project>] --file <path>',
    summary: 'Edit rows by canonical row ID.',
    group: 'Datasets',
  },
  {
    path: ['datasets', 'delete-rows'],
    usage: 'orizu datasets delete-rows [--dataset <datasetId|datasetUrl>] [--project <team/project>] --row-ids <id1,id2>',
    summary: 'Delete specific rows by canonical row ID.',
    group: 'Datasets',
  },
  {
    path: ['datasets', 'delete'],
    usage: 'orizu datasets delete [--dataset <datasetId|datasetUrl>] [--project <team/project>]',
    summary: 'Delete a whole dataset after interactive ID confirmation.',
    group: 'Datasets',
  },
  {
    path: ['datasets', 'lock'],
    usage: 'orizu datasets lock [--dataset <datasetId|datasetUrl>] [--project <team/project>] [--reason <text>]',
    summary: 'Lock a dataset against row mutations.',
    group: 'Datasets',
  },
  {
    path: ['datasets', 'clone'],
    usage: 'orizu datasets clone [--dataset <datasetId|datasetUrl>] [--project <team/project>] [--name <name>]',
    summary: 'Clone a dataset.',
    group: 'Datasets',
  },
  {
    path: ['workspace', 'status'],
    usage: 'orizu workspace status [--remote] [--json]',
    summary: 'Show tracked-resource status: local dirtiness vs the last-sync cache, plus missing and untracked files; --remote adds server statuses via a server-side reconciliation.',
    group: 'Workspace',
    options: [
      { name: '--remote', help: 'Attach server statuses. This performs the same server-side reconciliation as `orizu workspace sync` — it registers and updates tracked-resource records; there is no read-only remote status in v0. The local cache is never advanced.' },
      { name: '--json', help: 'Emit the machine-readable status result.' },
    ],
    examples: ['orizu workspace status', 'orizu workspace status --remote --json'],
  },
  {
    path: ['workspace', 'sync'],
    usage: 'orizu workspace sync [--json]',
    summary: 'Metadata-first reconcile of the whole workbench. Attaches the workspace on first run; advances the cache base only on a clean convergence.',
    group: 'Workspace',
    options: [
      { name: '--json', help: 'Emit the machine-readable per-resource status list.' },
    ],
    examples: ['orizu workspace sync', 'orizu workspace sync --json'],
  },
  {
    path: ['workspace', 'pull'],
    usage: 'orizu workspace pull <path> [--json]',
    summary: 'Fast-forward a resource to the server truth (v0: manifest canonical block + cache only). Refuses when local edits are ahead and no-ops when the server has no truth (local-only/stale). Bulk content materializes via the primitive command (e.g. orizu prompts pull).',
    group: 'Workspace',
    options: [
      { name: '--json', help: 'Emit the machine-readable pull result.' },
    ],
    examples: ['orizu workspace pull projects/hip/prompts/judge/orizu.prompt.json'],
  },
  {
    path: ['workspace', 'apply'],
    usage: 'orizu workspace apply <path> [--json]',
    summary: 'Promote a repo-owned resource to the server, addressed by the row id recorded by sync. Refuses (409) DB-native/object-storage owners, conflicts, remote-newer, and lost compare-and-set races — on any refusal, run `orizu workspace sync`, converge, then retry.',
    group: 'Workspace',
    options: [
      { name: '--json', help: 'Emit the machine-readable apply result.' },
    ],
    examples: ['orizu workspace apply projects/hip/prompts/judge/orizu.prompt.json'],
  },
  {
    path: ['session', 'start'],
    usage: 'orizu session start [--project <team/project>] [--workspace <dir>] [--json] | orizu session start --hosted (--task <prompt> | --task-file <path>) [--duration <min>] [--project <team/project>] [--tail]',
    summary:
      'Start a durable workspace session, or add --hosted with a task prompt to start a coordinator-managed hosted agent. Plain sessions check out their remote session branch locally when run inside the workbench clone (or with --workspace).',
    group: 'Sessions',
    options: [
      { name: '--project <team/project>', help: 'Optionally scope the session to a project in the attached workspace.' },
      { name: '--workspace <dir>', help: 'Workbench clone directory when not running from inside it.' },
      { name: '--hosted', help: 'Start a coordinator-managed hosted agent session instead of a plain durable session.' },
      { name: '--task <prompt>', help: 'Hosted agent task prompt. Mutually exclusive with --task-file.' },
      { name: '--task-file <path>', help: 'Read the hosted agent task prompt from a UTF-8 file. Mutually exclusive with --task.' },
      { name: '--duration <min>', help: 'Hosted sandbox duration in minutes (default 60, maximum 1440).' },
      { name: '--model <provider/model>', help: 'Optional hosted model override.' },
      { name: '--reasoning-effort <level>', help: 'Optional hosted model reasoning-effort override.' },
      { name: '--title <title>', help: 'Optional hosted run title.' },
      { name: '--tail', help: 'Follow the hosted run until it reaches a terminal state.' },
      { name: '--json', help: 'Emit the machine-readable session payload.' },
    ],
    examples: [
      'orizu session start',
      'orizu session start --project highlight/hip --json',
      'orizu session start --hosted --task-file ./task.md --project highlight/hip --duration 90',
    ],
  },
  {
    path: ['session', 'status'],
    usage: 'orizu session status [--session <id> | --status active|ended] [--workspace <dir>] [--json]',
    summary:
      'Inspect one session by id (including run summaries and, when run inside the workbench clone, the session branch with local ahead/behind vs origin), or list sessions for the attached workspace.',
    group: 'Sessions',
    options: [
      { name: '--session <id>', help: 'Resume by session id; does not require the original terminal.' },
      { name: '--status <status>', help: 'Filter attached-workspace sessions when --session is omitted.', choices: ['active', 'ended'] },
      { name: '--workspace <dir>', help: 'Workbench clone directory when not running from inside it.' },
      { name: '--json', help: 'Emit the machine-readable session or session-list payload.' },
    ],
    examples: ['orizu session status --session sess_123 --json', 'orizu session status --status active'],
  },
  {
    path: ['session', 'end'],
    usage: 'orizu session end --session <id> [--json]',
    summary: 'Mark a durable workspace session ended.',
    group: 'Sessions',
    options: [
      { name: '--session <id>', help: 'Session id to end.', required: true },
      { name: '--json', help: 'Emit the machine-readable ended session payload.' },
    ],
    examples: ['orizu session end --session sess_123'],
  },
  {
    path: ['session', 'finish'],
    usage: 'orizu session finish --session <id> [--project <team/project>] [--push [--message <text>]] [--workspace <dir>] [--json]',
    summary:
      'Finish a hosted session branch: no changes deletes the branch; changes create a repo_merge promotion manifest to review and approve (no GitHub PR). Warns when your local session-branch checkout has uncommitted/unpushed work; --push stages, commits, and pushes it first.',
    group: 'Sessions',
    options: [
      { name: '--session <id>', help: 'Session id whose branch to finish.', required: true },
      { name: '--project <team/project>', help: 'Project scope for the manifest when the session is not already project-scoped.' },
      { name: '--push', help: 'Opt-in: stage, commit, and push local session-branch work before finishing (raw git stays the default workflow).' },
      { name: '--message <text>', help: 'Commit message for --push (a default is used when omitted).' },
      { name: '--workspace <dir>', help: 'Workbench clone directory when not running from inside it.' },
      { name: '--json', help: 'Emit the machine-readable outcome (no-changes or the created manifest).' },
    ],
    examples: ['orizu session finish --session sess_123', 'orizu session finish --session sess_123 --push --message "tune judge prompt"'],
  },
  {
    path: ['run', 'start'],
    usage: 'orizu run start --session <id> --title <title> [--project <team/project>] [--json]',
    summary: 'Start a resumable workbench run inside a workspace session and print the run id.',
    group: 'Workbench runs',
    options: [
      { name: '--session <id>', help: 'Workspace session id.', required: true },
      { name: '--title <title>', help: 'Human-readable run title.', required: true },
      { name: '--project <team/project>', help: 'Optionally override the session project scope.' },
      { name: '--json', help: 'Emit the machine-readable run payload.' },
    ],
    examples: ['orizu run start --session sess_123 --title "Fix evaluator drift" --json'],
  },
  {
    path: ['run', 'status'],
    usage: 'orizu run status --run <id> [--json]',
    summary: 'Inspect a workbench run by id, including evidence and latest event sequence.',
    group: 'Workbench runs',
    options: [
      { name: '--run <id>', help: 'Workbench run id.', required: true },
      { name: '--json', help: 'Emit the machine-readable run payload.' },
    ],
    examples: ['orizu run status --run run_123 --json'],
  },
  {
    path: ['run', 'tail'],
    usage: 'orizu run tail --run <id> [--after <seq>] [--interval <seconds>] [--once] [--json]',
    summary: 'Cursor-poll a workbench run event log; JSON mode emits one event object per line.',
    group: 'Workbench runs',
    options: [
      { name: '--run <id>', help: 'Workbench run id.', required: true },
      { name: '--after <seq>', help: 'Start after this event sequence. Defaults to 0.' },
      { name: '--interval <seconds>', help: 'Polling interval for non-terminal runs. Defaults to 2.' },
      { name: '--once', help: 'Fetch one page and exit; useful for tests and agents.' },
      { name: '--json', help: 'Emit JSONL, one event object per line.' },
    ],
    examples: ['orizu run tail --run run_123', 'orizu run tail --run run_123 --after 42 --once --json'],
  },
  {
    path: ['run', 'complete'],
    usage: 'orizu run complete --run <id> [--summary <text>] [--json]',
    summary: 'Mark a workbench run succeeded.',
    group: 'Workbench runs',
    options: [
      { name: '--run <id>', help: 'Workbench run id.', required: true },
      { name: '--summary <text>', help: 'Optional note stored in the run summary.' },
      { name: '--json', help: 'Emit the machine-readable run payload.' },
    ],
    examples: ['orizu run complete --run run_123 --summary "All gates passed"'],
  },
  {
    path: ['run', 'fail'],
    usage: 'orizu run fail --run <id> [--summary <text>] [--json]',
    summary: 'Mark a workbench run failed.',
    group: 'Workbench runs',
    options: [
      { name: '--run <id>', help: 'Workbench run id.', required: true },
      { name: '--summary <text>', help: 'Optional note stored in the run summary.' },
      { name: '--json', help: 'Emit the machine-readable run payload.' },
    ],
    examples: ['orizu run fail --run run_123 --summary "Lint failed"'],
  },
  {
    path: ['run', 'cancel'],
    usage: 'orizu run cancel --run <id> [--summary <text>] [--json]',
    summary: 'Mark a workbench run cancelled.',
    group: 'Workbench runs',
    options: [
      { name: '--run <id>', help: 'Workbench run id.', required: true },
      { name: '--summary <text>', help: 'Optional note stored in the run summary.' },
      { name: '--json', help: 'Emit the machine-readable run payload.' },
    ],
    examples: ['orizu run cancel --run run_123 --summary "Superseded by run_456"'],
  },
  {
    path: ['connectors', 'status'],
    usage: 'orizu connectors [status] [--project <team/project>] [--json]',
    summary: 'Show project connector readiness (configured/missing/stale/unauthorized/unsupported/unknown) derived read-only from stored integration state. Secrets are always redacted.',
    group: 'Connectors',
    options: [
      { name: '--project <team/project>', help: 'Project whose connector readiness to inspect.' },
      { name: '--json', help: 'Emit the machine-readable connector readiness payload.' },
    ],
    examples: ['orizu connectors', 'orizu connectors status --project highlight/hip --json'],
  },
  {
    path: ['manifests', 'list'],
    usage: 'orizu manifests list [--project <team/project>] [--status <status>] [--json]',
    summary: 'List promotion manifests for a project, newest first, optionally filtered by status.',
    group: 'Promotion manifests',
    options: [
      { name: '--project <team/project>', help: 'Project whose manifests to list.' },
      { name: '--status <status>', help: 'Filter by status.', choices: ['draft', 'pending_approval', 'approved', 'applied', 'rejected'] },
      { name: '--json', help: 'Emit the machine-readable manifest list.' },
    ],
    examples: ['orizu manifests list --project highlight/hip --status pending_approval'],
  },
  {
    path: ['manifests', 'show'],
    usage: 'orizu manifests show <id> [--json]',
    summary: 'Show one promotion manifest, including current/proposed state, evidence, outcome, and approver.',
    group: 'Promotion manifests',
    options: [
      { name: '--json', help: 'Emit the machine-readable manifest payload.' },
    ],
    examples: ['orizu manifests show manifest_123 --json'],
  },
  {
    path: ['manifests', 'approve'],
    usage: 'orizu manifests approve <id> [--json]',
    summary: 'Approve a draft or pending_approval manifest; records the approver principal separately from the author.',
    group: 'Promotion manifests',
    options: [
      { name: '--json', help: 'Emit the machine-readable manifest payload.' },
    ],
    examples: ['orizu manifests approve manifest_123'],
  },
  {
    path: ['manifests', 'reject'],
    usage: 'orizu manifests reject <id> [--json]',
    summary: 'Reject a manifest so it can no longer be applied.',
    group: 'Promotion manifests',
    options: [
      { name: '--json', help: 'Emit the machine-readable manifest payload.' },
    ],
    examples: ['orizu manifests reject manifest_123'],
  },
  {
    path: ['manifests', 'apply'],
    usage: 'orizu manifests apply <id> [--json]',
    summary: 'Apply an approved manifest. Idempotent: re-applying returns the stored outcome with no second effect. v0 records the outcome and links evidence; content promotion still flows through the primitive commands.',
    group: 'Promotion manifests',
    options: [
      { name: '--json', help: 'Emit the machine-readable manifest payload.' },
    ],
    examples: ['orizu manifests apply manifest_123 --json'],
  },
]

function groupByName(name: string): CliGroupDoc | undefined {
  return GROUPS.find(group => group.name === name)
}

function commandKey(path: string[]): string {
  return path.join(' ')
}

export function findCommandDoc(args: string[]): CliCommandDoc | undefined {
  const key = commandKey(args)
  return COMMAND_DOCS.find(doc =>
    commandKey(doc.path) === key ||
    doc.aliases?.some(alias => commandKey(alias) === key)
  )
}

export function commandDocsWithPrefix(args: string[]): CliCommandDoc[] {
  if (args.length === 0) {
    return COMMAND_DOCS
  }

  return COMMAND_DOCS.filter(doc =>
    args.every((part, index) => doc.path[index] === part) &&
    doc.path.length > args.length
  )
}

function formatRows(rows: Array<[string, string]>, indent = '  '): string[] {
  const width = Math.max(...rows.map(row => row[0].length))
  return rows.map(([left, right]) => `${indent}${left.padEnd(width)}  ${right}`)
}

export function renderRootHelp(): string {
  const lines: string[] = [
    'orizu',
    '',
    'Usage:',
    '  orizu [global options] <command> [options]',
    '  orizu help <command>',
    '',
    'Global options:',
    ...formatRows(GLOBAL_OPTIONS as Array<[string, string]>),
    '',
    'Commands:',
  ]

  for (const group of GROUPS) {
    const docs = COMMAND_DOCS.filter(doc => doc.group === group.name)
    if (docs.length === 0) {
      continue
    }

    lines.push(``, `  ${group.name}:`)
    for (const doc of docs) {
      lines.push(`    ${doc.usage}`)
    }
  }

  lines.push(
    '',
    'Examples:',
    '  orizu install-skill --target codex-user --yes',
    '  orizu apps preview --file ./App.tsx --input-schema ./input.json --output-schema ./output.json --sample-row ./row.json --screenshot ./preview.png',
    '  orizu tasks create --project core/evals --dataset <datasetId> --app <appId> --title "Review"',
    '  orizu tasks publish --task <taskId> --assignees <userId1,userId2>',
    '',
    'More:',
    '  orizu <group> --help',
    '  orizu <command> --help',
    '  orizu capabilities --json',
    '  https://docs.orizu.ai'
  )

  return lines.join('\n')
}

export function renderGroupHelp(args: string[]): string {
  const docs = commandDocsWithPrefix(args)
  const label = commandKey(args)
  const group = docs.length > 0 ? groupByName(docs[0].group) : undefined
  const lines = [
    `orizu ${label}`,
    '',
    group?.summary || `Commands under ${label}.`,
    '',
    'Usage:',
    `  orizu ${label} <command> [options]`,
    '',
    'Commands:',
    ...docs.map(doc => `  ${doc.usage}`),
    '',
    'More:',
    `  orizu ${label} <command> --help`,
  ]

  return lines.join('\n')
}

export function renderCommandHelp(doc: CliCommandDoc): string {
  const lines = [
    commandKey(doc.path),
    '',
    doc.summary,
    '',
    'Usage:',
    `  ${doc.usage}`,
  ]

  if (doc.aliases?.length) {
    lines.push('', 'Aliases:', ...doc.aliases.map(alias => `  orizu ${commandKey(alias)}`))
  }

  if (doc.options?.length) {
    lines.push('', 'Options:')
    for (const option of doc.options) {
      const suffix = option.choices?.length ? ` Choices: ${option.choices.join(', ')}.` : ''
      lines.push(`  ${option.name}${option.required ? ' (required)' : ''}${option.repeatable ? ' (repeatable)' : ''}`)
      lines.push(`      ${option.help}${suffix}`)
    }
  }

  if (doc.examples?.length) {
    lines.push('', 'Examples:', ...doc.examples.map(example => `  ${example}`))
  }

  return lines.join('\n')
}

export function renderHelpForArgs(args: string[]): string {
  if (args.length === 0) {
    return renderRootHelp()
  }

  const doc = findCommandDoc(args)
  if (doc) {
    return renderCommandHelp(doc)
  }

  const groupDocs = commandDocsWithPrefix(args)
  if (groupDocs.length > 0) {
    return renderGroupHelp(args)
  }

  return renderRootHelp()
}

export function getCapabilities(version: string) {
  return {
    name: 'orizu',
    version,
    globalOptions: GLOBAL_OPTIONS.map(([name, help]) => ({ name, help })),
    commands: COMMAND_DOCS.map(doc => ({
      name: commandKey(doc.path),
      usage: doc.usage,
      help: doc.summary,
      group: doc.group,
      aliases: doc.aliases?.map(commandKey) || [],
      params: (doc.options || []).map(option => ({
        name: option.name,
        help: option.help,
        required: Boolean(option.required),
        repeatable: Boolean(option.repeatable),
        choices: option.choices || undefined,
      })),
    })),
  }
}
