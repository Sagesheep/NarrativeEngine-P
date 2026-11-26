import { Router } from 'express';
import { readJson, writeJson, divergencePath } from '../lib/fileStore.js';
import { wrapAsync } from '../lib/asyncHandler.js';

export function createDivergenceRouter() {
    const router = Router();

    router.get('/api/campaigns/:id/divergence', wrapAsync((req, res) => {
        const data = readJson(divergencePath(req.params.id), {
            entries: [],
            prunedLog: [],
            lastUpdatedSceneId: '',
            lastUpdatedAt: 0,
            version: 1,
        });
        res.json(data);
    }));

    router.put('/api/campaigns/:id/divergence', wrapAsync((req, res) => {
        const body = req.body;
        if (!body || typeof body !== 'object' || !Array.isArray(body.entries)) {
            return res.status(400).json({ error: 'Invalid divergence register: entries array required' });
        }
        writeJson(divergencePath(req.params.id), body);
        res.json({ ok: true });
    }));

    return router;
}