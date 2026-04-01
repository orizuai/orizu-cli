function createCliError(message, httpStatus, structuredPayload) {
    const error = new Error(message);
    error.httpStatus = httpStatus;
    error.structuredPayload = structuredPayload;
    return error;
}
export async function formatTaskCreateError(response) {
    const contentType = response.headers.get('content-type') || '';
    const rawBody = await response.text();
    const httpStatus = response.status;
    let parsedPayload;
    if (!contentType.includes('application/json')) {
        return createCliError(`Failed to create task: ${rawBody}`, httpStatus);
    }
    try {
        const payload = JSON.parse(rawBody);
        parsedPayload = payload;
        if (Array.isArray(payload.invalidAssigneeErrors) &&
            payload.invalidAssigneeErrors.length > 0) {
            const details = payload.invalidAssigneeErrors
                .filter(item => typeof item.assignee === 'string' &&
                item.assignee.length > 0 &&
                typeof item.reason === 'string' &&
                item.reason.length > 0)
                .map(item => `  - ${item.assignee}: ${item.reason}`)
                .join('\n');
            if (details) {
                return createCliError(`Failed to create task: ${payload.error || 'Invalid assignees'}\n${details}`, httpStatus, parsedPayload);
            }
        }
        if (Array.isArray(payload.missingRequiredFields) &&
            payload.missingRequiredFields.length > 0) {
            const lines = [
                `Failed to create task: ${payload.error || 'Dataset incompatible'}`,
            ];
            if (payload.versionNum !== undefined) {
                lines.push(`  Version: v${payload.versionNum} (${payload.versionId || 'unknown'})`);
            }
            lines.push(`  Missing required fields: ${payload.missingRequiredFields.join(', ')}`);
            if (typeof payload.incompatibleRowCount === 'number') {
                lines.push(`  Incompatible rows: ${payload.incompatibleRowCount}`);
            }
            if (payload.missingRequiredFieldCounts &&
                Object.keys(payload.missingRequiredFieldCounts).length > 0) {
                const fieldCounts = Object.entries(payload.missingRequiredFieldCounts)
                    .map(([field, count]) => `    ${field}: ${count} rows`)
                    .join('\n');
                lines.push(`  Missing field counts:\n${fieldCounts}`);
            }
            return createCliError(lines.join('\n'), httpStatus, parsedPayload);
        }
        if (typeof payload.error === 'string' && payload.error.length > 0) {
            return createCliError(`Failed to create task: ${payload.error}`, httpStatus, parsedPayload);
        }
    }
    catch {
        return createCliError(`Failed to create task: ${rawBody}`, httpStatus);
    }
    return createCliError(`Failed to create task: ${rawBody}`, httpStatus, parsedPayload);
}
