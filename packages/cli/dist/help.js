const GLOBAL_OPTIONS = [
    ['--local', 'Use http://localhost:3000.'],
    ['--server <url>', 'Use a specific server origin, for example https://preview.example.com.'],
    ['--version, -v', 'Print the orizu CLI version.'],
    ['--help, -h', 'Show help for the root command, a group, or a specific command.'],
];
const GROUPS = [
    { name: 'Auth', summary: 'Sign in, sign out, and inspect the active CLI identity.' },
    { name: 'Agent setup', summary: 'Install the bundled Orizu coding-agent skill and inspect the CLI surface.' },
    { name: 'Teams', summary: 'Manage teams and team memberships.' },
    { name: 'Projects', summary: 'Manage projects inside teams.' },
    { name: 'Prompts and judges', summary: 'Work with versioned prompt and judge artifacts.' },
    { name: 'Scorers and runners', summary: 'Register scorers, push runnable artifacts, execute runners, and submit scores.' },
    { name: 'Optimizations', summary: 'Start, run, export, and finalize optimization runs.' },
    { name: 'Apps', summary: 'Create, preview, update, inspect, and export review apps.' },
    { name: 'Tasks', summary: 'Create review tasks, mutate task status, assign reviewers, and export labels.' },
    { name: 'Datasets', summary: 'Upload, version, split, mutate, export, lock, clone, and delete datasets.' },
];
export const COMMAND_DOCS = [
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
        path: ['install-skill'],
        usage: 'orizu install-skill [--target <target>]... [--yes] [--dry-run]',
        summary: 'Install the bundled Orizu CLI skill locally for coding agents.',
        group: 'Agent setup',
        aliases: [['skills', 'install']],
        options: [
            {
                name: '--target <target>',
                help: 'Install destination. Repeat for multiple targets.',
                repeatable: true,
                choices: ['agent-user', 'codex-project', 'claude-user', 'claude-project', 'agents-md'],
            },
            { name: '--yes', help: 'Replace an existing managed skill or AGENTS.md section without prompting.' },
            { name: '--dry-run', help: 'Show planned writes without changing files.' },
        ],
        examples: [
            'orizu install-skill --target agent-user --yes',
            'orizu install-skill --target codex-project --target agents-md',
            'orizu skills install --target claude-user --dry-run',
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
        usage: 'orizu teams members role --team <teamSlug> --email <email> --role <admin|member>',
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
        usage: 'orizu prompts list --project <team/project>',
        summary: 'List prompt artifacts in a project.',
        group: 'Prompts and judges',
    },
    {
        path: ['prompts', 'comments'],
        usage: 'orizu prompts comments <prompt-id-or-name> --project <team/project> [--label <label> | --version <id>] [--json]',
        summary: 'List prompt comment threads with open/resolved status and replies.',
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
        usage: 'orizu prompts push <dir> [--runner-version <id>] [--project <team/project>] [--parent <version-id>] [--json]',
        summary: 'Push a local prompt artifact directory as a new version.',
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
        usage: 'orizu judges list --project <team/project>',
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
        usage: 'orizu judges push <dir> [--runner-version <id>] [--project <team/project>] [--parent <version-id>] [--json]',
        summary: 'Push a local judge artifact directory as a new version.',
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
        path: ['runners', 'exec'],
        usage: 'orizu runners exec (--prompt <prompt-version-id> | --prompt-version <id> --runner-version <id> | --scorer-version <id>) --dataset-version <id> --split-set <id-or-name> --split <name> [--runner-dir <dir>] --out <results.jsonl|results.jsonl.gz>',
        summary: 'Execute a runner locally against a dataset split and write row results.',
        group: 'Scorers and runners',
    },
    {
        path: ['optimizers', 'push'],
        usage: 'orizu optimizers push <dir> [--project <team/project>] [--name <name>] [--label <label>] [--json]',
        summary: 'Push a local optimizer artifact directory.',
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
        usage: 'orizu optimizations run-gepa --project <team/project> --optimizer-version-id <id> --candidate-version-id <id> --runner-version-id <id> --candidate-runner-dir <dir> --scorer-version-id <id> --scorer-runner-version-id <id> --scorer-runner-dir <dir> --dataset-version-id <id> --split-set-id <id> [--train-split train] [--val-split validation] [--log-dir logs]',
        summary: 'Run the bundled GEPA-style optimizer locally and stream events.',
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
        usage: 'orizu tasks create --project <team/project> --dataset <datasetId> --app <appId> --title <title> [--assignees <userIdOrEmail1,userIdOrEmail2>] [--publish] [--version <n>] [--instructions <text>] [--labels-per-item <n>] [--json]',
        summary: 'Create a draft review task by default, or publish immediately with --publish and assignees.',
        group: 'Tasks',
    },
    {
        path: ['tasks', 'publish'],
        usage: 'orizu tasks publish --task <taskId> --assignees <userId1,userId2> [--json]',
        summary: 'Publish an approved draft task and assign reviewers.',
        group: 'Tasks',
    },
    {
        path: ['tasks', 'assign'],
        usage: 'orizu tasks assign --task <taskId> --assignees <userId1,userId2>',
        summary: 'Assign a task to canonical user IDs.',
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
];
function groupByName(name) {
    return GROUPS.find(group => group.name === name);
}
function commandKey(path) {
    return path.join(' ');
}
export function findCommandDoc(args) {
    const key = commandKey(args);
    return COMMAND_DOCS.find(doc => commandKey(doc.path) === key ||
        doc.aliases?.some(alias => commandKey(alias) === key));
}
export function commandDocsWithPrefix(args) {
    if (args.length === 0) {
        return COMMAND_DOCS;
    }
    return COMMAND_DOCS.filter(doc => args.every((part, index) => doc.path[index] === part) &&
        doc.path.length > args.length);
}
function formatRows(rows, indent = '  ') {
    const width = Math.max(...rows.map(row => row[0].length));
    return rows.map(([left, right]) => `${indent}${left.padEnd(width)}  ${right}`);
}
export function renderRootHelp() {
    const lines = [
        'orizu',
        '',
        'Usage:',
        '  orizu [global options] <command> [options]',
        '  orizu help <command>',
        '',
        'Global options:',
        ...formatRows(GLOBAL_OPTIONS),
        '',
        'Commands:',
    ];
    for (const group of GROUPS) {
        const docs = COMMAND_DOCS.filter(doc => doc.group === group.name);
        if (docs.length === 0) {
            continue;
        }
        lines.push(``, `  ${group.name}:`);
        for (const doc of docs) {
            lines.push(`    ${doc.usage}`);
        }
    }
    lines.push('', 'Examples:', '  orizu install-skill --target agent-user --yes', '  orizu apps preview --file ./App.tsx --input-schema ./input.json --output-schema ./output.json --sample-row ./row.json --screenshot ./preview.png', '  orizu tasks create --project core/evals --dataset <datasetId> --app <appId> --title "Review"', '  orizu tasks publish --task <taskId> --assignees <userId1,userId2>', '', 'More:', '  orizu <group> --help', '  orizu <command> --help', '  orizu capabilities --json', '  https://docs.orizu.ai');
    return lines.join('\n');
}
export function renderGroupHelp(args) {
    const docs = commandDocsWithPrefix(args);
    const label = commandKey(args);
    const group = docs.length > 0 ? groupByName(docs[0].group) : undefined;
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
    ];
    return lines.join('\n');
}
export function renderCommandHelp(doc) {
    const lines = [
        commandKey(doc.path),
        '',
        doc.summary,
        '',
        'Usage:',
        `  ${doc.usage}`,
    ];
    if (doc.aliases?.length) {
        lines.push('', 'Aliases:', ...doc.aliases.map(alias => `  orizu ${commandKey(alias)}`));
    }
    if (doc.options?.length) {
        lines.push('', 'Options:');
        for (const option of doc.options) {
            const suffix = option.choices?.length ? ` Choices: ${option.choices.join(', ')}.` : '';
            lines.push(`  ${option.name}${option.required ? ' (required)' : ''}${option.repeatable ? ' (repeatable)' : ''}`);
            lines.push(`      ${option.help}${suffix}`);
        }
    }
    if (doc.examples?.length) {
        lines.push('', 'Examples:', ...doc.examples.map(example => `  ${example}`));
    }
    return lines.join('\n');
}
export function renderHelpForArgs(args) {
    if (args.length === 0) {
        return renderRootHelp();
    }
    const doc = findCommandDoc(args);
    if (doc) {
        return renderCommandHelp(doc);
    }
    const groupDocs = commandDocsWithPrefix(args);
    if (groupDocs.length > 0) {
        return renderGroupHelp(args);
    }
    return renderRootHelp();
}
export function getCapabilities(version) {
    return {
        name: 'orizu',
        version,
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
    };
}
