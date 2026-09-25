// ORI-2044: moved from index.ts to keep task commands together.

import { readMarkdownReportInput } from './markdown-report-input.js'
import {
  cliArgs,
  getArg,
  getArchiveListStatus,
  hasJsonFlag,
  expandHomePath,
  rejectDashPrefixedOptionValue,
  hasArg,
  isInteractiveTerminal,
} from './command-line-arguments.js'
import { fetchTasks, printTaskStatusSummary, TASK_STATUS_ACTION_LABELS } from './account-directory.js'
import { printJson, printLine } from './cli-console-output.js'
import { printTaskSummaries } from './archive-artifacts-cli.js'
import { readAssignmentManifestJsonlFile } from './task-assignment-manifest.js'
import { readSourceFile } from './app-commands.js'
import { authedFetch, getBaseUrl } from './http.js'
import { formatTaskCreateError } from './task-create-error.js'
import { parseJsonResponse, sanitizeTerminalText } from './json-response.js'
import { shellQuote } from './auth-commands.js'
import { extractErrorMessage } from './error-response.js'
import { askYesNo } from './setup-and-skills-commands.js'
import type { TaskStatusPayload } from './account-directory.js'



interface TaskReportPayload {
  task: {
    id: string
    title?: string | null
    status?: string | null
    report: {
      markdown: string
      sourceName: string | null
      createdAt: string | null
      updatedAt?: string | null
    }
  }
}

function readTaskReportInput(): { markdown: string; sourceName: string | null } | null {
  return readMarkdownReportInput(cliArgs, 'Task')
}

async function listTasks() {
  const project = getArg('--project')
  const tasks = await fetchTasks(
    project || undefined,
    getArchiveListStatus('tasks')
  )
  if (hasJsonFlag()) {
    printJson({ tasks })
    return
  }
  printTaskSummaries(tasks, printLine)
}

function parseCommaSeparated(value: string | null): string[] {
  if (!value) {
    return []
  }
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function readAssignmentManifest(path: string | null): ReturnType<typeof readAssignmentManifestJsonlFile> | null {
  if (!path) {
    return null
  }

  return readAssignmentManifestJsonlFile(expandHomePath(path))
}

function readOptionalTaskTextArg(
  valueFlag: string,
  fileFlag: string
): string | undefined {
  const value = getArg(valueFlag)
  const file = getArg(fileFlag)
  rejectDashPrefixedOptionValue(valueFlag, value)
  rejectDashPrefixedOptionValue(fileFlag, file)

  if (value !== null && file !== null) {
    throw new Error(`Use either ${valueFlag} or ${fileFlag}, not both.`)
  }

  if (file !== null) {
    return readSourceFile(file)
  }

  return value ?? undefined
}

function readPositiveIntegerFlag(name: string): number | undefined {
  const value = getArg(name)
  rejectDashPrefixedOptionValue(name, value)
  if (value === null) {
    return undefined
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`)
  }

  return parsed
}

async function createTask() {
  const projectSlug = getArg('--project')
  const datasetId = getArg('--dataset')
  const appId = getArg('--app')
  const title = getArg('--title')
  const assignees = parseCommaSeparated(getArg('--assignees'))
  const assignmentFile = getArg('--assignment-file')
  const publish = hasArg('--publish')
  const versionArg = getArg('--version')
  const instructions = getArg('--instructions')
  const labelsPerItemArg = getArg('--labels-per-item')
  const parsedLabelsPerItem = labelsPerItemArg ? Number(labelsPerItemArg) : 1
  const labelsPerItem =
    Number.isInteger(parsedLabelsPerItem) && parsedLabelsPerItem > 0
      ? parsedLabelsPerItem
      : null
  const parsedVersionNum = versionArg ? Number(versionArg) : Number.NaN
  const versionNum =
    Number.isInteger(parsedVersionNum) && parsedVersionNum > 0 ? parsedVersionNum : null

  if (assignmentFile && assignees.length > 0) {
    throw new Error('Use either --assignment-file or --assignees, not both.')
  }

  const explicitAssignments = readAssignmentManifest(assignmentFile)

  if (!projectSlug || !datasetId || !appId || !title || (publish && assignees.length === 0 && !explicitAssignments)) {
    throw new Error('Usage: orizu tasks create --project <team/project> --dataset <datasetId> --app <appId> --title <title> [--assignees <userIdOrEmail1,userIdOrEmail2> | --assignment-file <path>] [--publish] [--version <n>] [--instructions <text>] [--labels-per-item <n>] [--json]')
  }

  if (versionArg && versionNum === null) {
    throw new Error('--version must be a positive integer')
  }

  if (labelsPerItemArg && labelsPerItem === null) {
    throw new Error('--labels-per-item must be a positive integer')
  }

  const requestBody: Record<string, unknown> = {
    projectSlug,
    datasetId,
    appId,
    versionNum,
    title,
    publish,
    instructions,
  }

  if (explicitAssignments) {
    requestBody.explicitAssignments = explicitAssignments
  } else {
    requestBody.memberIds = assignees
  }

  if (!explicitAssignments || labelsPerItemArg) {
    requestBody.requiredAssignmentsPerRow = labelsPerItem
  }

  const response = await authedFetch('/api/cli/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })

  if (!response.ok) {
    const cliError = await formatTaskCreateError(response)
    if (hasJsonFlag()) {
      const payload = cliError.structuredPayload ?? { error: cliError.message }
      printLine(JSON.stringify({
        ...payload,
        httpStatus: cliError.httpStatus,
      }, null, 2))
    }
    throw cliError
  }

  const data = await parseJsonResponse<{
    task: {
      id: string
      title: string
      status: string
      requiredAssignmentsPerRow: number
      versionId: string
      versionNum: number
    }
    assignmentsCreated: number
    assignmentShortfall?: number
    warning?: string
  }>(response, 'Task create')

  if (hasJsonFlag()) {
    printLine(JSON.stringify({
      taskId: data.task.id,
      datasetId,
      versionId: data.task.versionId,
      versionNum: data.task.versionNum,
      taskUrl: `${getBaseUrl()}/d/${projectSlug}/tasks/${data.task.id}`,
      title: data.task.title,
      status: data.task.status,
      assignmentMode: explicitAssignments ? 'custom' : 'auto',
      requiredAssignmentsPerRow: data.task.requiredAssignmentsPerRow,
      assignmentsCreated: data.assignmentsCreated,
      draft: data.task.status === 'draft',
      ...(data.task.status === 'draft'
        ? {
            message: 'Draft created. Test it manually before assigning.',
            publishCommand: explicitAssignments
              ? `orizu tasks publish --task ${data.task.id} --assignment-file ${assignmentFile ? shellQuote(assignmentFile) : '<path>'}`
              : `orizu tasks publish --task ${data.task.id} --assignees <userId1,userId2>`,
          }
        : {}),
      ...(data.assignmentShortfall !== undefined ? { assignmentShortfall: data.assignmentShortfall } : {}),
      ...(data.warning ? { warning: data.warning } : {}),
    }, null, 2))
    return
  }

  const baseUrl = getBaseUrl()
  const taskUrl = `${baseUrl}/d/${projectSlug}/tasks/${data.task.id}`
  const isDraft = data.task.status === 'draft'
  printLine(
    `Created ${isDraft ? 'draft ' : ''}task ${sanitizeTerminalText(data.task.title)} (${sanitizeTerminalText(data.task.id)}) [${sanitizeTerminalText(data.task.status)}]` +
    `\n  Task ID:    ${sanitizeTerminalText(data.task.id)}` +
    `\n  Dataset ID: ${sanitizeTerminalText(datasetId)}` +
    `\n  Version:    v${data.task.versionNum} (${sanitizeTerminalText(data.task.versionId)})` +
    `\n  Mode:       ${explicitAssignments ? 'custom row map' : 'auto distribute'}` +
    `\n  Labels/row: ${data.task.requiredAssignmentsPerRow}` +
    `\n  Assignments: ${data.assignmentsCreated}` +
    (data.warning ? `\n  Warning:    ${sanitizeTerminalText(data.warning)}` : '') +
    `\n  URL:        ${sanitizeTerminalText(taskUrl)}` +
    (isDraft
      ? `\n\nThis task is a draft. Test it manually before assigning.\nPublish after approval: ${
          explicitAssignments
            ? `orizu tasks publish --task ${sanitizeTerminalText(data.task.id)} --assignment-file ${sanitizeTerminalText(assignmentFile || '<path>')}`
            : `orizu tasks publish --task ${sanitizeTerminalText(data.task.id)} --assignees <userId1,userId2>`
        }`
      : '')
  )
}

async function updateTask() {
  const taskId = getArg('--task')
  rejectDashPrefixedOptionValue('--task', taskId)
  if (!taskId) {
    throw new Error('Usage: orizu tasks update --task <taskId> [--title <text>] [--description <text>|--description-file <path>] [--instructions <text>|--instructions-file <path>] [--dataset <datasetId>] [--app <appId> [--version <n>]] [--labels-per-item <n>] [--assignees <userIdOrEmail1,userIdOrEmail2> | --assignment-file <path>] [--json]')
  }

  const title = getArg('--title')
  const description = readOptionalTaskTextArg('--description', '--description-file')
  const instructions = readOptionalTaskTextArg('--instructions', '--instructions-file')
  const datasetId = getArg('--dataset')
  const appId = getArg('--app')
  const versionNum = readPositiveIntegerFlag('--version')
  const requiredAssignmentsPerRow = readPositiveIntegerFlag('--labels-per-item')
  const assignees = parseCommaSeparated(getArg('--assignees'))
  const assignmentFile = getArg('--assignment-file')

  rejectDashPrefixedOptionValue('--title', title)
  rejectDashPrefixedOptionValue('--dataset', datasetId)
  rejectDashPrefixedOptionValue('--app', appId)
  rejectDashPrefixedOptionValue('--assignment-file', assignmentFile)

  if (title !== null && title.trim().length === 0) {
    throw new Error('--title must be a non-empty string')
  }

  if (assignmentFile && assignees.length > 0) {
    throw new Error('Use either --assignment-file or --assignees, not both.')
  }

  if (hasArg('--assignees') && assignees.length === 0) {
    throw new Error('--assignees requires at least one user ID or email')
  }

  if (versionNum !== undefined && !appId) {
    throw new Error('--version requires --app')
  }

  const explicitAssignments = readAssignmentManifest(assignmentFile)
  const requestBody: Record<string, unknown> = {}
  if (title !== null) requestBody.title = title.trim()
  if (description !== undefined) requestBody.description = description
  if (instructions !== undefined) requestBody.instructions = instructions
  if (datasetId !== null) requestBody.datasetId = datasetId
  if (appId !== null) requestBody.appId = appId
  if (versionNum !== undefined) requestBody.versionNum = versionNum
  if (requiredAssignmentsPerRow !== undefined) {
    requestBody.requiredAssignmentsPerRow = requiredAssignmentsPerRow
  }
  if (explicitAssignments) {
    requestBody.explicitAssignments = explicitAssignments
  } else if (hasArg('--assignees')) {
    requestBody.memberIds = assignees
  }

  if (Object.keys(requestBody).length === 0) {
    throw new Error('Usage: orizu tasks update --task <taskId> [--title <text>] [--description <text>|--description-file <path>] [--instructions <text>|--instructions-file <path>] [--dataset <datasetId>] [--app <appId> [--version <n>]] [--labels-per-item <n>] [--assignees <userIdOrEmail1,userIdOrEmail2> | --assignment-file <path>] [--json]')
  }

  const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })

  if (!response.ok) {
    throw new Error(`Failed to update task: ${await extractErrorMessage(response)}`)
  }

  const data = await parseJsonResponse<{
    task: {
      id: string
      title?: string | null
      status?: string | null
      dataset_id?: string | null
      app_id?: string | null
      version_id?: string | null
      required_assignments_per_row?: number | null
    }
    assignmentMode?: string
    assignmentsCreated?: number
  }>(response, 'Task update')

  if (hasJsonFlag()) {
    printJson({
      taskId: data.task.id,
      title: data.task.title ?? null,
      status: data.task.status ?? null,
      datasetId: data.task.dataset_id ?? null,
      appId: data.task.app_id ?? null,
      versionId: data.task.version_id ?? null,
      requiredAssignmentsPerRow: data.task.required_assignments_per_row ?? null,
      ...(data.assignmentMode ? { assignmentMode: data.assignmentMode } : {}),
      ...(data.assignmentsCreated !== undefined
        ? { assignmentsCreated: data.assignmentsCreated }
        : {}),
    })
    return
  }

  printLine(
    `Updated draft task ${sanitizeTerminalText(data.task.title || data.task.id)} (${sanitizeTerminalText(data.task.id)})` +
    (data.task.status ? ` [${sanitizeTerminalText(data.task.status)}]` : '') +
    (data.task.dataset_id ? `\n  Dataset ID: ${sanitizeTerminalText(data.task.dataset_id)}` : '') +
    (data.task.version_id ? `\n  Version ID: ${sanitizeTerminalText(data.task.version_id)}` : '') +
    (data.task.required_assignments_per_row
      ? `\n  Labels/row: ${data.task.required_assignments_per_row}`
      : '') +
    (data.assignmentMode ? `\n  Mode:       ${sanitizeTerminalText(data.assignmentMode === 'custom' ? 'custom row map' : 'auto distribute')}` : '') +
    (data.assignmentsCreated !== undefined ? `\n  Assignments: ${data.assignmentsCreated}` : '')
  )
}

async function discardTask() {
  const taskId = getArg('--task')
  rejectDashPrefixedOptionValue('--task', taskId)
  if (!taskId) {
    throw new Error('Usage: orizu tasks discard --task <taskId> [--yes] [--json]')
  }

  if (!hasArg('--yes')) {
    if (!isInteractiveTerminal()) {
      throw new Error('Refusing to discard a draft in non-interactive mode without --yes')
    }

    const confirmed = await askYesNo(`Discard draft task ${taskId}? This cannot be undone.`, false)
    if (!confirmed) {
      printLine('Discard cancelled.')
      return
    }
  }

  const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    throw new Error(`Failed to discard draft task: ${await extractErrorMessage(response)}`)
  }

  const data = await parseJsonResponse<{ success: boolean }>(response, 'Task discard')
  if (hasJsonFlag()) {
    printJson({ taskId, discarded: data.success })
    return
  }

  printLine(`Discarded draft task ${sanitizeTerminalText(taskId)}.`)
}

async function publishTask() {
  const taskId = getArg('--task')
  const assignees = parseCommaSeparated(getArg('--assignees'))
  const assignmentFile = getArg('--assignment-file')

  if (assignmentFile && assignees.length > 0) {
    throw new Error('Use either --assignment-file or --assignees, not both.')
  }

  const explicitAssignments = readAssignmentManifest(assignmentFile)

  if (!taskId || (assignees.length === 0 && !explicitAssignments)) {
    throw new Error('Usage: orizu tasks publish --task <taskId> (--assignees <userId1,userId2> | --assignment-file <path>) [--json]')
  }

  const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      explicitAssignments
        ? { explicitAssignments }
        : { memberIds: assignees }
    ),
  })

  if (!response.ok) {
    throw new Error(`Failed to publish task: ${await extractErrorMessage(response)}`)
  }

  const data = await parseJsonResponse<{
    task: { id: string; status: string }
    assignmentsProcessed: number
    assignmentsCreated: number
    assignmentsRemoved?: number
    assignmentShortfall?: number
    warning?: string
  }>(
    response,
    'Task publish'
  )

  if (hasJsonFlag()) {
    printLine(JSON.stringify({
      taskId: data.task.id,
      status: data.task.status,
      assignmentMode: explicitAssignments ? 'custom' : 'auto',
      assignmentsCreated: data.assignmentsCreated,
      assignmentsProcessed: data.assignmentsProcessed,
      ...(data.assignmentsRemoved !== undefined
        ? { assignmentsRemoved: data.assignmentsRemoved }
        : {}),
      ...(data.assignmentShortfall !== undefined
        ? { assignmentShortfall: data.assignmentShortfall }
        : {}),
      ...(data.warning ? { warning: data.warning } : {}),
    }, null, 2))
    return
  }

  printLine(
    `Published task ${sanitizeTerminalText(data.task.id)} [${sanitizeTerminalText(data.task.status)}]` +
    `\n  Mode:        ${explicitAssignments ? 'custom row map' : 'auto distribute'}` +
    `\n  Assignments: ${data.assignmentsCreated}` +
    (data.assignmentsRemoved !== undefined
      ? `\n  Replaced:    ${data.assignmentsRemoved} old assignments removed`
      : '') +
    (data.warning ? `\n  Warning:     ${sanitizeTerminalText(data.warning)}` : '')
  )
}

async function assignTask() {
  const taskId = getArg('--task')
  const assignees = parseCommaSeparated(getArg('--assignees'))
  const assignmentFile = getArg('--assignment-file')

  if (assignmentFile && assignees.length > 0) {
    throw new Error('Use either --assignment-file or --assignees, not both.')
  }

  const explicitAssignments = readAssignmentManifest(assignmentFile)

  if (!taskId || (assignees.length === 0 && !explicitAssignments)) {
    throw new Error('Usage: orizu tasks assign --task <taskId> (--assignees <userId1,userId2> | --assignment-file <path>) [--replace-existing] [--json]')
  }

  const requestBody: Record<string, unknown> = explicitAssignments
    ? { explicitAssignments }
    : { memberIds: assignees }
  if (hasArg('--replace-existing')) {
    requestBody.replaceExisting = true
  }

  const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })

  if (!response.ok) {
    throw new Error(`Failed to assign task: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    assignmentsProcessed?: number
    assignmentsCreated: number
    assignmentsRemoved?: number
    assignmentShortfall?: number
    warning?: string
  }>(response, 'Task assign')
  if (hasJsonFlag()) {
    printJson({
      assignmentMode: explicitAssignments ? 'custom' : 'auto',
      assignmentsProcessed: data.assignmentsProcessed ?? data.assignmentsCreated,
      assignmentsCreated: data.assignmentsCreated,
      ...(data.assignmentsRemoved !== undefined
        ? { assignmentsRemoved: data.assignmentsRemoved }
        : {}),
      ...(data.assignmentShortfall !== undefined
        ? { assignmentShortfall: data.assignmentShortfall }
        : {}),
      ...(data.warning ? { warning: data.warning } : {}),
    })
    return
  }
  printLine(
    `Created ${data.assignmentsCreated} assignments.` +
    `\n  Mode: ${explicitAssignments ? 'custom row map' : 'auto distribute'}` +
    (data.assignmentsRemoved !== undefined
      ? `\n  Replaced: ${data.assignmentsRemoved} old assignments removed`
      : '') +
    (data.warning ? `\n  Warning: ${sanitizeTerminalText(data.warning)}` : '')
  )
}

async function taskStatus() {
  const taskId = getArg('--task')
  if (!taskId) {
    throw new Error('Usage: orizu tasks status --task <taskId> [--json]')
  }

  const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}/status`)
  if (!response.ok) {
    const rawBody = await response.text()
    if (hasJsonFlag()) {
      let errorPayload: Record<string, unknown> = { error: rawBody }
      try {
        const parsed = JSON.parse(rawBody)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          errorPayload = parsed as Record<string, unknown>
        }
      } catch {
        // keep raw body as error
      }
      printLine(JSON.stringify({
        ...errorPayload,
        httpStatus: response.status,
      }, null, 2))
    }

    let errorMsg = rawBody
    try {
      const parsed = JSON.parse(rawBody)
      if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
        errorMsg = parsed.error
      }
    } catch { /* use rawBody as-is */ }
    throw new Error(`Failed to fetch task status: ${errorMsg}`)
  }

  const data = await parseJsonResponse<TaskStatusPayload>(response, 'Task status')
  if (hasJsonFlag()) {
    printLine(JSON.stringify(data, null, 2))
    return
  }

  printTaskStatusSummary(data)
}

async function updateTaskStatus(targetStatus: 'paused' | 'active' | 'completed') {
  const taskId = getArg('--task')
  const labels = TASK_STATUS_ACTION_LABELS[targetStatus]

  if (!taskId) {
    throw new Error(`Usage: orizu tasks ${labels.verb} --task <taskId>`)
  }

  const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: targetStatus }),
  })

  if (!response.ok) {
    throw new Error(`Failed to ${labels.verb} task: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ task: { id: string; status: string } }>(response, 'Task status update')
  if (hasJsonFlag()) {
    printJson({ task: data.task })
    return
  }
  printLine(`${labels.pastTense} task ${sanitizeTerminalText(data.task.id)} [${sanitizeTerminalText(data.task.status)}]`)
}

async function setTaskReport() {
  const taskId = getArg('--task')
  rejectDashPrefixedOptionValue('--task', taskId)
  if (!taskId) {
    throw new Error(
      'Usage: orizu tasks report set --task <taskId> (--report <markdown|@file> | --report-file <path>) [--json]'
    )
  }

  const report = readTaskReportInput()
  if (!report) {
    throw new Error(
      'Usage: orizu tasks report set --task <taskId> (--report <markdown|@file> | --report-file <path>) [--json]'
    )
  }

  const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}/report`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reportMarkdown: report.markdown,
      reportSourceName: report.sourceName,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to update task report: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    task: {
      id: string
      status: string
      report: {
        markdown: string
        sourceName: string | null
        createdAt: string | null
      }
    }
  }>(response, 'Task report update')

  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  printLine(
    `Uploaded task report for ${sanitizeTerminalText(data.task.id)} ` +
    `[${sanitizeTerminalText(data.task.status)}]`
  )
}

async function getTaskReport() {
  const taskId = getArg('--task')
  rejectDashPrefixedOptionValue('--task', taskId)
  if (!taskId) {
    throw new Error('Usage: orizu tasks report get --task <taskId> [--json]')
  }

  const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}/report`)
  if (!response.ok) {
    throw new Error(`Failed to read task report: ${await response.text()}`)
  }

  const data = await parseJsonResponse<TaskReportPayload>(response, 'Task report get')
  if (hasJsonFlag()) {
    printJson(data as unknown as Record<string, unknown>)
    return
  }

  const title = data.task.title ? `${data.task.title} ` : ''
  printLine(`Task report: ${sanitizeTerminalText(title)}(${sanitizeTerminalText(data.task.id)})`)
  if (data.task.status) {
    printLine(`Status: ${sanitizeTerminalText(data.task.status)}`)
  }
  if (data.task.report.sourceName) {
    printLine(`Source: ${sanitizeTerminalText(data.task.report.sourceName)}`)
  }
  if (data.task.report.createdAt) {
    printLine(`Created: ${sanitizeTerminalText(data.task.report.createdAt)}`)
  }
  printLine('')
  printLine(sanitizeTerminalText(data.task.report.markdown))
}

export {
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
}
