import { Router } from 'express';
import { SETTINGS_FILE, readJson, writeJson } from '../lib/fileStore.js';

/** Strip all apiKey values before writing to disk. Keys live in the browser's IndexedDB only. */
function stripApiKeys(body) {
    if (!body || typeof body !== 'object') return body;
    const stripped = JSON.parse(JSON.stringify(body)); // deep clone
    const settings = stripped.settings;
    if (settings && Array.isArray(settings.presets)) {
        for (const preset of settings.presets) {
            for (const section of ['storyAI', 'imageAI', 'summarizerAI']) {
                if (preset[section]) preset[section].apiKey = '';
            }
        }
    }
    return stripped;
}

export function createSettingsRouter() {
    const router = Router();

    router.get('/api/settings', (_req, res) => {
        const settings = readJson(SETTINGS_FILE, {});
        res.json(settings);
    });

    router.put('/api/settings', (req, res) => {
        const sanitized = stripApiKeys(req.body);
        writeJson(SETTINGS_FILE, sanitized);
        res.json({ ok: true });
    });

    return router;
}
