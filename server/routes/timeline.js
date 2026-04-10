import fs from 'fs';
import { Router } from 'express';
import { readJson, writeJson, timelinePath, factsPath } from '../lib/fileStore.js';
import { TIMELINE_PREDICATES_SERVER } from '../services/llmProxy.js';

export function createTimelineRouter() {
    const router = Router();

    // ═══════════════════════════════════════════
    //  Timeline (World State Truth Store)
    // ═══════════════════════════════════════════

    // GET — return full timeline; migrates from .facts.json on first access
    router.get('/api/campaigns/:id/timeline', (req, res) => {
        const id = req.params.id;
        const tp = timelinePath(id);

        if (!fs.existsSync(tp)) {
            // Migration: convert existing facts to timeline events (one-time)
            const fp = factsPath(id);
            if (fs.existsSync(fp)) {
                const facts = readJson(fp, []);
                const migrated = facts.map(f => ({
                    id: `tl_${f.id ? f.id.replace('fact_', '') : String(Math.random()).slice(2, 6)}`,
                    sceneId: f.sceneId || '000',
                    chapterId: 'CH00',
                    subject: f.subject || '',
                    predicate: TIMELINE_PREDICATES_SERVER.includes(f.predicate) ? f.predicate : 'misc',
                    object: f.object || '',
                    summary: `${f.subject} ${f.predicate} ${f.object}`,
                    importance: typeof f.importance === 'number' ? f.importance : 5,
                    source: f.source || 'regex',
                }));
                writeJson(tp, migrated);
                return res.json(migrated);
            }
            return res.json([]);
        }

        res.json(readJson(tp, []));
    });

    // POST — add a manual timeline event
    router.post('/api/campaigns/:id/timeline', (req, res) => {
        const tp = timelinePath(req.params.id);
        const existing = readJson(tp, []);
        const { subject, predicate, object: obj, summary, importance, sceneId: evSceneId, chapterId } = req.body;

        if (!subject || !predicate || !obj) {
            return res.status(400).json({ error: 'subject, predicate, and object are required' });
        }

        const event = {
            id: `tl_${String(existing.length + 1).padStart(4, '0')}`,
            sceneId: evSceneId || '000',
            chapterId: chapterId || 'CH00',
            subject,
            predicate: TIMELINE_PREDICATES_SERVER.includes(predicate) ? predicate : 'misc',
            object: obj,
            summary: summary || `${subject} ${predicate} ${obj}`,
            importance: Math.min(10, Math.max(1, typeof importance === 'number' ? importance : 5)),
            source: 'manual',
        };

        existing.push(event);
        writeJson(tp, existing);
        res.json(event);
    });

    // DELETE — remove a single event by id
    router.delete('/api/campaigns/:id/timeline/:eventId', (req, res) => {
        const tp = timelinePath(req.params.id);
        const existing = readJson(tp, []);
        const filtered = existing.filter(e => e.id !== req.params.eventId);
        writeJson(tp, filtered);
        res.json({ ok: true, removed: existing.length - filtered.length });
    });

    return router;
}
