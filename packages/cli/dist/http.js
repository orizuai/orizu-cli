import { getActiveBaseUrl, getServerCredentials, updateServerCredentials } from './credentials.js';
import { getFlagBaseUrl, normalizeBaseUrl } from './global-flags.js';
let runtimeFlags = { local: false, server: null };
export function setGlobalFlags(flags) {
    runtimeFlags = flags;
}
export function resolveBaseUrl(flags = runtimeFlags) {
    const fromFlags = getFlagBaseUrl(flags);
    if (fromFlags) {
        return fromFlags;
    }
    const fromEnv = process.env.ORIZU_BASE_URL;
    if (fromEnv) {
        return normalizeBaseUrl(fromEnv);
    }
    const fromStored = getActiveBaseUrl();
    if (fromStored) {
        return fromStored;
    }
    return 'https://orizu.ai';
}
export function resolveLoginBaseUrl(flags = runtimeFlags) {
    const fromFlags = getFlagBaseUrl(flags);
    if (fromFlags) {
        return fromFlags;
    }
    const fromEnv = process.env.ORIZU_BASE_URL;
    if (fromEnv) {
        return normalizeBaseUrl(fromEnv);
    }
    return 'https://orizu.ai';
}
export function getBaseUrl() {
    return resolveBaseUrl();
}
function isExpired(expiresAt) {
    const nowUnix = Math.floor(Date.now() / 1000);
    return expiresAt <= nowUnix + 30;
}
async function refreshCredentials(baseUrl, credentials) {
    const response = await fetch(`${baseUrl}/api/cli/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: credentials.refreshToken }),
    });
    if (!response.ok) {
        throw new Error('Session expired. Run `orizu login` again.');
    }
    const data = await response.json();
    const refreshed = {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: data.expiresAt,
    };
    updateServerCredentials(baseUrl, refreshed);
    return refreshed;
}
export async function authedFetch(path, init = {}) {
    const baseUrl = resolveBaseUrl();
    const credentials = getServerCredentials(baseUrl);
    if (!credentials) {
        throw new Error(`Not logged in for ${baseUrl}. Run \`orizu login --server ${baseUrl}\` (or \`--local\`) first.`);
    }
    let activeCredentials = credentials;
    if (isExpired(activeCredentials.expiresAt)) {
        activeCredentials = await refreshCredentials(baseUrl, activeCredentials);
    }
    let response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
            ...(init.headers || {}),
            Authorization: `Bearer ${activeCredentials.accessToken}`,
        },
    });
    if (response.status === 401) {
        activeCredentials = await refreshCredentials(baseUrl, activeCredentials);
        response = await fetch(`${baseUrl}${path}`, {
            ...init,
            headers: {
                ...(init.headers || {}),
                Authorization: `Bearer ${activeCredentials.accessToken}`,
            },
        });
    }
    return response;
}
