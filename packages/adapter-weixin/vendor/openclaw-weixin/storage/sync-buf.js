import fs from "node:fs";
import path from "node:path";
import { deriveRawAccountId } from "../auth/accounts.js";
import { resolveStateDir } from "./state-dir.js";
function resolveAccountsDir() {
    return path.join(resolveStateDir(), "openclaw-weixin", "accounts");
}
/**
 * Path to the persistent get_updates_buf file for an account.
 * Stored alongside account data: ~/.openclaw/openclaw-weixin/accounts/{accountId}.sync.json
 */
export function getSyncBufFilePath(accountId) {
    return path.join(resolveAccountsDir(), `${accountId}.sync.json`);
}
function readSyncBufFile(filePath) {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw);
        if (typeof data.get_updates_buf === "string") {
            return data.get_updates_buf;
        }
    }
    catch {
        // file not found or invalid
    }
    return undefined;
}
/**
 * Load persisted get_updates_buf.
 * Falls back in order:
 *   1. Primary path (normalized accountId, new installs)
 *   2. Compat path (raw accountId derived from pattern, old installs)
 */
export function loadGetUpdatesBuf(filePath) {
    const value = readSyncBufFile(filePath);
    if (value !== undefined)
        return value;
    // Compat: if given path uses a normalized accountId (e.g. "b0f5860fdecb-im-bot.sync.json"),
    // also try the old raw-ID filename (e.g. "b0f5860fdecb@im.bot.sync.json").
    const accountId = path.basename(filePath, ".sync.json");
    const rawId = deriveRawAccountId(accountId);
    if (rawId) {
        const compatPath = path.join(path.dirname(filePath), `${rawId}.sync.json`);
        const compatValue = readSyncBufFile(compatPath);
        if (compatValue !== undefined)
            return compatValue;
    }
    return undefined;
}
/**
 * Persist get_updates_buf. Creates parent dir if needed.
 */
export function saveGetUpdatesBuf(filePath, getUpdatesBuf) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ get_updates_buf: getUpdatesBuf }, null, 0), "utf-8");
}
