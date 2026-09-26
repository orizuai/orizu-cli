#!/usr/bin/env node
import { randomUUID } from 'crypto'
import { join, delimiter } from 'path'
import {
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  realpathSync,
} from 'fs'
import { gunzipSync, gzipSync } from 'zlib'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { materializeRunnerVersion as materializeRegisteredRunnerVersion } from './runner-version-materialization.js'
import { runnerInstructionSetSyncSet, runnerInputPrompt, runnerInputInstructionSet } from './runner-instruction-set-contract.js'
import {
  cliArgs,
  getArg,
  hasJsonFlag,
  getArchiveListStatus,
  getPositionalArg,
  expandHomePath,
  hasArg,
  rejectDashPrefixedOptionValue,
  setCommandLineArguments,
  isInteractiveTerminal,
  getOptionalArgValue,
  normalizeSlugInput,
} from './command-line-arguments.js'
import { provenanceRequestFields, resolveInstructionSetProvenance, noSubmitScorerOutput } from './instruction-set-provenance.js'
import {
  readSourceFile,
  readJsonFile,
  readManifestFile,
  readPromptPrimaryText,
  readPromptSidecars,
  stringFromRecord,
  isRecord,
  safeRelativePath,
  writeTextFileEnsuringDir,
  sha256Hex,
  readSourceBytes,
  listApps,
  createAppFromFile,
  previewAppFromFile,
  updateAppFromFile,
  linkAppDataset,
  appDetail,
  exportAppSource,
} from './app-commands.js'
import {
  getErrorMessage,
  printJson,
  printLine,
  printPushDisclosures,
  getCliVersion,
  printBannerIfInteractive,
  printVersion,
  printUsage,
  printError,
} from './cli-console-output.js'
import {
  authedFetch,
  getBaseUrl,
  setGlobalFlags,
  getLastResolvedBaseUrl,
} from './http.js'
import { parseJsonResponse, sanitizeTerminalText } from './json-response.js'
import {
  resolveProjectSlug,
  listTeams,
  createTeam,
  listTeamMembers,
  addTeamMember,
  removeTeamMember,
  changeTeamMemberRole,
  listProjects,
  createProject,
} from './account-directory.js'
import { printPromptSummaryTable } from './prompt-summary-table.js'
import { printScorerSummaries, archiveArtifactCommand, listAssignmentsCommand } from './archive-artifacts-cli.js'
import { runScorersRegister } from './scorer-draft-push.js'
import { formatScoreForCli } from './score-format.js'
import { runZipArtifactPush } from './zip-draft-push.js'
import { readMarkdownReportInput } from './markdown-report-input.js'
import { pushPromptDraft } from './prompt-draft-push.js'
import { promptPushErrorMessage, promptReportCommand } from './prompt-report-cli.js'
import {
  parseCommaSeparated,
  listTasks,
  createTask,
  updateTask,
  discardTask,
  publishTask,
  assignTask,
  taskStatus,
  setTaskReport,
  getTaskReport,
  updateTaskStatus,
} from './task-commands.js'
import { cleanupAll, throwWithCleanup } from './cleanup.js'
import {
  extractFlagValue,
  verifyGepaRunnerDirsFromArgs,
  verifyRunnerDirRegistered,
  assertSnapshotManifestConfined,
} from './runner-dir-verify.js'
import { getGepaPythonCommand } from './gepa-python-command.js'
import { resolveAuthTokenForBaseUrl } from './credentials.js'
import { applyHostedInstructionSetProfileOverride, dispatchHostedCommands } from './hosted-commands.js'
import { dispatchGepaEngine } from './gepa-engine-dispatch.js'
import { getGepaPythonPathEntries } from './gepa-python-paths.js'
import { resolveGepaSeedFromEnvironment } from './instruction-set-gepa-launch.js'
import { prepareSkilledProposerLaunch, spawnSkilledProposerChild } from './skilled-proposer-launch.js'
import { reportCommentsCommand, throwDeprecatedPromptCommentsCommand } from './report-comments-cli.js'
import { getCapabilities, renderHelpForArgs } from './help.js'
import { effectiveRunnerEnvAllowlist, reportStrippedRunnerCredentials } from './runner-env.js'
import { providersCommand } from './providers-cli.js'
import { syncToDisk, instructionSetsCommand } from './instruction-sets-cli.js'
import { parseGlobalFlags } from './global-flags.js'
import { runUpdateCommand, withPassiveUpdateNotice } from './self-update.js'
import {
  setupPromptCommand,
  setupCommand,
  installSkillCommand,
  skillsPathCommand,
  skillsStatusCommand,
  skillsUpdateCommand,
  resolveSetupTeam,
} from './setup-and-skills-commands.js'
import {
  login,
  logout,
  whoami,
  printEnv,
} from './auth-commands.js'
import { feedbackCommand } from './feedback-cli.js'
import { diffCommentsCommand } from './diff-comments-cli.js'
import { setPromptLabel } from './prompt-label-cli.js'
import { scorersCommand } from './scorers-cli.js'
import { verifyScorerParityCommand } from './scorers-verify-parity.js'
import { runnerOptimizerCommand } from './artifact-pull.js'
import { acceptScoreRunCommand } from './scores-accept-cli.js'
import { exportOptimizationRunCommand } from './optimization-export-cli.js'
import { listOptimizationRunsCommand } from './optimizations-list-cli.js'
import { promoteOptimizationCommand } from './optimizations-promote-cli.js'
import {
  uploadDataset,
  listDatasets,
  pushDataset,
  downloadDataset,
  appendDatasetRows,
  setDatasetReadme,
  createDatasetVersion,
  createDatasetSplitSet,
  editDatasetRows,
  deleteDatasetRows,
  deleteDataset,
  lockDataset,
  cloneDataset,
  downloadAnnotations,
} from './dataset-commands.js'
import { workbenchCommand } from './workbench-cli.js'
import { workspaceSyncCommand } from './workspace-sync.js'
import { runGitCredentialInvocation } from './git-credential.js'
import { connectorsCommand } from './connectors-cli.js'
import { manifestsCommand } from './manifests-cli.js'
import { modelConfigsCommand } from './model-configs-cli.js'
import { killSwitchCommand } from './kill-switch-cli.js'
import { egressAllowlistCommand } from './egress-allowlist-cli.js'
import { teamConnectorsCommand } from './team-connectors-cli.js'
import { inspectExistingWorkspaceTeam, getWorkspaceRoot } from './workspace.js'
import { writeLastErrorRecord, extractLastErrorCode } from './last-error-record.js'
import type { CliLengthStats, CliLengthMeasurementUnavailableReason } from './prompt-length-wire.js'
import type { RunnerInstructionSet } from './runner-instruction-set-contract.js'
import type { GepaVerifiedArgs } from './runner-dir-verify.js'
import type { ReportCommentsCliContext } from './report-comments-cli.js'



export { loadInstructionSet } from './instruction-set-loader.js'

export const materializeRunnerVersion = (runnerVersionId: string) =>
  materializeRegisteredRunnerVersion(runnerVersionId, false)

export { parseJsonResponse, sanitizeTerminalText } from './json-response.js'
export { RUNNER_ENV_ALLOWLIST } from './runner-env.js'

interface PromptSummary {
  id: string
  name: string
  role: string
  status?: string
  archivedAt?: string | null
  description?: string | null
  lengthStats?: CliLengthStats | null
  lengthStatsUnavailableReason?: CliLengthMeasurementUnavailableReason
  lengthStatsVersionId?: string
  lengthStatsVersionNumber?: number
  owner?: {
    instructionSetSlug: string
    componentKey: string
  } | null
}

interface ScorerSummary {
  id: string
  name: string
  mode: string
  metricLabel: string
  implementationKind: string
  status?: string
  archivedAt?: string | null
}

interface ScoreSubmitInput {
  resultsJsonl?: string
  aggregate?: Record<string, unknown>
  aggregateWarning?: string
}

interface RunnerExecContext {
  prompt: {
    body?: string | null
    bodyKind: string
    providerSettings: Record<string, unknown>
    promptId?: string
    promptVersionId: string
    runnerVersionId: string
  }
  scorer?: {
    versionId: string
    metricKey: string
    higherIsBetter: boolean
  } | null
  instructionSet?: RunnerInstructionSet
  rows: Array<{
    id: string
    row: Record<string, unknown>
  }>
}

function instructionSetProvenanceFields(project: string) {
  for (const flag of ['--instructions', '--instructions-root']) {
    if (cliArgs.some(argument => argument.startsWith(`${flag}=`))) {
      throw new Error(`instruction_set_option_equals_form:${flag}`)
    }
    const index = cliArgs.indexOf(flag)
    if (index !== -1) {
      const value = cliArgs[index + 1]
      if (!value || value.startsWith('-')) {
        throw new Error(`instruction_set_option_value_missing:${flag}`)
      }
    }
  }
  const specifier = getArg('--instructions')
  const root = getArg('--instructions-root')
  if (root && !specifier) throw new Error('instruction_set_option_orphan_root:--instructions-root')
  if (!specifier) return {}
  return provenanceRequestFields(resolveInstructionSetProvenance({
    specifier,
    root: root || '.',
    project,
  }))
}

function readJsonObjectArg(valueArg: string | null, label: string): Record<string, unknown> {
  if (!valueArg) {
    return {}
  }

  const trimmed = valueArg.trim()
  const raw = trimmed.startsWith('{')
    ? trimmed
    : readSourceFile(trimmed.startsWith('@') ? trimmed.slice(1) : trimmed)

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON root must be an object')
    }
    return parsed as Record<string, unknown>
  } catch (error: unknown) {
    throw new Error(`Invalid ${label} '${valueArg}': ${getErrorMessage(error)}`)
  }
}

function readJsonPayloadArg(pathArg: string | null): Record<string, unknown> {
  return readJsonObjectArg(pathArg, 'event payload')
}

async function logOptimizationEvent() {
  const eventType = cliArgs[1]
  const runId = getArg('--run-id')
  const sequenceArg = getArg('--sequence')
  const payload = readJsonPayloadArg(getArg('--payload'))
  const sequence = sequenceArg ? Number(sequenceArg) : Number.NaN

  if (!eventType || eventType.startsWith('--') || !runId || !Number.isInteger(sequence) || sequence <= 0) {
    throw new Error('Usage: orizu log <event_type> --run-id <id> --sequence <n> --payload @event.json')
  }

  const response = await authedFetch(`/api/cli/optimization-runs/${encodeURIComponent(runId)}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId: getArg('--event-id') || randomUUID(),
      sequence,
      eventType,
      eventLayer: getArg('--event-layer') || 'core',
      optimizerFamily: getArg('--optimizer-family'),
      iteration: getArg('--iteration') ? Number(getArg('--iteration')) : undefined,
      candidateId: getArg('--candidate-id'),
      parentCandidateId: getArg('--parent-candidate-id'),
      childCandidateId: getArg('--child-candidate-id'),
      payload,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to log event: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ eventId: string }>(response, 'Optimization event log')
  if (hasJsonFlag()) {
    printJson({ eventId: data.eventId })
    return
  }
  printLine(`Logged event ${sanitizeTerminalText(data.eventId)}`)
}

async function listPrompts() {
  const project = getArg('--project') || await resolveProjectSlug(null)
  const status = getArg('--status') || 'active'
  if (!['active', 'archived', 'all'].includes(status)) {
    throw new Error('Usage: orizu prompts list --project <team/project> [--status active|archived|all]')
  }

  const params = new URLSearchParams({ project, status })
  const response = await authedFetch(`/api/cli/prompts?${params.toString()}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch prompts: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ prompts: PromptSummary[] }>(response, 'Prompts list')
  if (hasJsonFlag()) {
    printJson(data as unknown as Record<string, unknown>)
    return
  }
  printPromptSummaryTable(data.prompts, 'No prompts found.', printLine)
}

async function listJudges() {
  const project = getArg('--project') || await resolveProjectSlug(null)
  const status = getArg('--status') || 'active'
  if (!['active', 'archived', 'all'].includes(status)) {
    throw new Error('Usage: orizu judges list --project <team/project> [--status active|archived|all]')
  }

  const params = new URLSearchParams({ project, status })
  const response = await authedFetch(`/api/cli/judges?${params.toString()}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch judges: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ judges: PromptSummary[] }>(response, 'Judges list')
  if (hasJsonFlag()) {
    printJson(data as unknown as Record<string, unknown>)
    return
  }
  printPromptSummaryTable(data.judges, 'No judges found.', printLine)
}

async function listScorers() {
  const project = getArg('--project') || await resolveProjectSlug(null)
  const status = getArchiveListStatus('scorers')
  const params = new URLSearchParams({ project })
  if (status !== 'active') params.set('status', status)
  const response = await authedFetch(`/api/cli/scorers?${params.toString()}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch scorers: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ scorers: ScorerSummary[] }>(response, 'Scorers list')
  if (hasJsonFlag()) {
    printJson(data as unknown as Record<string, unknown>)
    return
  }
  printScorerSummaries(data.scorers, printLine)
}

// Command body lives in scorer-draft-push.ts (CLI line ratchet, ALI-976).
async function registerScorer() {
  return runScorersRegister({
    getArg, resolveProjectSlug, readJsonFile, hasJsonFlag, printJson, printLine,
    parseJsonResponse: (response, label) => parseJsonResponse<Record<string, unknown>>(response, label),
  })
}

async function showScorerDetail() {
  const scorerId = getPositionalArg(2)
  const project = getArg('--project') || await resolveProjectSlug(null)
  if (!scorerId) {
    throw new Error('Usage: orizu scorers detail <scorer-id-or-name> --project <team/project> [--profile-version <id>] [--json]')
  }

  const scorerParams = new URLSearchParams({ project })
  const profileVersionId = getArg('--profile-version')
  if (profileVersionId) scorerParams.set('profileVersionId', profileVersionId)
  const response = await authedFetch(`/api/cli/scorers/${encodeURIComponent(scorerId)}?${scorerParams.toString()}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch scorer: ${await response.text()}`)
  }

  const data = await parseJsonResponse<Record<string, unknown>>(response, 'Scorer detail')
  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  const scorer = data.scorer as Record<string, unknown> | undefined
  printLine(`${sanitizeTerminalText(String(scorer?.name || scorerId))}`)
  printLine(`Metric: ${sanitizeTerminalText(String(scorer?.metricLabel || 'Score'))}`)
  const scoreRuns = Array.isArray(scorer?.scoreRuns) ? scorer.scoreRuns : []
  for (const value of scoreRuns) {
    if (!value || typeof value !== 'object') continue
    const scoreRun = value as Record<string, unknown>
    const formattedScore = formatScoreForCli(scoreRun.scoreValue, scoreRun.scoreFormat)
    printLine(`Score run ${sanitizeTerminalText(String(scoreRun.id || '?'))}: ${sanitizeTerminalText(formattedScore)} (Profile Version ${sanitizeTerminalText(String(scoreRun.profileVersionId || '—'))})`)
  }
}

async function listRuns() {
  const project = getArg('--project') || await resolveProjectSlug(null)
  const params = new URLSearchParams({ project })
  const profileVersionId = getArg('--profile-version')
  const promptVersionId = getArg('--prompt-version')
  const limit = getArg('--limit')
  if (profileVersionId) params.set('profileVersionId', profileVersionId)
  if (promptVersionId) params.set('promptVersionId', promptVersionId)
  if (limit) params.set('limit', limit)

  const response = await authedFetch(`/api/cli/runs?${params.toString()}`)
  if (!response.ok) throw new Error(`Failed to fetch runs: ${await response.text()}`)
  const data = await parseJsonResponse<{ runs: Array<Record<string, unknown>> }>(response, 'Runs list')
  if (hasJsonFlag()) {
    printJson(data as unknown as Record<string, unknown>)
    return
  }
  for (const run of data.runs) {
    printLine([
      sanitizeTerminalText(String(run.id ?? '?')),
      `prompt ${sanitizeTerminalText(String(run.promptVersionId ?? '—'))}`,
      `split ${sanitizeTerminalText(String(run.splitName ?? '—'))}`,
      `score ${sanitizeTerminalText(formatScoreForCli(run.aggregateScore, 'number'))}`,
      `Profile Version ${sanitizeTerminalText(String(run.profileVersionId ?? '—'))}`,
    ].join(' | '))
  }
}

async function setScorerLabel() {
  const scorerName = getPositionalArg(3)
  const label = getPositionalArg(4)
  const project = getArg('--project') || await resolveProjectSlug(null)
  const scorerVersionId = getArg('--version')

  if (!scorerName || !label || !scorerVersionId) {
    throw new Error('Usage: orizu scorers labels set <scorer-name> <label> --version <scorer-version-id> [--project <team/project>] [--json]')
  }

  const response = await authedFetch(`/api/cli/scorers/labels?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scorerName, label, scorerVersionId }),
  })

  if (!response.ok) {
    throw new Error(`Failed to set scorer label: ${await response.text()}`)
  }

  const data = await parseJsonResponse<Record<string, unknown>>(response, 'Scorer label set')
  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  printLine(`Moved ${sanitizeTerminalText(label)} to ${sanitizeTerminalText(scorerVersionId)}`)
}

// Command body lives in zip-draft-push.ts (CLI line ratchet, ALI-976).
async function pushRunnerArtifact(kind: 'runner' | 'optimizer') {
  return runZipArtifactPush(kind, {
    getArg, getPositionalArg, resolveProjectSlug, readManifestFile, expandHomePath,
    hasJsonFlag, printJson, printLine,
    parseJsonResponse: (response, label) => parseJsonResponse<Record<string, unknown>>(response, label),
  })
}

async function pushPromptArtifact(kind: 'prompt' | 'judge') {
  const promptDir = getPositionalArg(2)
  const projectArg = getArg('--project')
  const runnerVersionArg = getArg('--runner-version')
  const parentVersionId = getArg('--parent') || undefined
  const sessionId = getArg('--session') || undefined
  const usage = `Usage: orizu ${kind === 'judge' ? 'judges' : 'prompts'} push <dir> --project <team/project> [--runner-version <id>] [--parent <version-id>] [--session <session-id>] [--report-file <path>] [--json]`

  if (!promptDir) throw new Error(usage)
  if (cliArgs.some(arg => arg === '--report' || arg.startsWith('--report='))) throw new Error(`${kind === 'judge' ? 'judges' : 'prompts'} push accepts report input only through --report-file`)
  const report = readMarkdownReportInput(cliArgs, 'Prompt')
  const project = projectArg || await resolveProjectSlug(null)

  const promptRoot = expandHomePath(promptDir)
  const manifest = readJsonFile(join(promptRoot, 'orizu.prompt.json'))
  const primaryText = readPromptPrimaryText(manifest, promptRoot)
  const sidecars = readPromptSidecars(manifest, promptRoot)
  const runnerFromManifest = stringFromRecord(manifest, 'runner_version_id') ||
    (isRecord(manifest.runner) ? stringFromRecord(manifest.runner, 'version_id') : undefined)
  const runnerVersionId = runnerVersionArg || runnerFromManifest
  if (!runnerVersionId) {
    throw new Error(usage)
  }
  const baseBundle = isRecord(manifest.bundle) ? manifest.bundle : {}

  // ADR-007 P4 (ALI-1074): in a session the version is a COMMIT-FIRST git
  // draft (pins repo_path/content_sha/commit_sha) — see prompt-draft-push.ts.
  if (sessionId) {
    const { data, message } = await pushPromptDraft({
      kind, project, sessionId, manifest, sidecars, runnerVersionId, parentVersionId,
      displayName: String(manifest.name || promptDir),
      bodyKind: primaryText.bodyKind, primaryBody: primaryText.body,
      report,
    })
    if (hasJsonFlag()) printJson(data)
    else {
      printPushDisclosures(data)
      printLine(message)
    }
    return
  }

  // LEGACY SESSIONLESS PATH (no branch to commit to; the server dual-writes
  // the DB body). TODO(ALI-1074 P6): retire when sessionless goes git.
  const endpoint = kind === 'judge' ? 'judges' : 'prompts'
  const response = await authedFetch(`/api/cli/${endpoint}?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: manifest.name,
      role: kind === 'judge' && manifest.role === undefined ? 'judge_per_row' : manifest.role,
      description: manifest.description,
      body: primaryText.body,
      bodyKind: primaryText.bodyKind,
      providerSettings: manifest.provider_settings || {},
      bundle: {
        ...baseBundle,
        tags: manifest.tags || [],
        provenance: manifest.provenance || {},
        primaryText: {
          path: primaryText.path,
          kind: primaryText.bodyKind,
        },
        sidecars,
      },
      runnerVersionId,
      parentVersionId,
      versionLabel: manifest.version_label,
      createdBy: manifest.provenance || { kind: 'human-edit' },
      ...(report
        ? {
            reportMarkdown: report.markdown,
            reportSourceName: report.sourceName,
          }
        : {}),
    }),
  })

  if (!response.ok) {
    throw new Error(await promptPushErrorMessage(response, kind, Boolean(report)))
  }

  const data = await parseJsonResponse<Record<string, unknown>>(response, `${kind} push`)
  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  printPushDisclosures(data)
  printLine(`Pushed ${kind} ${sanitizeTerminalText(String(manifest.name || promptDir))} (${sanitizeTerminalText(String(data.prompt_version_id || 'unknown version'))})`)
}

async function pullPromptArtifact(kind: 'prompt' | 'judge') {
  const promptRef = getPositionalArg(2)
  const project = getArg('--project') || await resolveProjectSlug(null)
  const outDir = getArg('--out')
  const label = getArg('--label')
  const version = getArg('--version')

  if (!promptRef || !outDir) {
    throw new Error(`Usage: orizu ${kind === 'judge' ? 'judges' : 'prompts'} pull <prompt-id-or-name> --project <team/project> --out <dir> [--label <label> | --version <version-id>] [--json]`)
  }
  if (label && version) {
    throw new Error('Use either --label or --version, not both')
  }

  const params = new URLSearchParams({ project })
  if (label) params.set('label', label)
  if (version) params.set('version', version)

  const endpoint = kind === 'judge' ? 'judges' : 'prompts'
  const response = await authedFetch(`/api/cli/${endpoint}/${encodeURIComponent(promptRef)}?${params.toString()}`)
  if (!response.ok) {
    throw new Error(`Failed to pull ${kind}: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    prompt: {
      id: string
      name: string
      role: string
      description?: string | null
    }
    version: {
      id: string
      versionNumber?: number
      versionLabel?: string | null
      body?: string | null
      bodyKind?: string | null
      providerSettings?: Record<string, unknown>
      runnerVersionId?: string | null
      bundle?: Record<string, unknown>
    }
    labels?: Array<{ label: string; promptVersionId: string }>
    scorerVersionId?: string | null
    scorerVersions?: Array<{
      id: string
      scorerId: string
      promptVersionId: string
      runnerVersionId: string
      metricKey: string
      higherIsBetter: boolean
    }>
    owner?: {
      instructionSetSlug: string
      componentKey: string
    } | null
  }>(response, `${kind} pull`)

  const targetDir = expandHomePath(outDir)
  mkdirSync(targetDir, { recursive: true })

  const bundle = isRecord(data.version.bundle) ? data.version.bundle : {}
  const bundlePrimaryText = isRecord(bundle.primaryText)
    ? bundle.primaryText
    : isRecord(bundle.primary_text)
      ? bundle.primary_text
      : null
  const primaryPath = safeRelativePath(
    stringFromRecord(bundlePrimaryText || {}, 'path') || 'prompt.md',
    'prompt.md'
  )
  const bodyKind = stringFromRecord(bundlePrimaryText || {}, 'kind') || data.version.bodyKind || 'text'

  writeTextFileEnsuringDir(join(targetDir, primaryPath), data.version.body || '')

  const exportedSidecars: Array<Record<string, unknown>> = []
  const sidecars = Array.isArray(bundle.sidecars) ? bundle.sidecars : []
  for (const rawSidecar of sidecars) {
    if (!isRecord(rawSidecar)) continue
    const sidecarPathValue = stringFromRecord(rawSidecar, 'path')
    if (!sidecarPathValue) continue
    const sidecarPath = safeRelativePath(sidecarPathValue, sidecarPathValue)
    const content = typeof rawSidecar.content === 'string' ? rawSidecar.content : null
    const contentSha256 = stringFromRecord(rawSidecar, 'contentSha256') ||
      stringFromRecord(rawSidecar, 'content_sha256') ||
      (content !== null ? sha256Hex(content) : undefined)
    if (content !== null) {
      writeTextFileEnsuringDir(join(targetDir, sidecarPath), content)
    }
    const { content: _ignoredContent, contentSha256: _ignoredCamel, content_sha256: _ignoredSnake, ...metadata } = rawSidecar
    exportedSidecars.push({
      ...metadata,
      type: stringFromRecord(rawSidecar, 'type') || 'file',
      path: sidecarPath,
      ...(contentSha256 ? { content_sha256: contentSha256 } : {}),
    })
  }

  const labels = (data.labels || [])
    .filter(item => item.promptVersionId === data.version.id)
    .map(item => item.label)
  const scorerVersions = (data.scorerVersions || []).map(item => ({
    id: item.id,
    scorer_id: item.scorerId,
    prompt_version_id: item.promptVersionId,
    runner_version_id: item.runnerVersionId,
    metric_key: item.metricKey,
    higher_is_better: item.higherIsBetter,
  }))

  const manifest: Record<string, unknown> = {
    schema_version: 'orizu.prompt.v1',
    name: data.prompt.name,
    role: data.prompt.role,
    description: data.prompt.description || undefined,
    primary_text: {
      path: primaryPath,
      kind: bodyKind,
    },
    provider_settings: data.version.providerSettings || {},
    runner_version_id: data.version.runnerVersionId || undefined,
    version_id: data.version.id,
    scorer_version_id: data.scorerVersionId || undefined,
    scorer_versions: scorerVersions.length > 0 ? scorerVersions : undefined,
    version_number: data.version.versionNumber,
    version_label: data.version.versionLabel || undefined,
    labels,
    sidecars: exportedSidecars,
  }

  writeTextFileEnsuringDir(
    join(targetDir, 'orizu.prompt.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  )

  if (hasJsonFlag()) {
    printJson({
      prompt_id: data.prompt.id,
      prompt_version_id: data.version.id,
      scorer_version_id: data.scorerVersionId || undefined,
      scorer_version_ids: scorerVersions.map(item => item.id),
      path: targetDir,
      owner: data.owner || undefined,
    })
    return
  }

  printLine(`Pulled ${kind} ${sanitizeTerminalText(data.prompt.name)} to ${sanitizeTerminalText(targetDir)}`)
  if (!data.scorerVersionId && scorerVersions.length > 1) {
    printLine(
      `Warning: prompt version ${sanitizeTerminalText(data.version.id)} maps to multiple scorer versions ` +
      `(${scorerVersions.map(item => sanitizeTerminalText(item.id)).join(', ')}); choose an explicit scorer version ID.`
    )
  } else if (!data.scorerVersionId && kind === 'judge') {
    printLine(
      `Warning: prompt version ${sanitizeTerminalText(data.version.id)} does not map to an executable scorer version.`
    )
  }
  if (kind === 'prompt' && data.owner) {
    printLine(
      `Owner: ${sanitizeTerminalText(data.prompt.name)} (${sanitizeTerminalText(data.prompt.id)}) -> ` +
      `${sanitizeTerminalText(data.owner.instructionSetSlug)} / ${sanitizeTerminalText(data.owner.componentKey)}`
    )
  }
}

function refusePromptMutation(replacement: string): never {
  process.exitCode = 1
  throw new Error(`Use: orizu instructions ${replacement}`)
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'unscored'
  }

  return `${(value * 100).toFixed(1)}%`
}

async function submitRunResults() {
  const resultsPath = getPositionalArg(2) || getArg('--file') || getArg('--results')
  const project = getArg('--project') || await resolveProjectSlug(null)
  const promptVersionId = getArg('--prompt-version')
  const runnerVersionId = getArg('--runner-version')
  const datasetVersionId = getArg('--dataset-version')
  const splitSetId = getArg('--split-set')
  const splitName = getArg('--split')

  if (
    !resultsPath ||
    !promptVersionId ||
    !runnerVersionId ||
    !datasetVersionId ||
    !splitSetId ||
    !splitName
  ) {
    throw new Error(
      'Usage: orizu runs submit <results.jsonl> --project <team/project> --prompt-version <id> --runner-version <id> --dataset-version <id> --split-set <id> --split <name> [--judge-version <id>] [--judge-runner-version <id>]'
    )
  }

  const resultBytes = readSourceBytes(resultsPath)
  const resultsJsonl = resultsPath.endsWith('.gz')
    ? gunzipSync(resultBytes).toString('utf8')
    : resultBytes.toString('utf8')
  const response = await authedFetch(`/api/cli/runs/submit?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      promptVersionId,
      runnerVersionId,
      datasetVersionId,
      splitSetId,
      splitName,
      judgeVersionId: getArg('--judge-version') || undefined,
      judgeRunnerVersionId: getArg('--judge-runner-version') || undefined,
      resultsJsonl,
      ...instructionSetProvenanceFields(project),
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to submit run: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    run: {
      id: string
      aggregateScore: number | null
      perRowResultsStoragePath: string
    }
  }>(response, 'Run submit')
  if (hasJsonFlag()) {
    printJson({ run: data.run })
    return
  }
  printLine(
    `Submitted run ${sanitizeTerminalText(data.run.id)} ` +
    `(${formatPercent(data.run.aggregateScore)}) -> ` +
    sanitizeTerminalText(data.run.perRowResultsStoragePath)
  )
}

async function submitScoreResults() {
  const resultsPath = getPositionalArg(2) || getArg('--file') || getArg('--results')
  const project = getArg('--project') || await resolveProjectSlug(null)
  const scorerVersionId = getArg('--scorer-version')
  const subjectPromptVersionId = getArg('--subject-version') || getArg('--prompt-version')
  const optimizationRunId = getArg('--optimization-run')
  const candidateId = getArg('--candidate')

  if (!resultsPath || !scorerVersionId || (!subjectPromptVersionId && (!optimizationRunId || !candidateId))) {
    throw new Error('Usage: orizu scores submit <results.jsonl|results.json> --project <team/project> --scorer-version <id> (--subject-version <prompt-version-id> | --optimization-run <id> --candidate <id>) [--aggregate] [--dataset-version <id> --split-set <id> --split <name>] [--json]')
  }

  const resultBytes = readSourceBytes(resultsPath)
  const raw = resultsPath.endsWith('.gz')
    ? gunzipSync(resultBytes).toString('utf8')
    : resultBytes.toString('utf8')
  const scoreInput = normalizeScoreResultsInput(resultsPath, raw, hasArg('--aggregate'))
  if (scoreInput.aggregateWarning) {
    console.warn(scoreInput.aggregateWarning)
  }
  const aggregatePayload = scoreInput.aggregate || {}
  const response = await authedFetch(`/api/cli/scores/submit?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...aggregatePayload,
      ...instructionSetProvenanceFields(project),
      scorerVersionId,
      subjectPromptVersionId: subjectPromptVersionId || undefined,
      datasetVersionId: getArg('--dataset-version') || undefined,
      splitSetId: getArg('--split-set') || undefined,
      splitName: getArg('--split') || undefined,
      optimizationRunId: optimizationRunId || undefined,
      candidateId: candidateId || undefined,
      resultsJsonl: scoreInput.resultsJsonl,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to submit score: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    scoreRun: {
      id: string
      scoreValue: number | null
      rowResultsStoragePath?: string | null
      provenance?: string | null
    }
  }>(response, 'Score submit')
  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  // ALI-1175: label the stored provenance — a submitted score is a client-reported claim.
  printLine(
    `Submitted score ${sanitizeTerminalText(data.scoreRun.id)} ` +
    `(${formatPercent(data.scoreRun.scoreValue)})` +
    (data.scoreRun.provenance ? ` [${sanitizeTerminalText(String(data.scoreRun.provenance).replace(/_/g, '-'))}]` : '')
  )
}

function looksLikeAggregateScoreObject(value: Record<string, unknown>): boolean {
  return (
    value.scoreValue !== undefined ||
    value.score_value !== undefined ||
    value.diagnostics !== undefined ||
    value.feedbackSummary !== undefined ||
    value.feedback_summary !== undefined ||
    value.rowEvidence !== undefined ||
    value.row_evidence !== undefined ||
    value.dependencyScoreRunIds !== undefined ||
    value.dependency_score_run_ids !== undefined
  )
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof value === 'boolean') return value ? 1 : 0
  return null
}

function normalizeScoreResultsInput(sourcePath: string, raw: string, aggregateMode = false): ScoreSubmitInput {
  const logicalPath = sourcePath.endsWith('.gz') ? sourcePath.slice(0, -3) : sourcePath
  if (!logicalPath.endsWith('.json')) return { resultsJsonl: raw }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (aggregateMode) {
      if (!isRecord(parsed)) {
        throw new Error('Aggregate score results JSON must be an object')
      }
      return { aggregate: parsed }
    }
    if (isRecord(parsed) && looksLikeAggregateScoreObject(parsed)) {
      return {
        aggregate: parsed,
        aggregateWarning: 'Warning: aggregate score JSON detected. Pass --aggregate to make this explicit.',
      }
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    if (rows.some(row => !isRecord(row))) {
      throw new Error('JSON score results must be an object or an array of objects')
    }
    return { resultsJsonl: rows.map(row => JSON.stringify(row)).join('\n') }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid score results JSON '${sourcePath}': ${message}`)
  }
}

function readOptionalJsonlFile(pathArg: string | null): string | undefined {
  if (!pathArg) return undefined
  const bytes = readSourceBytes(pathArg)
  return pathArg.endsWith('.gz')
    ? gunzipSync(bytes).toString('utf8')
    : bytes.toString('utf8')
}

function parseAliasAssignments(value: string | null): Record<string, string> {
  const result: Record<string, string> = {}
  if (!value) return result
  for (const item of parseCommaSeparated(value)) {
    const equalsIndex = item.indexOf('=')
    if (equalsIndex <= 0 || equalsIndex === item.length - 1) {
      throw new Error(`Expected alias assignment in form alias=value, got '${item}'`)
    }
    result[item.slice(0, equalsIndex)] = item.slice(equalsIndex + 1)
  }
  return result
}

function readDependencyResultAssignments(value: string | null): Record<string, string> | undefined {
  const assignments = parseAliasAssignments(value)
  const result: Record<string, string> = {}
  for (const [alias, path] of Object.entries(assignments)) {
    result[alias] = readOptionalJsonlFile(path) || ''
  }
  return Object.keys(result).length > 0 ? result : undefined
}

async function execScorer() {
  const project = getArg('--project') || await resolveProjectSlug(null)
  const scorerVersionId = getArg('--scorer-version')
  const subjectPromptVersionId = getArg('--subject-version') || getArg('--prompt-version')
  const optimizationRunId = getArg('--optimization-run')
  const candidateId = getArg('--candidate')
  const datasetVersionId = getArg('--dataset-version')
  const splitSetId = getArg('--split-set')
  const splitName = getArg('--split')
  const outPath = getArg('--out')

  if (
    !scorerVersionId ||
    (!subjectPromptVersionId && (!optimizationRunId || !candidateId)) ||
    !datasetVersionId ||
    !splitSetId ||
    !splitName
  ) {
    throw new Error('Usage: orizu scorers exec --scorer-version <id> (--subject-version <prompt-version-id> | --optimization-run <id> --candidate <id>) --dataset-version <id> --split-set <id> --split <name> [--subject-results <jsonl>] [--dependency-score-run <alias=id>] [--dependency-results <alias=path>] [--no-submit] [--out <score.json>] [--project <team/project>] [--json]')
  }

  const instructionSetProvenance = instructionSetProvenanceFields(project)
  const isNoSubmit = hasArg('--no-submit')
  const response = await authedFetch(`/api/cli/scorers/exec?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scorerVersionId,
      subjectPromptVersionId: subjectPromptVersionId || undefined,
      optimizationRunId: optimizationRunId || undefined,
      candidateId: candidateId || undefined,
      datasetVersionId,
      splitSetId,
      splitName,
      submit: !isNoSubmit,
      reuseExisting: !hasArg('--no-reuse-existing'),
      subjectResultsJsonl: readOptionalJsonlFile(getArg('--subject-results') || getArg('--outputs')),
      dependencyScoreRunIds: parseAliasAssignments(getArg('--dependency-score-run') || getArg('--dependency-score-runs')),
      dependencyResultsJsonl: readDependencyResultAssignments(getArg('--dependency-results')),
      ...instructionSetProvenance,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to execute scorer: ${await response.text()}`)
  }

  const data = await parseJsonResponse<Record<string, unknown>>(response, 'Scorer exec')
  const noSubmitOutput = isNoSubmit
    ? noSubmitScorerOutput(data, instructionSetProvenance)
    : null
  if (outPath) {
    const output = noSubmitOutput ?? data.scoreResult ?? data
    writeFileSync(expandHomePath(outPath), `${JSON.stringify(output, null, 2)}\n`)
  }
  if (hasJsonFlag()) {
    const output = noSubmitOutput ?? data
    printJson(output)
    return
  }

  const scoreRun = isRecord(data.scoreRun) ? data.scoreRun : null
  const scoreResult = isRecord(data.scoreResult) ? data.scoreResult : null
  const scoreValue = scoreRun
    ? scoreRun.scoreValue
    : scoreResult
      ? scoreResult.scoreValue
      : null
  // ALI-1175 (round 5 thread 6 + round 6 thread 2): a scorers-exec score is an
  // agent-reported claim whether or not it was submitted — label both the
  // submitted (scoreRun.provenance) and the --no-submit (top-level provenance)
  // outputs, so a displayed value is never presented as unlabeled evidence.
  const execProvenance =
    scoreRun && typeof scoreRun.provenance === 'string'
      ? scoreRun.provenance
      : typeof data.provenance === 'string'
        ? data.provenance
        : null
  const provenanceSuffix = execProvenance
    ? ` [${sanitizeTerminalText(execProvenance.replace(/_/g, '-'))}]`
    : ''
  if (scoreRun && typeof scoreRun.id === 'string') {
    printLine(`Executed scorer ${sanitizeTerminalText(scorerVersionId)} -> score ${sanitizeTerminalText(scoreRun.id)} (${formatPercent(numberFromUnknown(scoreValue))})${provenanceSuffix}`)
  } else {
    printLine(`Executed scorer ${sanitizeTerminalText(scorerVersionId)} (${formatPercent(numberFromUnknown(scoreValue))})${provenanceSuffix}`)
  }
  if (isNoSubmit && Object.keys(instructionSetProvenance).length > 0) {
    printLine(`Provenance: ${sanitizeTerminalText(String(instructionSetProvenance['orizu.instruction_set.id']))} / ${sanitizeTerminalText(String(instructionSetProvenance['orizu.profile_version.id']))} / ${sanitizeTerminalText(String(instructionSetProvenance['orizu.instruction_set.digest']))}`)
  }
  if (outPath) {
    printLine(`Wrote scorer result to ${sanitizeTerminalText(outPath)}`)
  }
}

type OptimizationLifecycleAction = 'pause' | 'resume' | 'finish' | 'fail' | 'cancel'

function parseOptionalNumberFlag(name: string): number | undefined {
  const value = getArg(name)
  if (!value) {
    return undefined
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`)
  }

  return parsed
}

function hasObjectKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0
}

function readOptimizationReportInput(): { markdown: string; sourceName: string | null } | null {
  return readMarkdownReportInput(cliArgs, 'Optimization')
}

async function startOptimizationRun() {
  const project = getArg('--project') || await resolveProjectSlug(null)
  const optimizerVersionId = getArg('--optimizer-version')
  const promptVersionIds = parseCommaSeparated(
    getArg('--prompt-version') || getArg('--prompt-versions')
  )
  const judgeVersionIds = parseCommaSeparated(
    getArg('--judge-version') || getArg('--judge-versions')
  )
  const selectionScorer = getArg('--selection-scorer') || getArg('--scorer-version')
  const reflectionScorer = getArg('--reflection-scorer')
  const paretoScorers = parseCommaSeparated(getArg('--pareto-scorer') || getArg('--pareto-scorers'))
  const bestScorers = parseCommaSeparated(getArg('--best-scorer') || getArg('--best-scorers'))
  const datasetVersionId = getArg('--dataset-version')
  const splitSetId = getArg('--split-set')
  const metadata = readJsonObjectArg(getArg('--metadata'), 'optimization metadata')

  if (
    !optimizerVersionId ||
    promptVersionIds.length === 0 ||
    !selectionScorer ||
    !datasetVersionId ||
    !splitSetId
  ) {
    throw new Error(
      'Usage: orizu optimizations start --project <team/project> --optimizer-version <id> --prompt-version <id[,id]> --selection-scorer <id> [--reflection-scorer <id>] [--pareto-scorer <id>] [--best-scorer <id>] --dataset-version <id> --split-set <id> [--train-split <name>] [--validation-split <name>] [--metadata <json|@file>] [--json]'
    )
  }

  const scorers = [
    { scorerVersionId: selectionScorer, role: 'selection' },
    ...(reflectionScorer ? [{ scorerVersionId: reflectionScorer, role: 'reflection' }] : []),
    ...paretoScorers.map(scorerVersionId => ({
      scorerVersionId,
      role: 'tracked',
      trackedScope: 'pareto_candidates',
    })),
    ...bestScorers.map(scorerVersionId => ({
      scorerVersionId,
      role: 'tracked',
      trackedScope: 'best_candidate',
    })),
  ]

  const response = await authedFetch(`/api/cli/optimization-runs?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      optimizerVersionId,
      promptVersionIds,
      judgeVersionIds,
      scorers,
      datasetVersionId,
      splitSetId,
      trainSplitName: getArg('--train-split') || undefined,
      validationSplitName: getArg('--validation-split') || undefined,
      metadata,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to start optimization run: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    optimization_run_id: string
    optimizationRun: {
      id: string
      status: string
      startedAt?: string | null
      createdAt?: string | null
    }
  }>(response, 'Optimization run start')

  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  printLine(
    `Started optimization run ${sanitizeTerminalText(data.optimization_run_id)} ` +
    `(${sanitizeTerminalText(data.optimizationRun.status)})`
  )
}

async function updateOptimizationRunLifecycle(action: OptimizationLifecycleAction) {
  const runId = getPositionalArg(2) || getArg('--run-id')
  if (!runId) {
    throw new Error(`Usage: orizu optimizations ${action} <run-id>`)
  }

  const statusByAction: Record<OptimizationLifecycleAction, string> = {
    pause: 'paused',
    resume: 'running',
    finish: 'succeeded',
    fail: 'failed',
    cancel: 'cancelled',
  }

  const body: Record<string, unknown> = {
    status: statusByAction[action],
  }
  const metadata = readJsonObjectArg(getArg('--metadata'), 'optimization metadata')
  const reason = getArg('--reason')
  const report = readOptimizationReportInput()

  if (report && (action === 'pause' || action === 'resume')) {
    throw new Error(`orizu optimizations ${action} does not accept optimization reports`)
  }

  if ((action === 'pause' || action === 'cancel') && reason) {
    metadata.reason = reason
  }

  if (action === 'fail' && reason) {
    metadata.failure_reason = reason
    body.failureReason = reason
  }

  if (hasObjectKeys(metadata)) {
    body.metadata = metadata
  }

  if (report) {
    body.reportMarkdown = report.markdown
    body.reportSourceName = report.sourceName
  }

  if (action === 'finish') {
    const bestScore = parseOptionalNumberFlag('--best-score')
    if (bestScore !== undefined) {
      body.bestScore = bestScore
    }

    const bestCandidateId = getArg('--best-candidate')
    if (bestCandidateId) {
      body.bestCandidateId = bestCandidateId
    }

    const resultPromptVersionId = getArg('--result-prompt-version')
    if (resultPromptVersionId) {
      body.resultPromptVersionId = resultPromptVersionId
    }
  }

  const response = await authedFetch(`/api/cli/optimization-runs/${encodeURIComponent(runId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(`Failed to update optimization run: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    optimizationRun: {
      id: string
      status?: string
      startedAt?: string | null
      finishedAt?: string | null
      bestScore?: number | null
      bestCandidateId?: string | null
      resultPromptVersionId?: string | null
      metadata?: Record<string, unknown>
    }
    cancellationStatus?: 'already_terminal'
  }>(response, 'Optimization run update')

  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  const id = sanitizeTerminalText(data.optimizationRun.id)
  if (action === 'cancel' && data.cancellationStatus === 'already_terminal') {
    const status = data.optimizationRun.status
    const outcome = status
      ? ` (${sanitizeTerminalText(status)})`
      : ''
    printLine(`Optimization run ${id} is already terminal${outcome}; cancellation was not applied`)
  } else if (action === 'pause') {
    printLine(`Paused optimization run ${id}`)
  } else if (action === 'resume') {
    printLine(`Resumed optimization run ${id}`)
  } else if (action === 'finish') {
    printLine(`Finished optimization run ${id}`)
  } else if (action === 'fail') {
    printLine(`Marked optimization run ${id} failed`)
  } else {
    printLine(`Cancelled optimization run ${id}`)
  }
}

// ALI-1073 list moved to optimizations-list-cli.ts (line ratchet, ALI-976);
// ALI-1175 labels its best scores as agent-reported evidence there.
const GEPA_RUNNER_MATERIALIZATION_PAIRS = [
  { versionFlag: '--runner-version-id', dirFlag: '--candidate-runner-dir' },
  { versionFlag: '--scorer-runner-version-id', dirFlag: '--scorer-runner-dir' },
] as const

async function materializeMissingGepaRunnerDirs(args: string[]): Promise<{
  args: string[]
  cleanup: () => void
}> {
  const rewritten = [...args]
  const cleanups: Array<() => void> = []
  const cleanup = () => cleanupAll(
    cleanups,
    'Failed to clean materialized runner directories'
  )

  try {
    for (const pair of GEPA_RUNNER_MATERIALIZATION_PAIRS) {
      const runnerVersionId = extractFlagValue(rewritten, pair.versionFlag)
      const runnerDir = extractFlagValue(rewritten, pair.dirFlag)
      if (!runnerVersionId || runnerDir) continue

      const materialized = await materializeRunnerVersion(runnerVersionId)
      cleanups.push(materialized.cleanup)
      rewritten.push(pair.dirFlag, materialized.runnerDir)
    }
  } catch (error) {
    throwWithCleanup(
      error,
      cleanups,
      'Runner materialization failed and cleanup also failed'
    )
  }

  return { args: rewritten, cleanup }
}

async function runGepaOptimization() {
  const project = getArg('--project') || await resolveProjectSlug(null)
  const baseUrl = getBaseUrl()
  const runGepa = getGepaPythonCommand(cliArgs.slice(2), process.env)
  const python = runGepa.python
  let forwardedArgs = runGepa.args
  // ALI-1159 (ADR-007): GEPA executes ad-hoc local runner dirs while
  // attributing records to registered runner version ids — verify the bytes
  // ARE those versions before the optimizer spawns. Scans the forwarded argv
  // itself (both argparse flag forms), fail-closed on half-populated pairs,
  // and REWRITES the dir flags to verified snapshots (the exact hashed bytes)
  // so a post-hash mutation of the original dirs cannot change what runs.
  const materialized = await materializeMissingGepaRunnerDirs(forwardedArgs)
  let verified: GepaVerifiedArgs | undefined
  let selectedEngine = 'official'
  try {
    verified = await verifyGepaRunnerDirsFromArgs(materialized.args)
    forwardedArgs = verified.args
    // Uniform resolution (ALI-1090): honors ORIZU_TOKEN / ORIZU_TOKEN_FILE before
    // credentials.json so hosted sandboxes can run optimizations. Read at spawn
    // time — AFTER the verification awaits above, so a hosted token-file
    // rotation crossing the hash + lookup round-trips cannot hand the child a
    // stale bearer.
    const token = resolveAuthTokenForBaseUrl(baseUrl)
    if (!forwardedArgs.includes('--project')) {
      forwardedArgs = ['--project', project, ...forwardedArgs]
    }
    const dispatch = applyHostedInstructionSetProfileOverride(dispatchGepaEngine(forwardedArgs, project, {
      ...process.env,
      ORIZU_API_URL: baseUrl,
      ORIZU_TOKEN: token,
      ORIZU_PROJECT: project,
      ORIZU_VERIFIED_RUNNER_DIRS: JSON.stringify(verified.verifiedDirs),
      PYTHONPATH: getGepaPythonPathEntries(process.env.PYTHONPATH).join(delimiter),
      PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED || '1',
    }))
    const instructionSetProfileVersionId = await resolveGepaSeedFromEnvironment(dispatch.environment, project, 'production')
    if (instructionSetProfileVersionId) dispatch.environment.ORIZU_INSTRUCTION_SET_PROFILE_VERSION_ID = instructionSetProfileVersionId
    selectedEngine = dispatch.engine
    const launch = prepareSkilledProposerLaunch(python, dispatch.engine, dispatch.environment)
    const result = await spawnSkilledProposerChild(
      launch.python, ['-m', dispatch.module, ...dispatch.args], dispatch.engine, launch.environment,
    )
    if (result.error) {
      throw new Error(`${selectedEngine} GEPA engine failed: ${result.error.message}`, { cause: result.error })
    }
    if (result.status !== 0) {
      throw new Error(`${selectedEngine} GEPA engine failed with exit code ${result.status}`)
    }
  } catch (error) {
    throwWithCleanup(
      error,
      [
        ...(verified ? [verified.cleanup] : []),
        materialized.cleanup,
      ],
      'GEPA launch failed and runner cleanup also failed'
    )
  }
  cleanupAll(
    [verified.cleanup, materialized.cleanup],
    'Failed to clean GEPA runner directories'
  )
  if (hasJsonFlag()) {
    printJson({ status: 'completed', exitCode: 0 })
  }
}

function createReportCommentsCliContext(): ReportCommentsCliContext {
  return {
    getArg,
    getRawArgs: () => cliArgs,
    getPositionalArg,
    rejectDashPrefixedOptionValue,
    resolveProjectSlug,
    readSourceFile,
    authedFetch,
    parseJsonResponse,
    hasJsonFlag,
    printJson,
    printLine,
    sanitizeTerminalText,
  }
}

function printCapabilities() {
  const capabilities = getCapabilities(getCliVersion())
  if (hasJsonFlag()) {
    printLine(JSON.stringify(capabilities))
    return
  }

  printLine('orizu capabilities')
  printLine('')
  printLine('Run `orizu capabilities --json` for a machine-readable command manifest.')
  printLine('')
  for (const command of capabilities.commands) {
    printLine(`  ${command.name.padEnd(34)} ${command.help}`)
  }
}

export function readRunnerManifest(runnerDir: string): { command: string[]; supports_body_kind?: string[] } {
  const manifestPath = join(runnerDir, 'manifest.json')
  const raw = readSourceFile(manifestPath)
  const manifest = JSON.parse(raw) as {
    command?: unknown
    supports_body_kind?: unknown
    supports_body_kinds?: unknown
  }

  if (!Array.isArray(manifest.command) || !manifest.command.every(item => typeof item === 'string')) {
    throw new Error(`Runner manifest at ${manifestPath} must include command: string[]`)
  }

  const supportedBodyKinds = manifest.supports_body_kinds ?? manifest.supports_body_kind
  if (
    supportedBodyKinds !== undefined &&
    (!Array.isArray(supportedBodyKinds) ||
      !supportedBodyKinds.every(item => typeof item === 'string'))
  ) {
    throw new Error(`Runner manifest at ${manifestPath} has invalid supports_body_kinds`)
  }

  return {
    command: manifest.command,
    supports_body_kind: supportedBodyKinds as string[] | undefined,
  }
}

export const RUNNER_TIMEOUT_MS = 120_000
export const RUNNER_OUTPUT_MAX_BYTES = 2 * 1024 * 1024
export function runnerSubprocessEnv(inputPath: string, outputPath: string, instructionSetDir?: string): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv
  const allowlist = effectiveRunnerEnvAllowlist()
  reportStrippedRunnerCredentials(allowlist)
  for (const key of allowlist) {
    const value = process.env[key]
    if (value !== undefined) {
      env[key] = value
    }
  }
  env.ORIZU_RUNNER_INPUT_PATH = inputPath
  env.ORIZU_RUNNER_OUTPUT_PATH = outputPath
  delete env.ORIZU_INSTRUCTION_SET_DIR
  if (instructionSetDir) env.ORIZU_INSTRUCTION_SET_DIR = instructionSetDir
  return env
}

function boundedRunnerOutput(value: string | Buffer | null | undefined): string {
  if (!value) return ''
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
  if (buffer.byteLength <= RUNNER_OUTPUT_MAX_BYTES) {
    return buffer.toString('utf8')
  }
  return `${buffer.subarray(0, RUNNER_OUTPUT_MAX_BYTES).toString('utf8')}\n[truncated]`
}

async function runnersExec() {
  const prompt = getArg('--prompt')
  const promptVersion = getArg('--prompt-version')
  const runnerVersion = getArg('--runner-version')
  const scorerVersion = getArg('--scorer-version')
  const datasetVersion = getArg('--dataset-version')
  const splitSet = getArg('--split-set')
  const split = getArg('--split')
  const runnerDirArg = getArg('--runner-dir')
  const outArg = getArg('--out')

  if (
    (!prompt && !promptVersion && !scorerVersion) ||
    (scorerVersion && (prompt || promptVersion)) ||
    (promptVersion && !runnerVersion) ||
    !datasetVersion ||
    !splitSet ||
    !split ||
    !outArg
  ) {
    throw new Error(
      'Usage: orizu runners exec (--prompt <prompt> | --prompt-version <id> --runner-version <id> | --scorer-version <id>) --dataset-version <id> --split-set <id-or-name> --split <name> [--runner-dir <dir>] --out <results.jsonl|results.jsonl.gz>'
    )
  }

  const query = new URLSearchParams()
  if (scorerVersion) {
    query.set('scorerVersion', scorerVersion)
  } else if (promptVersion) {
    query.set('promptVersion', promptVersion)
  } else if (prompt) {
    query.set('prompt', prompt)
  }
  if (runnerVersion) {
    query.set('runnerVersion', runnerVersion)
  }
  query.set('datasetVersion', datasetVersion)
  query.set('splitSet', splitSet)
  query.set('split', split)
  const contextResponse = await authedFetch(`/api/cli/runners/exec-context?${query.toString()}`)
  if (!contextResponse.ok) {
    throw new Error(`Failed to fetch runner execution context: ${await contextResponse.text()}`)
  }

  const context = await parseJsonResponse<RunnerExecContext>(contextResponse, 'Runner exec context')
  const resolvedRunnerVersionId = runnerVersion || context.prompt.runnerVersionId
  if (!resolvedRunnerVersionId) {
    throw new Error('Runner exec context did not resolve a runner version id; pass --runner-version explicitly')
  }
  // ALI-1159 (ADR-007): results stamp the registered runner_version_id, so
  // ad-hoc --runner-dir bytes must BE that registered version — and execution
  // runs the verified SNAPSHOT (exact hashed bytes), never the mutable dir.
  const materializedRunner = runnerDirArg
    ? await (async () => {
        const verified = await verifyRunnerDirRegistered({
          runnerVersionId: resolvedRunnerVersionId,
          dir: runnerDirArg,
          flag: '--runner-dir',
        })
        return { runnerDir: verified.snapshotDir, cleanup: verified.cleanup }
      })()
    : await materializeRunnerVersion(resolvedRunnerVersionId)
  const runnerDir = materializedRunner.runnerDir
  try {
    assertSnapshotManifestConfined(runnerDir, runnerDirArg ? '--runner-dir' : '--runner-version')
    // Inside the try (codex round-6 P3): a bad manifest must not leak the dir.
    const manifest = readRunnerManifest(runnerDir)
    if (manifest.supports_body_kind && !manifest.supports_body_kind.includes(context.prompt.bodyKind)) {
      throw new Error(
        `Runner does not support prompt body kind '${context.prompt.bodyKind}'. Supported kinds: ${manifest.supports_body_kind.join(', ')}`
      )
    }
    const resultLines: string[] = []
    for (const row of context.rows) {
      const tempDir = mkdtempSync(join(tmpdir(), 'orizu-runner-'))
      const inputPath = join(tempDir, 'input.json')
      const outputPath = join(tempDir, 'output.json')
      const instructionSetDir = context.instructionSet ? join(tempDir, 'instruction-set') : undefined
      try {
        const modelOutput = row.row.model_output ?? row.row.modelOutput ?? row.row.output ?? null
        if (instructionSetDir && context.instructionSet) syncToDisk(instructionSetDir, runnerInstructionSetSyncSet(context.instructionSet))
        writeFileSync(inputPath, JSON.stringify({
          row: row.row,
          prompt: runnerInputPrompt(context.prompt),
          ...(context.instructionSet ? { instruction_set: runnerInputInstructionSet(context.instructionSet) } : {}),
          subject: scorerVersion
            ? {
                type: 'scorer_row',
                row_id: row.id,
                scorer_version_id: context.scorer?.versionId || scorerVersion,
                prompt_version_id: context.prompt.promptVersionId,
              }
            : {
                type: 'prompt_version',
                row_id: row.id,
                prompt_version_id: context.prompt.promptVersionId,
              },
          scorer: scorerVersion
            ? {
                version_id: context.scorer?.versionId || scorerVersion,
                metric_key: context.scorer?.metricKey || 'score',
                higher_is_better: context.scorer?.higherIsBetter ?? true,
              }
            : null,
          model_output: modelOutput,
          prompt_version_id: context.prompt.promptVersionId,
          runner_version_id: context.prompt.runnerVersionId,
          run_id: null,
        }))

        const result = spawnSync(manifest.command[0], manifest.command.slice(1), {
          cwd: runnerDir,
          env: runnerSubprocessEnv(inputPath, outputPath, instructionSetDir),
          encoding: 'utf8',
          maxBuffer: RUNNER_OUTPUT_MAX_BYTES,
          timeout: RUNNER_TIMEOUT_MS,
        })

        if (result.error) {
          throw result.error
        }

        if (result.status !== 0) {
          throw new Error(
            `Runner failed for row ${row.id} with exit code ${result.status}: ${sanitizeTerminalText(boundedRunnerOutput(result.stderr || result.stdout))}`
          )
        }

        const runnerOutput = JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, unknown>
        // Spread runner output first: the scorer/prompt context identity fields
        // (row_id, version ids, metric_key) are authoritative, never runner-overridable.
        resultLines.push(JSON.stringify({
          ...runnerOutput,
          row_id: row.id,
          prompt_version_id: context.prompt.promptVersionId,
          runner_version_id: context.prompt.runnerVersionId,
          ...(scorerVersion
            ? { scorer_version_id: context.scorer?.versionId || scorerVersion, metric_key: context.scorer?.metricKey || 'score' }
            : {}),
        }))
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    }

    const outPath = expandHomePath(outArg)
    const resultJsonl = `${resultLines.join('\n')}${resultLines.length > 0 ? '\n' : ''}`
    if (outPath.endsWith('.gz')) {
      writeFileSync(outPath, gzipSync(Buffer.from(resultJsonl, 'utf8')))
    } else {
      writeFileSync(outPath, resultJsonl)
    }
    if (hasJsonFlag()) {
      printJson({ rowCount: context.rows.length, out: outPath })
    } else {
      printLine(`Wrote ${context.rows.length} runner results to ${sanitizeTerminalText(outPath)}`)
    }
  } finally {
    materializedRunner.cleanup()
  }
}

function isHelpToken(value: string): boolean {
  return value === '--help' || value === '-h'
}

function extractHelpTarget(args: string[]): string[] | null {
  if (args[0] === 'help') {
    return helpTargetFromArgs(args.slice(1))
  }

  if (!args.some(isHelpToken)) {
    return null
  }

  return helpTargetFromArgs(args)
}

function helpTargetFromArgs(args: string[]): string[] {
  const targetArgs = args.filter(arg => !isHelpToken(arg) && arg !== '--json')
  const optionIndex = targetArgs.findIndex(arg => arg.startsWith('-'))
  return optionIndex === -1 ? targetArgs : targetArgs.slice(0, optionIndex)
}

export async function main(rawArgs = process.argv.slice(2)) {
  const parsed = parseGlobalFlags(rawArgs)
  setGlobalFlags(parsed.flags)
  setCommandLineArguments(
    parsed.args[0] === '--json' ? parsed.args.slice(1) : parsed.args,
    parsed.args[0] === '--json',
  )

  const helpTarget = extractHelpTarget(cliArgs)
  if (helpTarget !== null) {
    if (helpTarget.length === 0) {
      printBannerIfInteractive()
    }
    printLine(renderHelpForArgs(helpTarget))
    return
  }

  const command = cliArgs[0]
  const subcommand = cliArgs[1]

  if (command === '--version' || command === '-v') {
    printVersion()
    return
  }

  if (!command) {
    printUsage()
    process.exit(1)
  }

  if (command === 'capabilities') {
    printCapabilities()
    return
  }

  if (command === 'update') {
    process.exitCode = await runUpdateCommand(rawArgs, { getCliVersion, json: hasJsonFlag(), printLine, printError })
    return
  }

  if (command === 'setup' && subcommand === 'prompt') {
    setupPromptCommand()
    return
  }

  if (command === 'setup') {
    await setupCommand()
    return
  }

  if (command === 'install-skill') {
    await installSkillCommand()
    return
  }

  if (command === 'skills' && subcommand === 'install') {
    await installSkillCommand()
    return
  }

  if (command === 'skills' && subcommand === 'path') {
    skillsPathCommand()
    return
  }

  if (command === 'skills' && subcommand === 'status') {
    skillsStatusCommand()
    return
  }

  if (command === 'skills' && subcommand === 'update') {
    await skillsUpdateCommand()
    return
  }

  if (command === 'login') {
    await login()
    return
  }

  if (command === 'logout') {
    await logout()
    return
  }

  if (command === 'whoami') {
    await whoami()
    return
  }

  if (command === 'feedback') {
    process.exitCode = await feedbackCommand(cliArgs.slice(1), { json: hasJsonFlag(), print: printLine, printErr: printError })
    return
  }

  if (command === 'env') {
    await printEnv()
    return
  }

  if (command === 'log') {
    await logOptimizationEvent()
    return
  }

  if (command === 'comments') {
    if (subcommand === 'diff') {
      await diffCommentsCommand(createReportCommentsCliContext())
      return
    }
    await reportCommentsCommand(subcommand, createReportCommentsCliContext())
    return
  }

  if (command === 'teams' && subcommand === 'list') {
    await listTeams()
    return
  }

  if (command === 'teams' && subcommand === 'create') {
    await createTeam()
    return
  }

  const teamsMembersAction = cliArgs[2]
  if (command === 'teams' && subcommand === 'members' && teamsMembersAction === 'list') {
    await listTeamMembers()
    return
  }
  if (command === 'teams' && subcommand === 'members' && teamsMembersAction === 'add') {
    await addTeamMember()
    return
  }
  if (command === 'teams' && subcommand === 'members' && teamsMembersAction === 'remove') {
    await removeTeamMember()
    return
  }
  if (command === 'teams' && subcommand === 'members' && teamsMembersAction === 'role') {
    await changeTeamMemberRole()
    return
  }

  if (command === 'projects' && subcommand === 'list') {
    await listProjects()
    return
  }

  if (command === 'projects' && subcommand === 'create') {
    await createProject()
    return
  }

  if (command === 'prompts' && subcommand === 'list') {
    await listPrompts()
    return
  }

  if (command === 'prompts' && subcommand === 'comments') {
    throwDeprecatedPromptCommentsCommand()
  }

  if (command === 'prompts' && subcommand === 'pull') {
    await pullPromptArtifact('prompt')
    return
  }

  if (command === 'prompts' && subcommand === 'push') {
    if (getArg('--session')) {
      await pushPromptArtifact('prompt')
      return
    }
    refusePromptMutation('push <manifest> --project <team/project>')
  }

  if (
    command === 'prompts' && subcommand === 'report' &&
    (cliArgs[2] === 'set' || cliArgs[2] === 'upload')
  ) {
    await promptReportCommand(cliArgs, {
      resolveProjectSlug, json: hasJsonFlag(), printJson, printLine,
    })
    return
  }

  if (command === 'prompts' && subcommand === 'archive') {
    refusePromptMutation('archive <slug-or-exact-name> --project <team/project>')
  }

  if (command === 'prompts' && subcommand === 'restore') {
    refusePromptMutation('restore <slug-or-exact-name> --project <team/project>')
  }

  if (command === 'prompts' && subcommand === 'labels' && cliArgs[2] === 'set') {
    if (getPositionalArg(4) === 'production') {
      refusePromptMutation('profiles promote <set> --project <team/project> --model-config <identity> --version <n>')
    }
    await setPromptLabel({
      getArg,
      getPositionalArg,
      json: hasJsonFlag(),
      printJson,
      printLine,
      resolveProjectSlug,
    })
    return
  }

  if (command === 'prompts' && subcommand === 'scorers' && cliArgs[2] === 'set-headline') {
    refusePromptMutation('scorers set-headline <set> --key <component-key> --scorer-version <id> --project <team/project>')
  }

  if (command === 'prompts' && subcommand === 'scorers' && cliArgs[2] === 'add') {
    refusePromptMutation('scorers add <set> --key <component-key> --scorer-version <id> --project <team/project>')
  }

  if (command === 'judges' && subcommand === 'list') {
    await listJudges()
    return
  }

  if (command === 'judges' && subcommand === 'pull') {
    await pullPromptArtifact('judge')
    return
  }

  if (command === 'judges' && subcommand === 'push') {
    await pushPromptArtifact('judge')
    return
  }

  if (
    ['apps', 'datasets', 'tasks', 'assignments', 'scorers', 'optimizations']
      .includes(command || '') &&
    (subcommand === 'archive' || subcommand === 'restore')
  ) {
    await archiveArtifactCommand(cliArgs, {
      json: hasJsonFlag(),
      print: printLine,
      resolveProjectSlug,
    })
    return
  }

  if (command === 'assignments' && subcommand === 'list') {
    await listAssignmentsCommand(cliArgs.slice(1), {
      json: hasJsonFlag(),
      print: printLine,
      resolveProjectSlug,
    })
    return
  }

  if (command === 'scorers') {
    const scorersExit = await scorersCommand(cliArgs, {
      list: listScorers, register: registerScorer, detail: showScorerDetail,
      labelsSet: setScorerLabel, exec: execScorer,
      verifyParity: args => verifyScorerParityCommand(args, {
        json: hasJsonFlag(), print: printLine, printErr: printError,
        materializeRunnerVersion, readRunnerManifest, runnerSubprocessEnv,
        timeoutMs: RUNNER_TIMEOUT_MS, maxOutputBytes: RUNNER_OUTPUT_MAX_BYTES,
      }),
    })
    if (scorersExit !== null) { process.exitCode = scorersExit; return }
  }

  if ((command === 'runners' || command === 'optimizers') && subcommand === 'push') {
    await pushRunnerArtifact(command === 'runners' ? 'runner' : 'optimizer')
    return
  }

  if ((command === 'runners' || command === 'optimizers') && (subcommand === 'pull' || subcommand === 'list')) {
    await runnerOptimizerCommand(cliArgs, { json: hasJsonFlag(), print: printLine, resolveProjectSlug }); return
  }

  if (command === 'runners' && subcommand === 'exec') {
    await runnersExec()
    return
  }

  if (command === 'runs' && subcommand === 'submit') {
    await submitRunResults()
    return
  }

  if (command === 'runs' && subcommand === 'list') {
    await listRuns()
    return
  }

  if (command === 'scores' && subcommand === 'submit') {
    await submitScoreResults()
    return
  }

  if (command === 'scores' && subcommand === 'accept') {
    await acceptScoreRunCommand(cliArgs.slice(2), { json: hasJsonFlag(), print: printLine, resolveProjectSlug })
    return
  }

  if (await dispatchHostedCommands(cliArgs, { environment: process.env, getArg, json: hasJsonFlag(), printJson, printLine, printErr: printError, resolveProjectSlug, setExitCode: code => { process.exitCode = code } })) return
  if (command === 'optimizations' && subcommand === 'start') {
    await startOptimizationRun()
    return
  }

  if (command === 'optimizations' && subcommand === 'run-gepa') {
    await runGepaOptimization()
    return
  }

  if (command === 'optimizations' && subcommand === 'export') {
    await exportOptimizationRunCommand({
      getArg,
      getPositionalArg,
      authedFetch,
      hasJsonFlag,
      printJson,
      printLine,
      expandHomePath,
      writeTextFileEnsuringDir,
      sanitizeTerminalText,
    })
    return
  }

  if (command === 'optimizations' && subcommand === 'list') {
    await listOptimizationRunsCommand(cliArgs.slice(2), { json: hasJsonFlag(), print: printLine, resolveProjectSlug })
    return
  }
  if (command === 'optimizations' && subcommand === 'promote') {
    await promoteOptimizationCommand(cliArgs.slice(2), {
      json: hasJsonFlag(), origin: parsed.flags, print: printLine, printErr: printError,
      resolveProjectSlug, fetcher: authedFetch,
    })
    return
  }
  if (
    command === 'optimizations' &&
    (
      subcommand === 'pause' ||
      subcommand === 'resume' ||
      subcommand === 'finish' ||
      subcommand === 'fail' ||
      subcommand === 'cancel'
    )
  ) {
    await updateOptimizationRunLifecycle(subcommand)
    return
  }

  if (command === 'apps' && subcommand === 'list') {
    await listApps()
    return
  }

  if (command === 'apps' && subcommand === 'create') {
    await createAppFromFile()
    return
  }

  if (command === 'apps' && subcommand === 'preview') {
    await previewAppFromFile()
    return
  }

  if (command === 'apps' && subcommand === 'update') {
    await updateAppFromFile()
    return
  }

  if (command === 'apps' && subcommand === 'link-dataset') {
    await linkAppDataset()
    return
  }

  if (command === 'apps' && subcommand === 'detail') {
    await appDetail()
    return
  }

  if (command === 'apps' && subcommand === 'export') {
    await exportAppSource()
    return
  }

  if (command === 'tasks' && subcommand === 'list') {
    await listTasks()
    return
  }

  if (command === 'tasks' && subcommand === 'create') {
    await createTask()
    return
  }

  if (command === 'tasks' && subcommand === 'update') {
    await updateTask()
    return
  }

  if (command === 'tasks' && subcommand === 'discard') {
    await discardTask()
    return
  }

  if (command === 'tasks' && subcommand === 'publish') {
    await publishTask()
    return
  }

  if (command === 'tasks' && subcommand === 'assign') {
    await assignTask()
    return
  }

  if (command === 'tasks' && subcommand === 'status') {
    await taskStatus()
    return
  }

  if (
    command === 'tasks' &&
    subcommand === 'report' &&
    (cliArgs[2] === 'set' || cliArgs[2] === 'upload')
  ) {
    await setTaskReport()
    return
  }

  if (command === 'tasks' && subcommand === 'report' && cliArgs[2] === 'get') {
    await getTaskReport()
    return
  }

  if (command === 'tasks' && subcommand === 'pause') { await updateTaskStatus('paused'); return }
  if (command === 'tasks' && subcommand === 'unpause') { await updateTaskStatus('active'); return }
  if (command === 'tasks' && subcommand === 'complete') { await updateTaskStatus('completed'); return }

  if (command === 'datasets' && subcommand === 'upload') {
    await uploadDataset()
    return
  }
  if (command === 'datasets' && subcommand === 'list') {
    await listDatasets()
    return
  }

  if (command === 'datasets' && subcommand === 'push') {
    await pushDataset()
    return
  }

  if (command === 'datasets' && subcommand === 'download') {
    await downloadDataset()
    return
  }
  if (command === 'datasets' && subcommand === 'append') {
    await appendDatasetRows()
    return
  }
  const datasetsAction = cliArgs[2]
  if (command === 'datasets' && subcommand === 'readme' && datasetsAction === 'set') {
    await setDatasetReadme()
    return
  }
  if (command === 'datasets' && subcommand === 'versions' && datasetsAction === 'create') {
    await createDatasetVersion()
    return
  }
  if (command === 'datasets' && subcommand === 'splits' && datasetsAction === 'create') {
    await createDatasetSplitSet()
    return
  }
  if (command === 'datasets' && subcommand === 'edit-rows') {
    await editDatasetRows()
    return
  }
  if (command === 'datasets' && subcommand === 'delete-rows') {
    await deleteDatasetRows()
    return
  }
  if (command === 'datasets' && subcommand === 'delete') {
    await deleteDataset()
    return
  }
  if (command === 'datasets' && subcommand === 'lock') { await lockDataset(); return }
  if (command === 'datasets' && subcommand === 'clone') { await cloneDataset(); return }
  if (command === 'tasks' && subcommand === 'export') { await downloadAnnotations(); return }
  if (command === 'session' || command === 'run') {
    process.exitCode = await workbenchCommand(cliArgs, { json: hasJsonFlag(), print: printLine })
    return
  }
  if (command === 'workspace') {
    process.exitCode = await workspaceSyncCommand(cliArgs.slice(1), { json: hasJsonFlag(), print: printLine })
    return
  }
  if (command === 'git-credential') { process.exitCode = await runGitCredentialInvocation(cliArgs.slice(1), { stdin: readFileSync(0, 'utf8'), cwd: process.cwd(), print: printLine, printErr: printError }); return }
  if (command === 'providers') {
    process.exitCode = await providersCommand(cliArgs.slice(1), { json: hasJsonFlag(), print: printLine, resolveProjectSlug })
    return
  }

  if (command === 'connectors' || command === 'manifests' || command === 'model-configs') {
    process.exitCode = await (command === 'connectors' ? connectorsCommand : command === 'manifests' ? manifestsCommand : modelConfigsCommand)(cliArgs.slice(1), { json: hasJsonFlag(), print: printLine, resolveProjectSlug })
    return
  }
  if (command === 'instructions' || command === 'instruction-sets') { process.exitCode = await instructionSetsCommand(cliArgs.slice(1), { json: hasJsonFlag(), print: printLine, resolveProjectSlug }); return }
  if (command === 'team' && (subcommand === 'kill-agents' || subcommand === 'release-agents')) {
    process.exitCode = await killSwitchCommand(cliArgs.slice(1), { json: hasJsonFlag(), print: printLine, printErr: printError })
    return
  }
  if (command === 'team' && subcommand === 'egress-allowlist') {
    // slice(2) drops BOTH 'team' and 'egress-allowlist' so firstPositional()
    // reads the team slug, not the literal 'egress-allowlist' (matches the
    // `team connectors` dispatch below).
    process.exitCode = await egressAllowlistCommand(cliArgs.slice(2), { json: hasJsonFlag(), print: printLine, printErr: printError })
    return
  }
  if (command === 'team' && subcommand === 'connectors') {
    process.exitCode = await teamConnectorsCommand(cliArgs.slice(2), {
      json: hasJsonFlag(),
      print: printLine,
      printErr: printError,
      resolveTeamSlug: async () => {
        const noInput = hasArg('--no-input') || hasArg('--non-interactive') || !isInteractiveTerminal()
        try {
          return (await resolveSetupTeam(getOptionalArgValue('--team'), null, noInput, false, null)).slug
        } catch {
          return null
        }
      },
    })
    return
  }

  printUsage()
  process.exit(1)
}

function normalizeLastErrorTeamSlug(teamSlug: string): string | null {
  const normalizedTeamSlug = normalizeSlugInput(teamSlug)
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(normalizedTeamSlug)
    ? normalizedTeamSlug
    : null
}

function resolveLastErrorTeamSlug(): string | null {
  try {
    const explicitTeam = getOptionalArgValue('--team')
    if (explicitTeam) return normalizeLastErrorTeamSlug(explicitTeam)

    const projectRef = getOptionalArgValue('--project') ?? process.env.ORIZU_PROJECT
    const projectSegments = projectRef?.split('/') ?? []
    if (projectSegments.length === 2 && projectSegments[0] && projectSegments[1]) {
      return normalizeLastErrorTeamSlug(projectSegments[0])
    }

    const workspaceTeam = inspectExistingWorkspaceTeam(getWorkspaceRoot())
    return workspaceTeam.state === 'valid'
      ? normalizeLastErrorTeamSlug(workspaceTeam.slug)
      : null
  } catch {
    return null
  }
}

function isCliEntrypoint(): boolean {
  const entry = process.argv[1]
  if (!entry) {
    return false
  }

  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isCliEntrypoint()) {
  const rawArgs = process.argv.slice(2)
  withPassiveUpdateNotice(rawArgs, getCliVersion, printError, args =>
    main(args).catch(error => {
      const message = error instanceof Error ? error.message : 'Unknown error'
      // The reporter email is unknown on the failure path, so the record masks every address.
      writeLastErrorRecord({
        argv: args,
        message,
        code: extractLastErrorCode(error),
        cliVersion: (() => { try { return getCliVersion() } catch { return null } })(),
        serverBaseUrl: getLastResolvedBaseUrl(),
        teamSlug: resolveLastErrorTeamSlug(),
      })
      throw error
    })
  )
}

export { normalizeSlugInput, expandHomePath } from './command-line-arguments.js'

export { createCodeChallenge, validateBrowserUrl, formatTerminalLink } from './auth-commands.js'
