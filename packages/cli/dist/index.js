#!/usr/bin/env node
import { createHash, randomBytes } from 'crypto';
import { basename } from 'path';
import { createServer } from 'http';
import { readFileSync, statSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { clearServerCredentials, getServerCredentials, saveServerCredentials } from './credentials.js';
import { parseDatasetFile } from './file-parser.js';
import { parseDatasetReference } from './dataset-download.js';
import { parseGlobalFlags } from './global-flags.js';
import { authedFetch, getBaseUrl, resolveLoginBaseUrl, setGlobalFlags } from './http.js';
import { formatTaskCreateError } from './task-create-error.js';
function printUsage() {
    console.log(`orizu global options:\n\n  --local                 Use http://localhost:3000\n  --server <url>          Use a specific server origin (for example: https://preview.example.com)\n\norizu commands:\n\n  orizu login\n  orizu logout\n  orizu whoami\n  orizu teams list\n  orizu teams create [--name <name>]\n  orizu teams members list [--team <teamSlug>]\n  orizu teams members add --email <email> [--team <teamSlug>]\n  orizu teams members remove --email <email> [--team <teamSlug>]\n  orizu teams members role --team <teamSlug> --email <email> --role <admin|member>\n  orizu projects list [--team <teamSlug>]\n  orizu projects create --name <name> [--team <teamSlug>]\n  orizu apps list [--project <team/project>]\n  orizu apps create --project <team/project> --name <name> --dataset <datasetId> --file <path> --input-schema <json-path> --output-schema <json-path> [--component <name>]\n  orizu apps update [--app <appId>] [--project <team/project>] --file <path> --input-schema <json-path> --output-schema <json-path> [--component <name>]\n  orizu apps link-dataset --dataset <datasetId> [--app <appId>] [--project <team/project>] [--version <n>]\n  orizu apps detail --app <appId> [--project <team/project>] [--json]\n  orizu tasks list [--project <team/project>]\n  orizu tasks create --project <team/project> --dataset <datasetId> --app <appId> --title <title> --assignees <userIdOrEmail1,userIdOrEmail2> [--version <n>] [--instructions <text>] [--labels-per-item <n>] [--json]\n  orizu tasks assign --task <taskId> --assignees <userId1,userId2>\n  orizu tasks status --task <taskId> [--json]\n  orizu tasks pause --task <taskId>\n  orizu tasks unpause --task <taskId>\n  orizu datasets upload --file <path> [--project <team/project>] [--name <name>]\n  orizu datasets download [--dataset <datasetId|datasetUrl>] [--project <team/project>] [--format <csv|json|jsonl>] [--out <path>]\n  orizu datasets append [--dataset <datasetId|datasetUrl>] [--project <team/project>] --file <path>\n  orizu datasets edit-rows [--dataset <datasetId|datasetUrl>] [--project <team/project>] --file <path>\n  orizu datasets delete-rows [--dataset <datasetId|datasetUrl>] [--project <team/project>] --row-ids <id1,id2>\n  orizu datasets lock [--dataset <datasetId|datasetUrl>] [--project <team/project>] [--reason <text>]\n  orizu datasets clone [--dataset <datasetId|datasetUrl>] [--project <team/project>] [--name <name>]\n  orizu tasks export [--task <taskId>] [--format <csv|json|jsonl>] [--out <path>]`);
}
let cliArgs = process.argv.slice(2);
function getArg(name) {
    const index = cliArgs.indexOf(name);
    if (index === -1 || index + 1 >= cliArgs.length) {
        return null;
    }
    return cliArgs[index + 1];
}
function isInteractiveTerminal() {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
function hasArg(name) {
    return cliArgs.includes(name);
}
function expandHomePath(path) {
    if (path.startsWith('~/')) {
        const home = process.env.HOME || '';
        return `${home}/${path.slice(2)}`;
    }
    return path;
}
function createCodeVerifier() {
    return randomBytes(32).toString('base64url');
}
function createCodeChallenge(verifier) {
    return createHash('sha256').update(verifier).digest('base64url');
}
function openInBrowser(url) {
    const platform = process.platform;
    if (platform === 'darwin') {
        spawn('open', [url], {
            detached: true,
            stdio: 'ignore',
        }).unref();
        return;
    }
    if (platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', url], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        }).unref();
        return;
    }
    spawn('xdg-open', [url], {
        detached: true,
        stdio: 'ignore',
    }).unref();
}
function formatTerminalLink(url) {
    if (!isInteractiveTerminal()) {
        return url;
    }
    return `\u001B]8;;${url}\u0007${url}\u001B]8;;\u0007`;
}
async function parseJsonResponse(response, context) {
    const contentType = response.headers.get('content-type') || '';
    const rawBody = await response.text();
    if (!contentType.includes('application/json')) {
        throw new Error(`${context} returned non-JSON response (status ${response.status}). ` +
            `Body preview: ${rawBody.slice(0, 180)}`);
    }
    try {
        return JSON.parse(rawBody);
    }
    catch {
        throw new Error(`${context} returned invalid JSON (status ${response.status}). ` +
            `Body preview: ${rawBody.slice(0, 180)}`);
    }
}
async function promptSelect(title, items, label, options) {
    if (items.length === 0) {
        throw new Error(`No options available for ${title.toLowerCase()}`);
    }
    if (!isInteractiveTerminal()) {
        throw new Error(`${title} selection requires interactive terminal. Provide flags explicitly instead.`);
    }
    if (items.length === 1 && !options?.forcePrompt) {
        return items[0];
    }
    console.log(`\n${title}`);
    items.forEach((item, index) => {
        console.log(`  ${index + 1}. ${label(item, index)}`);
    });
    const rl = createInterface({ input, output });
    try {
        while (true) {
            const answer = (await rl.question('Choose a number: ')).trim();
            const chosenIndex = Number(answer);
            if (Number.isInteger(chosenIndex) && chosenIndex >= 1 && chosenIndex <= items.length) {
                return items[chosenIndex - 1];
            }
            console.log('Invalid selection. Enter a valid number from the list.');
        }
    }
    finally {
        rl.close();
    }
}
async function fetchTeams() {
    const response = await authedFetch('/api/cli/teams');
    if (!response.ok) {
        throw new Error(`Failed to fetch teams: ${await response.text()}`);
    }
    const data = await parseJsonResponse(response, 'Teams list');
    return data.teams;
}
async function fetchProjects(teamSlug) {
    const query = teamSlug ? `?teamSlug=${encodeURIComponent(teamSlug)}` : '';
    const response = await authedFetch(`/api/cli/projects${query}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch projects: ${await response.text()}`);
    }
    const data = await parseJsonResponse(response, 'Projects list');
    return data.projects;
}
async function fetchTasks(project) {
    const query = project ? `?project=${encodeURIComponent(project)}` : '';
    const response = await authedFetch(`/api/cli/tasks${query}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch tasks: ${await response.text()}`);
    }
    const data = await parseJsonResponse(response, 'Tasks list');
    return data.tasks;
}
async function fetchApps(project) {
    const response = await authedFetch(`/api/cli/apps?project=${encodeURIComponent(project)}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch apps: ${await response.text()}`);
    }
    const data = await parseJsonResponse(response, 'Apps list');
    return data.apps;
}
async function fetchDatasets(project) {
    const response = await authedFetch(`/api/cli/datasets?project=${encodeURIComponent(project)}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch datasets: ${await response.text()}`);
    }
    const data = await parseJsonResponse(response, 'Datasets list');
    return data.datasets;
}
async function fetchTeamMembers(teamSlug) {
    const response = await authedFetch(`/api/cli/teams/${encodeURIComponent(teamSlug)}/members`);
    if (!response.ok) {
        throw new Error(`Failed to fetch team members: ${await response.text()}`);
    }
    const data = await parseJsonResponse(response, 'Team members list');
    return data.members;
}
async function resolveProjectSlug(projectArg) {
    const teams = await fetchTeams();
    if (teams.length === 0) {
        throw new Error('No accessible teams found for this user.');
    }
    if (!projectArg) {
        const team = await promptSelect('Select a team', teams, teamOption => `${teamOption.name} (${teamOption.slug})`, { forcePrompt: true });
        const projects = await fetchProjects(team.slug);
        const project = await promptSelect(`Select a project in ${team.slug}`, projects, projectOption => `${projectOption.name} (${projectOption.teamSlug}/${projectOption.slug})`, { forcePrompt: true });
        return `${project.teamSlug}/${project.slug}`;
    }
    const segments = projectArg.split('/');
    if (segments.length !== 2 || !segments[0] || !segments[1]) {
        throw new Error('Project must be in format teamSlug/projectSlug');
    }
    const [teamSlug, projectSlug] = segments;
    const matchedTeam = teams.find(team => team.slug === teamSlug);
    if (!matchedTeam) {
        console.error(`Team '${teamSlug}' not found in your accessible teams.`);
        const selectedTeam = await promptSelect('Select a team', teams, team => `${team.name} (${team.slug})`);
        const projects = await fetchProjects(selectedTeam.slug);
        const selectedProject = await promptSelect(`Select a project in ${selectedTeam.slug}`, projects, project => `${project.name} (${project.teamSlug}/${project.slug})`);
        return `${selectedProject.teamSlug}/${selectedProject.slug}`;
    }
    const projects = await fetchProjects(teamSlug);
    const matchedProject = projects.find(project => project.slug === projectSlug);
    if (!matchedProject) {
        console.error(`Project '${projectSlug}' not found in team '${teamSlug}'.`);
        const selectedProject = await promptSelect(`Select a project in ${teamSlug}`, projects, project => `${project.name} (${project.teamSlug}/${project.slug})`);
        return `${selectedProject.teamSlug}/${selectedProject.slug}`;
    }
    return `${teamSlug}/${projectSlug}`;
}
async function selectTaskIdInteractively() {
    const team = await promptSelect('Select a team', await fetchTeams(), item => `${item.name} (${item.slug})`, { forcePrompt: true });
    const project = await promptSelect(`Select a project in ${team.slug}`, await fetchProjects(team.slug), item => `${item.name} (${item.teamSlug}/${item.slug})`, { forcePrompt: true });
    const tasks = await fetchTasks(`${project.teamSlug}/${project.slug}`);
    const task = await promptSelect(`Select a task in ${project.teamSlug}/${project.slug}`, tasks, item => `${item.title} [${item.status}] (${item.id})`, { forcePrompt: true });
    return task.id;
}
async function selectAppIdInteractively(projectArg) {
    let project = projectArg;
    if (!project) {
        project = await resolveProjectSlug(null);
    }
    const apps = await fetchApps(project);
    const app = await promptSelect(`Select an app in ${project}`, apps, item => `${item.name} (id=${item.id}, v${item.currentVersionNum})`, { forcePrompt: true });
    return {
        appId: app.id,
        project,
    };
}
async function selectDatasetInteractively(projectArg) {
    let project = projectArg;
    if (!project) {
        project = await resolveProjectSlug(null);
    }
    const datasets = await fetchDatasets(project);
    const dataset = await promptSelect(`Select a dataset in ${project}`, datasets, item => `${item.name} (id=${item.id}, rows=${item.rowCount})`, { forcePrompt: true });
    return {
        datasetId: dataset.id,
        project,
    };
}
function printTeams(teams) {
    if (teams.length === 0) {
        console.log('No teams found.');
        return;
    }
    const rows = teams.map(team => ({
        slug: team.slug,
        name: team.name || '-',
        role: team.role || '-',
    }));
    const slugWidth = Math.max('TEAM SLUG'.length, ...rows.map(row => row.slug.length));
    const nameWidth = Math.max('TEAM NAME'.length, ...rows.map(row => row.name.length));
    const roleWidth = Math.max('ROLE'.length, ...rows.map(row => row.role.length));
    console.log(`${'TEAM SLUG'.padEnd(slugWidth)}  ${'TEAM NAME'.padEnd(nameWidth)}  ${'ROLE'.padEnd(roleWidth)}`);
    console.log(`${'-'.repeat(slugWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(roleWidth)}`);
    rows.forEach(row => {
        console.log(`${row.slug.padEnd(slugWidth)}  ${row.name.padEnd(nameWidth)}  ${row.role.padEnd(roleWidth)}`);
    });
}
function printProjects(projects) {
    if (projects.length === 0) {
        console.log('No projects found.');
        return;
    }
    const rows = projects.map(project => ({
        project: `${project.teamSlug}/${project.slug}`,
        name: project.name || '-',
        role: project.role || '-',
    }));
    const projectWidth = Math.max('TEAM/PROJECT'.length, ...rows.map(row => row.project.length));
    const nameWidth = Math.max('PROJECT NAME'.length, ...rows.map(row => row.name.length));
    const roleWidth = Math.max('ROLE'.length, ...rows.map(row => row.role.length));
    console.log(`${'TEAM/PROJECT'.padEnd(projectWidth)}  ${'PROJECT NAME'.padEnd(nameWidth)}  ${'ROLE'.padEnd(roleWidth)}`);
    console.log(`${'-'.repeat(projectWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(roleWidth)}`);
    rows.forEach(row => {
        console.log(`${row.project.padEnd(projectWidth)}  ${row.name.padEnd(nameWidth)}  ${row.role.padEnd(roleWidth)}`);
    });
}
function printTasks(tasks) {
    if (tasks.length === 0) {
        console.log('No tasks found.');
        return;
    }
    const rows = tasks.map(task => ({
        id: task.id,
        name: task.title || '-',
        status: task.status || '-',
        project: task.teamSlug && task.projectSlug
            ? `${task.teamSlug}/${task.projectSlug}`
            : 'unknown-project',
    }));
    const idWidth = Math.max('TASK ID'.length, ...rows.map(row => row.id.length));
    const nameWidth = Math.max('TASK NAME'.length, ...rows.map(row => row.name.length));
    const statusWidth = Math.max('STATUS'.length, ...rows.map(row => row.status.length));
    console.log(`${'TASK ID'.padEnd(idWidth)}  ${'TASK NAME'.padEnd(nameWidth)}  ${'STATUS'.padEnd(statusWidth)}  TEAM/PROJECT`);
    console.log(`${'-'.repeat(idWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(statusWidth)}  ------------`);
    rows.forEach(row => {
        console.log(`${row.id.padEnd(idWidth)}  ${row.name.padEnd(nameWidth)}  ${row.status.padEnd(statusWidth)}  ${row.project}`);
    });
}
function printApps(apps) {
    if (apps.length === 0) {
        console.log('No apps found.');
        return;
    }
    const rows = apps.map(app => ({
        id: app.id,
        name: app.name || '-',
        version: `v${app.currentVersionNum || 1}`,
    }));
    const idWidth = Math.max('APP ID'.length, ...rows.map(row => row.id.length));
    const nameWidth = Math.max('APP NAME'.length, ...rows.map(row => row.name.length));
    const versionWidth = Math.max('VERSION'.length, ...rows.map(row => row.version.length));
    console.log(`${'APP ID'.padEnd(idWidth)}  ${'APP NAME'.padEnd(nameWidth)}  ${'VERSION'.padEnd(versionWidth)}`);
    console.log(`${'-'.repeat(idWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(versionWidth)}`);
    rows.forEach(row => {
        console.log(`${row.id.padEnd(idWidth)}  ${row.name.padEnd(nameWidth)}  ${row.version.padEnd(versionWidth)}`);
    });
}
function printTeamMembers(members) {
    if (members.length === 0) {
        console.log('No team members found.');
        return;
    }
    const rows = members.map(member => ({
        id: member.id,
        userId: member.user_id || '-',
        email: member.email || '-',
        role: member.role || '-',
    }));
    const idWidth = Math.max('MEMBER ID'.length, ...rows.map(row => row.id.length));
    const userIdWidth = Math.max('USER ID'.length, ...rows.map(row => row.userId.length));
    const emailWidth = Math.max('EMAIL'.length, ...rows.map(row => row.email.length));
    const roleWidth = Math.max('ROLE'.length, ...rows.map(row => row.role.length));
    console.log(`${'MEMBER ID'.padEnd(idWidth)}  ${'USER ID'.padEnd(userIdWidth)}  ${'EMAIL'.padEnd(emailWidth)}  ${'ROLE'.padEnd(roleWidth)}`);
    console.log(`${'-'.repeat(idWidth)}  ${'-'.repeat(userIdWidth)}  ${'-'.repeat(emailWidth)}  ${'-'.repeat(roleWidth)}`);
    rows.forEach(row => {
        console.log(`${row.id.padEnd(idWidth)}  ${row.userId.padEnd(userIdWidth)}  ${row.email.padEnd(emailWidth)}  ${row.role.padEnd(roleWidth)}`);
    });
}
function printTaskStatusSummary(data) {
    const task = data.task;
    console.log(`Task: ${task.title} (${task.id})`);
    console.log(`Status: ${task.status}`);
    console.log(`Project: ${task.teamSlug}/${task.projectSlug}`);
    console.log(`Progress: ${task.progressPercentage}%`);
    console.log(`Counts: completed=${task.counts.completed}, in_progress=${task.counts.inProgress}, pending=${task.counts.pending}, skipped=${task.counts.skipped}`);
    console.log(`Required assignments: ${task.totalRequiredAssignments} (${task.datasetRowCount} rows x ${task.requiredAssignmentsPerRow})`);
    if (task.assignees.length > 0) {
        console.log('\nAssignees');
        task.assignees.forEach(assignee => {
            console.log(`  ${assignee.email}: total=${assignee.total}, completed=${assignee.completed}, in_progress=${assignee.inProgress}, pending=${assignee.pending}, skipped=${assignee.skipped}`);
        });
    }
}
const DEFAULT_AUTH_CALLBACK_PORT = 43123;
function resolveAuthCallbackPort() {
    const envPort = process.env.ORIZU_AUTH_PORT;
    if (!envPort) {
        return DEFAULT_AUTH_CALLBACK_PORT;
    }
    const parsed = parseInt(envPort, 10);
    if (Number.isNaN(parsed) || parsed < 1024 || parsed > 65535) {
        throw new Error(`Invalid ORIZU_AUTH_PORT: '${envPort}'. Must be a number between 1024 and 65535.`);
    }
    return parsed;
}
async function login() {
    const baseUrl = resolveLoginBaseUrl();
    const codeVerifier = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);
    const callbackPort = resolveAuthCallbackPort();
    const callbackCode = await new Promise((resolve, reject) => {
        const server = createServer((request, response) => {
            try {
                const url = new URL(request.url || '/', `http://127.0.0.1:${callbackPort}`);
                const code = url.searchParams.get('code');
                if (!code) {
                    response.statusCode = 400;
                    response.end('Missing code');
                    return;
                }
                response.statusCode = 200;
                response.setHeader('content-type', 'text/html');
                response.end('<html><body><h3>CLI login complete. You can close this tab.</h3></body></html>');
                server.close();
                resolve(code);
            }
            catch (error) {
                server.close();
                reject(error);
            }
        });
        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                reject(new Error(`Port ${callbackPort} is already in use. Set ORIZU_AUTH_PORT to a different port (1024–65535) and retry.`));
            }
            else {
                reject(error);
            }
        });
        server.listen(callbackPort, '127.0.0.1', async () => {
            try {
                const redirectUri = `http://127.0.0.1:${callbackPort}/callback`;
                const response = await fetch(`${baseUrl}/api/cli/auth/start`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ codeChallenge, redirectUri }),
                });
                if (!response.ok) {
                    const text = await response.text();
                    server.close();
                    reject(new Error(`Failed to start login: ${text}`));
                    return;
                }
                const { authorizeUrl } = await parseJsonResponse(response, 'CLI auth start');
                console.log(`Opening browser for login: ${authorizeUrl}`);
                openInBrowser(authorizeUrl);
            }
            catch (error) {
                server.close();
                reject(error);
            }
        });
    });
    const exchangeResponse = await fetch(`${baseUrl}/api/cli/auth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: callbackCode, codeVerifier }),
    });
    if (!exchangeResponse.ok) {
        const text = await exchangeResponse.text();
        throw new Error(`Failed to exchange auth code: ${text}`);
    }
    const loginData = await parseJsonResponse(exchangeResponse, 'CLI auth exchange');
    saveServerCredentials(baseUrl, {
        accessToken: loginData.accessToken,
        refreshToken: loginData.refreshToken,
        expiresAt: loginData.expiresAt,
    });
    console.log(`Logged in as ${loginData.user.email ?? loginData.user.id}`);
}
async function whoami() {
    const response = await authedFetch('/api/cli/auth/whoami');
    if (!response.ok) {
        throw new Error(`whoami failed: ${await response.text()}`);
    }
    const data = await response.json();
    console.log(data.user.email ?? data.user.id);
}
async function logout() {
    const baseUrl = getBaseUrl();
    const credentials = getServerCredentials(baseUrl);
    if (!credentials) {
        console.log(`Already logged out for ${baseUrl}.`);
        return;
    }
    await fetch(`${baseUrl}/api/cli/auth/logout`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
        },
    }).catch(() => undefined);
    clearServerCredentials(baseUrl);
    console.log(`Logged out from ${baseUrl}.`);
}
async function listTeams() {
    printTeams(await fetchTeams());
}
async function resolveTeamSlug(teamSlugArg) {
    if (teamSlugArg) {
        return teamSlugArg;
    }
    const team = await promptSelect('Select a team', await fetchTeams(), item => `${item.name} (${item.slug})`, { forcePrompt: true });
    return team.slug;
}
async function createTeam() {
    let name = getArg('--name');
    if (!name && isInteractiveTerminal()) {
        const rl = createInterface({ input, output });
        try {
            name = (await rl.question('Team name: ')).trim();
        }
        finally {
            rl.close();
        }
    }
    if (!name) {
        throw new Error('Usage: orizu teams create --name <name>');
    }
    const response = await authedFetch('/api/cli/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
    });
    if (!response.ok) {
        throw new Error(`Failed to create team: ${await response.text()}`);
    }
    const data = await parseJsonResponse(response, 'Team create');
    console.log(`Created team: ${data.team.name} (${data.team.slug})`);
}
async function listProjects() {
    const teamSlug = getArg('--team');
    printProjects(await fetchProjects(teamSlug || undefined));
}
async function createProject() {
    const name = getArg('--name');
    let teamSlug = getArg('--team');
    if (!name) {
        throw new Error('Usage: orizu projects create --name <name> [--team <teamSlug>]');
    }
    if (!teamSlug) {
        const team = await promptSelect('Select a team', await fetchTeams(), item => `${item.name} (${item.slug})`, { forcePrompt: true });
        teamSlug = team.slug;
    }
    const response = await authedFetch('/api/cli/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamSlug, name }),
    });
    if (!response.ok) {
        throw new Error(`Failed to create project: ${await response.text()}`);
    }
    const data = await parseJsonResponse(response, 'Project create');
    console.log(`Created project ${data.project.teamSlug}/${data.project.slug}`);
}
async function listTasks() {
    const project = getArg('--project');
    printTasks(await fetchTasks(project || undefined));
}
async function listApps() {
    const project = getArg('--project') || await resolveProjectSlug(null);
    printApps(await fetchApps(project));
}
function readSourceFile(pathArg) {
    const expandedPath = expandHomePath(pathArg);
    try {
        return readFileSync(expandedPath, 'utf-8');
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            throw new Error(`File not found: ${expandedPath}`);
        }
        throw new Error(`Failed to read file '${expandedPath}': ${error?.message || String(error)}`);
    }
}
function readJsonFile(pathArg) {
    const raw = readSourceFile(pathArg);
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('JSON root must be an object');
        }
        return parsed;
    }
    catch (error) {
        throw new Error(`Invalid JSON file '${pathArg}': ${error?.message || String(error)}`);
    }
}
async function createAppFromFile() {
    const project = getArg('--project');
    const name = getArg('--name');
    const datasetId = getArg('--dataset');
    const filePath = getArg('--file');
    const inputSchemaPath = getArg('--input-schema');
    const outputSchemaPath = getArg('--output-schema');
    const component = getArg('--component') || undefined;
    if (!project || !name || !datasetId || !filePath || !inputSchemaPath || !outputSchemaPath) {
        throw new Error('Usage: orizu apps create --project <team/project> --name <name> --dataset <datasetId> --file <path> --input-schema <json-path> --output-schema <json-path> [--component <name>]');
    }
    const sourceCode = readSourceFile(filePath);
    const inputJsonSchema = readJsonFile(inputSchemaPath);
    const outputJsonSchema = readJsonFile(outputSchemaPath);
    const response = await authedFetch('/api/cli/apps/create-from-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            projectSlug: project,
            name,
            datasetId,
            sourceCode,
            componentName: component,
            inputJsonSchema,
            outputJsonSchema,
        }),
    });
    if (!response.ok) {
        throw new Error(`Failed to create app: ${await response.text()}`);
    }
    const data = await parseJsonResponse(response, 'App create');
    console.log(`Created app ${data.app.name} (${data.app.id}) v${data.app.versionNum}`);
    if (data.warnings?.length) {
        console.log(`Warnings: ${data.warnings.join('; ')}`);
    }
}
async function updateAppFromFile() {
    const filePath = getArg('--file');
    const inputSchemaPath = getArg('--input-schema');
    const outputSchemaPath = getArg('--output-schema');
    const component = getArg('--component') || undefined;
    let appId = getArg('--app');
    const project = getArg('--project');
    if (!filePath || !inputSchemaPath || !outputSchemaPath) {
        throw new Error('Usage: orizu apps update [--app <appId>] [--project <team/project>] --file <path> --input-schema <json-path> --output-schema <json-path> [--component <name>]');
    }
    if (!appId) {
        const selected = await selectAppIdInteractively(project);
        appId = selected.appId;
    }
    const sourceCode = readSourceFile(filePath);
    const inputJsonSchema = readJsonFile(inputSchemaPath);
    const outputJsonSchema = readJsonFile(outputSchemaPath);
    const response = await authedFetch(`/api/cli/apps/${encodeURIComponent(appId)}/update-from-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            sourceCode,
            componentName: component,
            inputJsonSchema,
            outputJsonSchema,
        }),
    });
    if (!response.ok) {
        throw new Error(`Failed to update app: ${await response.text()}`);
    }
    const data = await parseJsonResponse(response, 'App update');
    console.log(`Updated app ${data.app.name} (${data.app.id}) to v${data.app.versionNum}`);
    if (data.warnings?.length) {
        console.log(`Warnings: ${data.warnings.join('; ')}`);
    }
}
async function linkAppDataset() {
    const datasetId = getArg('--dataset');
    const project = getArg('--project');
    let appId = getArg('--app');
    const versionArg = getArg('--version');
    const parsedVersionNum = versionArg ? Number(versionArg) : Number.NaN;
    const versionNum = Number.isInteger(parsedVersionNum) && parsedVersionNum > 0 ? parsedVersionNum : undefined;
    if (!datasetId) {
        throw new Error('Usage: orizu apps link-dataset --dataset <datasetId> [--app <appId>] [--project <team/project>] [--version <n>]');
    }
    if (versionArg && versionNum === undefined) {
        throw new Error('--version must be a positive integer');
    }
    if (!appId) {
        const selected = await selectAppIdInteractively(project);
        appId = selected.appId;
    }
    const response = await authedFetch(`/api/cli/apps/${encodeURIComponent(appId)}/link-dataset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            datasetId,
            versionNum,
        }),
    });
    if (!response.ok) {
        throw new Error(`Failed to link dataset: ${await response.text()}`);
    }
    const data = await parseJsonResponse(response, 'App link dataset');
    console.log(`Linked dataset ${data.linkedDataset.name} (${data.linkedDataset.id}) to app ${data.app.name} (${data.app.id}) version ${data.versionNum}`);
}
function parseCommaSeparated(value) {
    if (!value) {
        return [];
    }
    return value
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}
async function createTask() {
    const projectSlug = getArg('--project');
    const datasetId = getArg('--dataset');
    const appId = getArg('--app');
    const title = getArg('--title');
    const assignees = parseCommaSeparated(getArg('--assignees'));
    const versionArg = getArg('--version');
    const instructions = getArg('--instructions');
    const labelsPerItemArg = getArg('--labels-per-item');
    const labelsPerItem = labelsPerItemArg ? Number(labelsPerItemArg) : 1;
    const parsedVersionNum = versionArg ? Number(versionArg) : Number.NaN;
    const versionNum = Number.isInteger(parsedVersionNum) && parsedVersionNum > 0 ? parsedVersionNum : null;
    if (!projectSlug || !datasetId || !appId || !title || assignees.length === 0) {
        throw new Error('Usage: orizu tasks create --project <team/project> --dataset <datasetId> --app <appId> --title <title> --assignees <userIdOrEmail1,userIdOrEmail2> [--version <n>] [--instructions <text>] [--labels-per-item <n>] [--json]');
    }
    if (versionArg && versionNum === null) {
        throw new Error('--version must be a positive integer');
    }
    const response = await authedFetch('/api/cli/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            projectSlug,
            datasetId,
            appId,
            versionNum,
            title,
            memberIds: assignees,
            instructions,
            requiredAssignmentsPerRow: labelsPerItem,
        }),
    });
    if (!response.ok) {
        const cliError = await formatTaskCreateError(response);
        if (hasArg('--json')) {
            const payload = cliError.structuredPayload ?? { error: cliError.message };
            console.log(JSON.stringify({
                ...payload,
                httpStatus: cliError.httpStatus,
            }, null, 2));
            process.exit(1);
        }
        throw cliError;
    }
    const data = await parseJsonResponse(response, 'Task create');
    if (hasArg('--json')) {
        console.log(JSON.stringify({
            taskId: data.task.id,
            datasetId,
            versionId: data.task.versionId,
            versionNum: data.task.versionNum,
            taskUrl: `${getBaseUrl()}/d/${projectSlug}/tasks/${data.task.id}`,
            title: data.task.title,
            status: data.task.status,
            requiredAssignmentsPerRow: data.task.requiredAssignmentsPerRow,
            assignmentsCreated: data.assignmentsCreated,
            ...(data.assignmentShortfall !== undefined ? { assignmentShortfall: data.assignmentShortfall } : {}),
            ...(data.warning ? { warning: data.warning } : {}),
        }, null, 2));
        return;
    }
    const baseUrl = getBaseUrl();
    const taskUrl = `${baseUrl}/d/${projectSlug}/tasks/${data.task.id}`;
    console.log(`Created task ${data.task.title} (${data.task.id}) [${data.task.status}]` +
        `\n  Task ID:    ${data.task.id}` +
        `\n  Dataset ID: ${datasetId}` +
        `\n  Version:    v${data.task.versionNum} (${data.task.versionId})` +
        `\n  Labels/row: ${data.task.requiredAssignmentsPerRow}` +
        `\n  Assignments: ${data.assignmentsCreated}` +
        (data.warning ? `\n  Warning:    ${data.warning}` : '') +
        `\n  URL:        ${taskUrl}`);
}
async function assignTask() {
    const taskId = getArg('--task');
    const assignees = parseCommaSeparated(getArg('--assignees'));
    if (!taskId || assignees.length === 0) {
        throw new Error('Usage: orizu tasks assign --task <taskId> --assignees <userId1,userId2>');
    }
    const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberIds: assignees }),
    });
    if (!response.ok) {
        throw new Error(`Failed to assign task: ${await response.text()}`);
    }
    const data = await parseJsonResponse(response, 'Task assign');
    console.log(`Created ${data.assignmentsCreated} assignments.`);
}
async function taskStatus() {
    const taskId = getArg('--task');
    if (!taskId) {
        throw new Error('Usage: orizu tasks status --task <taskId> [--json]');
    }
    const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}/status`);
    if (!response.ok) {
        const rawBody = await response.text();
        if (hasArg('--json')) {
            let errorPayload = { error: rawBody };
            try {
                errorPayload = JSON.parse(rawBody);
            }
            catch {
                // keep raw body as error
            }
            console.log(JSON.stringify({
                ...errorPayload,
                httpStatus: response.status,
            }, null, 2));
            process.exit(1);
        }
        throw new Error(`Failed to fetch task status: ${rawBody}`);
    }
    const data = await parseJsonResponse(response, 'Task status');
    if (hasArg('--json')) {
        console.log(JSON.stringify(data, null, 2));
        return;
    }
    printTaskStatusSummary(data);
}
async function updateTaskStatus(targetStatus) {
    const taskId = getArg('--task');
    if (!taskId) {
        const verb = targetStatus === 'paused' ? 'pause' : 'unpause';
        throw new Error(`Usage: orizu tasks ${verb} --task <taskId>`);
    }
    const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: targetStatus }),
    });
    if (!response.ok) {
        const verb = targetStatus === 'paused' ? 'pause' : 'unpause';
        throw new Error(`Failed to ${verb} task: ${await response.text()}`);
    }
    const data = await parseJsonResponse(response, 'Task status update');
    const action = targetStatus === 'paused' ? 'Paused' : 'Unpaused';
    console.log(`${action} task ${data.task.id} [${data.task.status}]`);
}
async function appDetail() {
    const appId = getArg('--app');
    const project = getArg('--project');
    if (!appId) {
        throw new Error('Usage: orizu apps detail --app <appId> [--project <team/project>] [--json]');
    }
    const projectSlug = project || await resolveProjectSlug(null);
    const apps = await fetchApps(projectSlug);
    const app = apps.find(a => a.id === appId);
    if (!app) {
        throw new Error(`App '${appId}' not found in project '${projectSlug}'`);
    }
    // Re-fetch full detail from the list (it already returns full data)
    const detailResponse = await authedFetch(`/api/cli/apps?project=${encodeURIComponent(projectSlug)}`);
    if (!detailResponse.ok) {
        throw new Error(`Failed to fetch app detail: ${await detailResponse.text()}`);
    }
    const detailData = await parseJsonResponse(detailResponse, 'App detail');
    const detail = detailData.apps.find(a => a.id === appId);
    if (!detail) {
        throw new Error(`App '${appId}' not found`);
    }
    if (hasArg('--json')) {
        console.log(JSON.stringify(detail, null, 2));
        return;
    }
    console.log(`App: ${detail.name} (${detail.id})`);
    console.log(`  Project: ${detail.teamSlug}/${detail.projectSlug}`);
    if (detail.currentVersion) {
        console.log(`  Current version: v${detail.currentVersion.versionNum} (${detail.currentVersion.versionId})`);
        console.log(`  Input schema: ${detail.currentVersion.inputJsonSchema ? 'defined' : 'none'}`);
        console.log(`  Output schema: ${detail.currentVersion.outputJsonSchema ? 'defined' : 'none'}`);
    }
    else {
        console.log(`  Current version: none`);
    }
    console.log(`  Compatible datasets: ${detail.compatibleDatasetsCount}/${detail.totalDatasetsCount}`);
    if (detail.createdByEmail) {
        console.log(`  Created by: ${detail.createdByName || detail.createdByEmail}`);
    }
    console.log(`  Created: ${detail.createdAt}`);
    console.log(`  Updated: ${detail.updatedAt}`);
}
async function listTeamMembers() {
    const teamSlug = await resolveTeamSlug(getArg('--team'));
    printTeamMembers(await fetchTeamMembers(teamSlug));
}
async function addTeamMember() {
    const teamSlug = await resolveTeamSlug(getArg('--team'));
    const email = getArg('--email');
    if (!email) {
        throw new Error('Usage: orizu teams members add --email <email> [--team <teamSlug>]');
    }
    const response = await authedFetch(`/api/cli/teams/${encodeURIComponent(teamSlug)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
    });
    if (!response.ok) {
        throw new Error(`Failed to add team member: ${await response.text()}`);
    }
    const data = await parseJsonResponse(response, 'Team member add');
    console.log(`Added team member ${data.member.email} (${data.member.id})`);
}
async function removeTeamMember() {
    const teamSlug = await resolveTeamSlug(getArg('--team'));
    const email = getArg('--email');
    if (!email) {
        throw new Error('Usage: orizu teams members remove --email <email> [--team <teamSlug>]');
    }
    const members = await fetchTeamMembers(teamSlug);
    const member = members.find(item => item.email.toLowerCase() === email.toLowerCase());
    if (!member) {
        throw new Error(`No member found with email '${email}' in team '${teamSlug}'`);
    }
    const response = await authedFetch(`/api/cli/teams/${encodeURIComponent(teamSlug)}/members/${encodeURIComponent(member.id)}`, { method: 'DELETE' });
    if (!response.ok) {
        throw new Error(`Failed to remove team member: ${await response.text()}`);
    }
    console.log(`Removed team member ${member.email}`);
}
async function changeTeamMemberRole() {
    const teamSlug = getArg('--team');
    const email = getArg('--email');
    const role = getArg('--role');
    if (!teamSlug || !email || !role) {
        throw new Error('Usage: orizu teams members role --team <teamSlug> --email <email> --role <admin|member>');
    }
    if (!['admin', 'member'].includes(role)) {
        throw new Error('role must be one of: admin, member');
    }
    const members = await fetchTeamMembers(teamSlug);
    const member = members.find(item => item.email.toLowerCase() === email.toLowerCase());
    if (!member) {
        throw new Error(`No member found with email '${email}' in team '${teamSlug}'`);
    }
    const response = await authedFetch(`/api/cli/teams/${encodeURIComponent(teamSlug)}/members/${encodeURIComponent(member.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
    });
    if (!response.ok) {
        throw new Error(`Failed to update member role: ${await response.text()}`);
    }
    console.log(`Updated ${member.email} role to ${role}`);
}
async function uploadDataset() {
    const projectArg = getArg('--project');
    const fileArg = getArg('--file');
    const name = getArg('--name');
    if (!fileArg) {
        throw new Error('Usage: orizu datasets upload --file <path> [--project <team/project>] [--name <name>]');
    }
    const file = expandHomePath(fileArg);
    const project = await resolveProjectSlug(projectArg);
    const { rows, sourceType } = parseDatasetFile(file);
    const datasetName = name || basename(file);
    const response = await authedFetch('/api/cli/datasets/upload', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            projectSlug: project,
            name: datasetName,
            rows,
            sourceType,
        }),
    });
    if (!response.ok) {
        const body = await parseJsonResponse(response, 'Dataset upload');
        throw new Error(`Upload failed: ${body.error}`);
    }
    const data = await parseJsonResponse(response, 'Dataset upload');
    console.log(`Uploaded dataset ${data.dataset.name} (${data.dataset.id}) with ${data.dataset.rowCount} rows.`);
    if (data.dataset.url) {
        console.log(`View dataset: ${formatTerminalLink(data.dataset.url)}`);
    }
}
function getDatasetReferenceInput() {
    const fromFlag = getArg('--dataset');
    if (fromFlag) {
        return fromFlag;
    }
    const positional = cliArgs[2];
    if (positional && !positional.startsWith('--')) {
        return positional;
    }
    return null;
}
async function downloadDataset() {
    const projectArg = getArg('--project');
    const datasetInput = getDatasetReferenceInput();
    const format = (getArg('--format') || 'jsonl');
    const outPathArg = getArg('--out');
    if (!['csv', 'json', 'jsonl'].includes(format)) {
        throw new Error('format must be one of: csv, json, jsonl');
    }
    let datasetId;
    if (datasetInput) {
        datasetId = parseDatasetReference(datasetInput).datasetId;
    }
    else {
        const selected = await selectDatasetInteractively(projectArg);
        datasetId = selected.datasetId;
    }
    const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}/download?format=${encodeURIComponent(format)}`);
    if (!response.ok) {
        throw new Error(`Download failed: ${await response.text()}`);
    }
    const filename = outPathArg
        ? expandHomePath(outPathArg)
        : `${datasetId}.${format}`;
    const bytes = new Uint8Array(await response.arrayBuffer());
    writeFileSync(filename, bytes);
    console.log(`Saved dataset ${datasetId} (${format.toUpperCase()}) to ${filename}`);
}
const MAX_INPUT_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const APPEND_CHUNK_SIZE_ROWS = 500;
async function appendChunk(datasetId, rows) {
    const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}/rows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
    });
    if (!response.ok) {
        throw new Error(`Append failed: ${await response.text()}`);
    }
    return parseJsonResponse(response, 'Dataset append');
}
async function appendDatasetRows() {
    const projectArg = getArg('--project');
    const datasetInput = getDatasetReferenceInput();
    const fileArg = getArg('--file');
    if (!fileArg) {
        throw new Error('Usage: orizu datasets append [--dataset <datasetId|datasetUrl>] [--project <team/project>] --file <path>');
    }
    let datasetId;
    if (datasetInput) {
        datasetId = parseDatasetReference(datasetInput).datasetId;
    }
    else {
        const selected = await selectDatasetInteractively(projectArg);
        datasetId = selected.datasetId;
    }
    const file = expandHomePath(fileArg);
    const fileSizeBytes = statSync(file).size;
    if (fileSizeBytes > MAX_INPUT_FILE_SIZE_BYTES) {
        const sizeMb = (fileSizeBytes / (1024 * 1024)).toFixed(1);
        throw new Error(`Input file is ${sizeMb} MB, which exceeds the 50 MB limit. Split the file into smaller parts and append each separately.`);
    }
    const { rows } = parseDatasetFile(file);
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error('Dataset append file must contain at least one row');
    }
    if (rows.length <= APPEND_CHUNK_SIZE_ROWS) {
        const data = await appendChunk(datasetId, rows);
        console.log(`Appended ${data.appendedCount} rows to dataset ${data.dataset.name} (${data.dataset.id}). New row count: ${data.dataset.rowCount}`);
        return;
    }
    // Chunked upload for large row counts
    let totalAppended = 0;
    let lastResult = null;
    for (let offset = 0; offset < rows.length; offset += APPEND_CHUNK_SIZE_ROWS) {
        const chunk = rows.slice(offset, offset + APPEND_CHUNK_SIZE_ROWS);
        const chunkIndex = Math.floor(offset / APPEND_CHUNK_SIZE_ROWS) + 1;
        const totalChunks = Math.ceil(rows.length / APPEND_CHUNK_SIZE_ROWS);
        console.log(`Uploading chunk ${chunkIndex}/${totalChunks} (${chunk.length} rows)...`);
        const data = await appendChunk(datasetId, chunk);
        totalAppended += data.appendedCount;
        lastResult = data;
    }
    if (lastResult) {
        console.log(`Appended ${totalAppended} rows to dataset ${lastResult.dataset.name} (${lastResult.dataset.id}). New row count: ${lastResult.dataset.rowCount}`);
    }
}
async function editDatasetRows() {
    const projectArg = getArg('--project');
    const datasetInput = getDatasetReferenceInput();
    const fileArg = getArg('--file');
    if (!fileArg) {
        throw new Error('Usage: orizu datasets edit-rows [--dataset <datasetId|datasetUrl>] [--project <team/project>] --file <path>');
    }
    let datasetId;
    if (datasetInput) {
        datasetId = parseDatasetReference(datasetInput).datasetId;
    }
    else {
        const selected = await selectDatasetInteractively(projectArg);
        datasetId = selected.datasetId;
    }
    const file = expandHomePath(fileArg);
    const { rows } = parseDatasetFile(file);
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error('Dataset edit file must contain at least one row');
    }
    const normalizedRows = rows.map((row, index) => {
        if (typeof row !== 'object' || row === null || Array.isArray(row)) {
            throw new Error(`Dataset edit file rows[${index}] must be an object`);
        }
        const rowRecord = row;
        const rowId = typeof rowRecord.id === 'string' ? rowRecord.id.trim() : '';
        if (!rowId) {
            throw new Error(`Dataset edit file rows[${index}] must include a non-empty string id`);
        }
        return {
            ...rowRecord,
            id: rowId,
        };
    });
    const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}/rows`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: normalizedRows }),
    });
    if (!response.ok) {
        throw new Error(`Edit rows failed: ${await response.text()}`);
    }
    const data = await parseJsonResponse(response, 'Dataset edit rows');
    console.log(`Updated ${data.updatedCount} rows in dataset ${data.dataset.name} (${data.dataset.id}). Current row count: ${data.dataset.rowCount}`);
}
async function deleteDatasetRows() {
    const projectArg = getArg('--project');
    const datasetInput = getDatasetReferenceInput();
    const rowIds = parseCommaSeparated(getArg('--row-ids'));
    if (rowIds.length === 0) {
        throw new Error('Usage: orizu datasets delete-rows [--dataset <datasetId|datasetUrl>] [--project <team/project>] --row-ids <id1,id2>');
    }
    let datasetId;
    if (datasetInput) {
        datasetId = parseDatasetReference(datasetInput).datasetId;
    }
    else {
        const selected = await selectDatasetInteractively(projectArg);
        datasetId = selected.datasetId;
    }
    const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}/rows`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            rowIds,
        }),
    });
    if (!response.ok) {
        throw new Error(`Delete rows failed: ${await response.text()}`);
    }
    const data = await parseJsonResponse(response, 'Dataset delete rows');
    console.log(`Deleted ${data.deletedCount} rows from dataset ${data.dataset.name} (${data.dataset.id}). New row count: ${data.dataset.rowCount}`);
}
async function lockDataset() {
    const projectArg = getArg('--project');
    const datasetInput = getDatasetReferenceInput();
    const reason = getArg('--reason');
    let datasetId;
    if (datasetInput) {
        datasetId = parseDatasetReference(datasetInput).datasetId;
    }
    else {
        const selected = await selectDatasetInteractively(projectArg);
        datasetId = selected.datasetId;
    }
    const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}/lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reason ? { reason } : {}),
    });
    if (!response.ok) {
        throw new Error(`Lock failed: ${await response.text()}`);
    }
    const data = await parseJsonResponse(response, 'Dataset lock');
    console.log(`Locked dataset ${data.dataset.name} (${data.dataset.id}) at ${data.dataset.lockedAt}. Row count: ${data.dataset.rowCount}`);
}
async function cloneDataset() {
    const projectArg = getArg('--project');
    const datasetInput = getDatasetReferenceInput();
    const name = getArg('--name');
    let datasetId;
    if (datasetInput) {
        datasetId = parseDatasetReference(datasetInput).datasetId;
    }
    else {
        const selected = await selectDatasetInteractively(projectArg);
        datasetId = selected.datasetId;
    }
    const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(name ? { name } : {}),
    });
    if (!response.ok) {
        throw new Error(`Clone failed: ${await response.text()}`);
    }
    const data = await parseJsonResponse(response, 'Dataset clone');
    console.log(`Cloned dataset ${data.dataset.parentDatasetId} -> ${data.dataset.name} (${data.dataset.id}). Row count: ${data.dataset.rowCount}`);
}
async function downloadAnnotations() {
    let taskId = getArg('--task');
    const format = (getArg('--format') || 'jsonl');
    const outPathArg = getArg('--out');
    if (!['csv', 'json', 'jsonl'].includes(format)) {
        throw new Error('format must be one of: csv, json, jsonl');
    }
    if (!taskId) {
        taskId = await selectTaskIdInteractively();
    }
    const response = await authedFetch(`/api/cli/tasks/${taskId}/export?format=${format}`);
    if (!response.ok) {
        throw new Error(`Download failed: ${await response.text()}`);
    }
    const fallbackName = `${taskId}.${format}`;
    const filename = outPathArg
        ? expandHomePath(outPathArg)
        : fallbackName;
    const bytes = new Uint8Array(await response.arrayBuffer());
    writeFileSync(filename, bytes);
    console.log(`Saved ${format.toUpperCase()} export to ${filename}`);
}
async function main() {
    const parsed = parseGlobalFlags(process.argv.slice(2));
    setGlobalFlags(parsed.flags);
    cliArgs = parsed.args;
    const command = cliArgs[0];
    const subcommand = cliArgs[1];
    if (!command) {
        printUsage();
        process.exit(1);
    }
    if (command === 'login') {
        await login();
        return;
    }
    if (command === 'logout') {
        await logout();
        return;
    }
    if (command === 'whoami') {
        await whoami();
        return;
    }
    if (command === 'teams' && subcommand === 'list') {
        await listTeams();
        return;
    }
    if (command === 'teams' && subcommand === 'create') {
        await createTeam();
        return;
    }
    const teamsMembersAction = cliArgs[2];
    if (command === 'teams' && subcommand === 'members' && teamsMembersAction === 'list') {
        await listTeamMembers();
        return;
    }
    if (command === 'teams' && subcommand === 'members' && teamsMembersAction === 'add') {
        await addTeamMember();
        return;
    }
    if (command === 'teams' && subcommand === 'members' && teamsMembersAction === 'remove') {
        await removeTeamMember();
        return;
    }
    if (command === 'teams' && subcommand === 'members' && teamsMembersAction === 'role') {
        await changeTeamMemberRole();
        return;
    }
    if (command === 'projects' && subcommand === 'list') {
        await listProjects();
        return;
    }
    if (command === 'projects' && subcommand === 'create') {
        await createProject();
        return;
    }
    if (command === 'apps' && subcommand === 'list') {
        await listApps();
        return;
    }
    if (command === 'apps' && subcommand === 'create') {
        await createAppFromFile();
        return;
    }
    if (command === 'apps' && subcommand === 'update') {
        await updateAppFromFile();
        return;
    }
    if (command === 'apps' && subcommand === 'link-dataset') {
        await linkAppDataset();
        return;
    }
    if (command === 'apps' && subcommand === 'detail') {
        await appDetail();
        return;
    }
    if (command === 'tasks' && subcommand === 'list') {
        await listTasks();
        return;
    }
    if (command === 'tasks' && subcommand === 'create') {
        await createTask();
        return;
    }
    if (command === 'tasks' && subcommand === 'assign') {
        await assignTask();
        return;
    }
    if (command === 'tasks' && subcommand === 'status') {
        await taskStatus();
        return;
    }
    if (command === 'tasks' && subcommand === 'pause') {
        await updateTaskStatus('paused');
        return;
    }
    if (command === 'tasks' && subcommand === 'unpause') {
        await updateTaskStatus('active');
        return;
    }
    if (command === 'datasets' && subcommand === 'upload') {
        await uploadDataset();
        return;
    }
    if (command === 'datasets' && subcommand === 'download') {
        await downloadDataset();
        return;
    }
    if (command === 'datasets' && subcommand === 'append') {
        await appendDatasetRows();
        return;
    }
    if (command === 'datasets' && subcommand === 'edit-rows') {
        await editDatasetRows();
        return;
    }
    if (command === 'datasets' && subcommand === 'delete-rows') {
        await deleteDatasetRows();
        return;
    }
    if (command === 'datasets' && subcommand === 'lock') {
        await lockDataset();
        return;
    }
    if (command === 'datasets' && subcommand === 'clone') {
        await cloneDataset();
        return;
    }
    if (command === 'tasks' && subcommand === 'export') {
        await downloadAnnotations();
        return;
    }
    printUsage();
    process.exit(1);
}
main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
});
