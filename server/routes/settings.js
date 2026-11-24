import { Router } from 'express';
import { SETTINGS_FILE, readJson, writeJson } from '../lib/fileStore.js';
import { wrapAsync } from '../lib/asyncHandler.js';

/**
 * Blank every `apiKey` string anywhere in the payload before it reaches disk.
 *
 * settings.json is plaintext. Keys belong in the browser (encrypted in
 * IndexedDB), never here. This used to blank only the three
 * legacy per-preset sections, so every key on the newer `settings.providers[]`
 * model was written to disk in the clear. Walking the whole object means a
 * future settings shape cannot reopen the hole.
 */
export function stripApiKeys(body) {
    if (!body || typeof body !== 'object') return body;
    const stripped = JSON.parse(JSON.stringify(body)); // deep clone
    blankApiKeys(stripped);
    return stripped;
}

function blankApiKeys(node) {
    if (Array.isArray(node)) {
        for (const item of node) blankApiKeys(item);
        return;
    }
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
        if (key === 'apiKey' && typeof node[key] === 'string') node[key] = '';
        else blankApiKeys(node[key]);
    }
}

/**
 * Keys in `settings` that only the server writes. The client saves its whole
 * settings object, which does not carry these, so a save used to erase them:
 *   embeddingDims / embeddingModelId — what the vector tables hold (vectorStore.js)
 *   embeddingModelKey                — the player's embedding model, changed only
 *                                      through /api/embedding/model so the switch
 *                                      can download first and then re-index.
 */
export const SERVER_OWNED_SETTING_KEYS = Object.freeze(['embeddingDims', 'embeddingModelId', 'embeddingModelKey']);

/** `incoming` with the server-owned keys taken from `existing`, never from the client. */
export function keepServerOwnedSettings(existing, incoming) {
    if (!incoming || typeof incoming !== 'object' || !incoming.settings || typeof incoming.settings !== 'object') {
        return incoming;
    }
    const merged = { ...incoming, settings: { ...incoming.settings } };
    for (const key of SERVER_OWNED_SETTING_KEYS) {
        const kept = existing?.settings?.[key];
        if (kept === undefined) delete merged.settings[key];
        else merged.settings[key] = kept;
    }
    return merged;
}

export function createSettingsRouter() {
    const router = Router();

    router.get('/api/settings', wrapAsync((_req, res) => {
        const settings = readJson(SETTINGS_FILE, {});
        res.json(settings);
    }));

    router.put('/api/settings', wrapAsync((req, res) => {
        const sanitized = keepServerOwnedSettings(readJson(SETTINGS_FILE, {}), stripApiKeys(req.body));
        writeJson(SETTINGS_FILE, sanitized);
        res.json({ ok: true });
    }));

    return router;
}
