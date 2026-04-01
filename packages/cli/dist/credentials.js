import { mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
function getConfigDir() {
    if (process.env.ORIZU_CONFIG_DIR) {
        return process.env.ORIZU_CONFIG_DIR;
    }
    return join(homedir(), '.config', 'orizu');
}
function getCredentialsPath() {
    return join(getConfigDir(), 'credentials.json');
}
function isStoredCredentialsV2(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const typed = value;
    return typed.version === 2 && !!typed.servers && typeof typed.servers === 'object';
}
function isStoredCredentialsV1(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const typed = value;
    return (typeof typed.baseUrl === 'string' &&
        typeof typed.accessToken === 'string' &&
        typeof typed.refreshToken === 'string' &&
        typeof typed.expiresAt === 'number');
}
function migrateToV2(stored) {
    return {
        version: 2,
        activeBaseUrl: stored.baseUrl,
        servers: {
            [stored.baseUrl]: {
                accessToken: stored.accessToken,
                refreshToken: stored.refreshToken,
                expiresAt: stored.expiresAt,
            },
        },
    };
}
function writeCredentials(config) {
    const dir = getConfigDir();
    mkdirSync(dir, { recursive: true });
    const path = getCredentialsPath();
    writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8');
    chmodSync(path, 0o600);
}
function createEmptyCredentialsConfig() {
    return {
        version: 2,
        activeBaseUrl: null,
        servers: {},
    };
}
function loadCredentialsConfigForWrite() {
    try {
        return loadCredentialsConfig() || createEmptyCredentialsConfig();
    }
    catch {
        return createEmptyCredentialsConfig();
    }
}
export function loadCredentialsConfig() {
    const path = getCredentialsPath();
    if (!existsSync(path)) {
        return null;
    }
    const raw = readFileSync(path, 'utf-8');
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        console.warn('Warning: credentials file contains invalid JSON — please re-login with `orizu login`');
        return null;
    }
    if (isStoredCredentialsV2(parsed)) {
        return parsed;
    }
    if (isStoredCredentialsV1(parsed)) {
        return migrateToV2(parsed);
    }
    console.warn('Warning: credentials file has unrecognized format — please re-login with `orizu login`');
    return null;
}
export function getServerCredentials(baseUrl) {
    const config = loadCredentialsConfig();
    if (!config) {
        return null;
    }
    if (!Object.hasOwn(config.servers, baseUrl)) {
        return null;
    }
    return config.servers[baseUrl] || null;
}
export function saveServerCredentials(baseUrl, credentials) {
    const config = loadCredentialsConfigForWrite();
    config.servers[baseUrl] = credentials;
    config.activeBaseUrl = baseUrl;
    writeCredentials(config);
}
export function updateServerCredentials(baseUrl, credentials) {
    const config = loadCredentialsConfigForWrite();
    config.servers[baseUrl] = credentials;
    writeCredentials(config);
}
export function getActiveBaseUrl() {
    const config = loadCredentialsConfig();
    return config?.activeBaseUrl || null;
}
export function setActiveBaseUrl(baseUrl) {
    const config = loadCredentialsConfigForWrite();
    config.activeBaseUrl = baseUrl;
    writeCredentials(config);
}
export function clearServerCredentials(baseUrl) {
    const config = loadCredentialsConfig();
    if (!config || !Object.hasOwn(config.servers, baseUrl)) {
        return false;
    }
    delete config.servers[baseUrl];
    if (config.activeBaseUrl === baseUrl) {
        config.activeBaseUrl = null;
    }
    writeCredentials(config);
    return true;
}
export function clearCredentialsFile() {
    const path = getCredentialsPath();
    if (existsSync(path)) {
        rmSync(path);
    }
}
