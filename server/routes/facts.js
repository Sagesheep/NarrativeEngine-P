import { Router } from 'express';
import { readJson, writeJson, factsPath, entitiesPath, ensureDirs } from '../lib/fileStore.js';
import { normalizeEntityName } from '../lib/entityResolution.js';

export function createFactsRouter() {
    const router = Router();

    // ═══════════════════════════════════════════
    //  Semantic Facts Store
    // ═══════════════════════════════════════════

    router.get('/api/campaigns/:id/facts', (req, res) => {
        const facts = readJson(factsPath(req.params.id), []);
        res.json(facts);
    });

    router.put('/api/campaigns/:id/facts', (req, res) => {
        ensureDirs();
        writeJson(factsPath(req.params.id), req.body);
        res.json({ ok: true });
    });

    router.get('/api/campaigns/:id/entities', (req, res) => {
        const entities = readJson(entitiesPath(req.params.id), []);
        res.json(entities);
    });

    router.post('/api/campaigns/:id/entities/merge', (req, res) => {
        try {
            const { survivorId, consumedId } = req.body;
            const fp = entitiesPath(req.params.id);
            const entities = readJson(fp, []);

            const survivor = entities.find(e => e.id === survivorId);
            const consumed = entities.find(e => e.id === consumedId);
            if (!survivor || !consumed) {
                return res.status(404).json({ error: 'Entity not found' });
            }

            survivor.aliases = [...new Set([
                ...survivor.aliases,
                consumed.name,
                ...consumed.aliases
            ])];

            const factsFile = factsPath(req.params.id);
            const facts = readJson(factsFile, []);
            for (const fact of facts) {
                if (fact.subject === consumed.name) fact.subject = survivor.name;
                if (fact.object === consumed.name) fact.object = survivor.name;
            }
            writeJson(factsFile, facts);

            const updated = entities.filter(e => e.id !== consumedId);
            writeJson(fp, updated);

            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
}
