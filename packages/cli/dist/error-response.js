export async function extractErrorMessage(response) {
    const contentType = response.headers.get('content-type') || '';
    const rawBody = await response.text();
    if (contentType.includes('application/json')) {
        try {
            const payload = JSON.parse(rawBody);
            if (payload &&
                typeof payload === 'object' &&
                !Array.isArray(payload) &&
                typeof payload.error === 'string' &&
                payload.error.length > 0) {
                return payload.error;
            }
        }
        catch {
            // Fall through to raw body
        }
    }
    return rawBody;
}
