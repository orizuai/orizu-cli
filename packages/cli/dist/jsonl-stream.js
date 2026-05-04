import { createReadStream } from 'fs';
import { createInterface } from 'readline';
export const JSONL_UPLOAD_CHUNK_MAX_BYTES = 2 * 1024 * 1024;
function isObjectRow(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function rowsPayloadByteLength(rowCount, rowsByteLength) {
    return Buffer.byteLength('{"rows":[]}', 'utf8') +
        rowsByteLength +
        Math.max(0, rowCount - 1);
}
function formatMb(byteLength) {
    return (byteLength / (1024 * 1024)).toFixed(1);
}
function mapReadError(filePath, error) {
    const maybeError = error;
    if (!maybeError.code && error instanceof Error) {
        return error;
    }
    if (maybeError.code === 'ENOENT') {
        return new Error(`File not found: ${filePath}. Check the path and filename, then retry.`);
    }
    if (maybeError.code === 'EPERM' || maybeError.code === 'EACCES') {
        return new Error(`Cannot read file: ${filePath}. macOS may be blocking access to this folder (for example Downloads). Grant folder permission to your terminal app and retry.`);
    }
    return new Error(`Failed to read file ${filePath}: ${maybeError.message}`);
}
export function estimateRowsPayloadByteLength(rows) {
    const rowsByteLength = rows.reduce((total, row) => {
        return total + Buffer.byteLength(JSON.stringify(row), 'utf8');
    }, 0);
    return rowsPayloadByteLength(rows.length, rowsByteLength);
}
export async function* streamJsonlRowChunks(filePath, options = {}) {
    const maxPayloadBytes = options.maxPayloadBytes ?? JSONL_UPLOAD_CHUNK_MAX_BYTES;
    let chunk = [];
    let chunkRowsByteLength = 0;
    let parsedRowCount = 0;
    let lineNumber = 0;
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const lines = createInterface({
        input: stream,
        crlfDelay: Infinity,
    });
    try {
        for await (const line of lines) {
            lineNumber += 1;
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            let parsed;
            try {
                parsed = JSON.parse(trimmed);
            }
            catch {
                throw new Error(`Invalid JSONL at line ${lineNumber}`);
            }
            if (!isObjectRow(parsed)) {
                throw new Error(`Row ${lineNumber} must be a JSON object`);
            }
            const jsonByteLength = Buffer.byteLength(JSON.stringify(parsed), 'utf8');
            const singleRowPayloadBytes = rowsPayloadByteLength(1, jsonByteLength);
            if (singleRowPayloadBytes > maxPayloadBytes) {
                throw new Error(`Row ${lineNumber} is ${formatMb(singleRowPayloadBytes)} MB after JSON encoding, which exceeds the ${formatMb(maxPayloadBytes)} MB upload chunk limit`);
            }
            const nextPayloadBytes = rowsPayloadByteLength(chunk.length + 1, chunkRowsByteLength + jsonByteLength);
            if (chunk.length > 0 && nextPayloadBytes > maxPayloadBytes) {
                yield chunk.map(item => item.row);
                chunk = [];
                chunkRowsByteLength = 0;
            }
            chunk.push({ row: parsed, jsonByteLength });
            chunkRowsByteLength += jsonByteLength;
            parsedRowCount += 1;
        }
    }
    catch (error) {
        throw mapReadError(filePath, error);
    }
    finally {
        lines.close();
        stream.destroy();
    }
    if (chunk.length > 0) {
        yield chunk.map(item => item.row);
    }
    if (parsedRowCount === 0) {
        throw new Error('Dataset file contains no rows');
    }
}
