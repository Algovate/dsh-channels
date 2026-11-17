import { decryptAesEcb } from "./aes-ecb.js";
import { buildCdnDownloadUrl, ENABLE_CDN_URL_FALLBACK } from "./cdn-url.js";
import { logger } from "../util/logger.js";
import { readBoundedResponse } from "../util/bounded-response.js";
const CDN_TIMEOUT_MS = 30_000;

// A complete encrypted file can be one AES block larger than its plaintext.
const MAX_CDN_BYTES = 100 * 1024 * 1024 + 16;

async function fetchCdnBytes(url, label, signal) {
    const timeout = AbortSignal.timeout(CDN_TIMEOUT_MS);
    const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        throw new Error(`${label}: CDN download ${res.status} ${res.statusText}`);
    }
    return readBoundedResponse(res, MAX_CDN_BYTES);
}
/**
 * Parse CDNMedia.aes_key into a raw 16-byte AES key.
 *
 * Two encodings are seen in the wild:
 *   - base64(raw 16 bytes)          → images (aes_key from media field)
 *   - base64(hex string of 16 bytes) → file / voice / video
 *
 * In the second case, base64-decoding yields 32 ASCII hex chars which must
 * then be parsed as hex to recover the actual 16-byte key.
 */
function parseAesKey(aesKeyBase64, label) {
    const decoded = Buffer.from(aesKeyBase64, "base64");
    if (decoded.length === 16) {
        return decoded;
    }
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
        // hex-encoded key: base64 → hex string → raw bytes
        return Buffer.from(decoded.toString("ascii"), "hex");
    }
    const msg = `${label}: aes_key must decode to 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`;
    logger.error(msg);
    throw new Error(msg);
}
/**
 * Download and AES-128-ECB decrypt a CDN media file. Returns plaintext Buffer.
 * aesKeyBase64: CDNMedia.aes_key JSON field (see parseAesKey for supported formats).
 */
export async function downloadAndDecryptBuffer(encryptedQueryParam, aesKeyBase64, cdnBaseUrl, label, fullUrl, signal) {
    const key = parseAesKey(aesKeyBase64, label);
    let url;
    if (fullUrl) {
        url = fullUrl;
    }
    else if (ENABLE_CDN_URL_FALLBACK) {
        url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
    }
    else {
        throw new Error(`${label}: fullUrl is required (CDN URL fallback is disabled)`);
    }
    const encrypted = await fetchCdnBytes(url, label, signal);
    logger.debug(`${label}: downloaded ${encrypted.byteLength} bytes, decrypting`);
    const decrypted = decryptAesEcb(encrypted, key);
    logger.debug(`${label}: decrypted ${decrypted.length} bytes`);
    return decrypted;
}
/**
 * Download plain (unencrypted) bytes from the CDN. Returns the raw Buffer.
 */
export async function downloadPlainCdnBuffer(encryptedQueryParam, cdnBaseUrl, label, fullUrl, signal) {
    let url;
    if (fullUrl) {
        url = fullUrl;
    }
    else if (ENABLE_CDN_URL_FALLBACK) {
        url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
    }
    else {
        throw new Error(`${label}: fullUrl is required (CDN URL fallback is disabled)`);
    }
    return fetchCdnBytes(url, label, signal);
}
