import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { CAMPAIGNS_DIR, readJson, writeJson, ensureDirs } from '../lib/fileStore.js';
import { embedText, buildLoreText } from '../lib/embedder.js';
import { storeLoreEmbedding, deleteCampaignEmbeddings } from '../lib/vectorStore.js';

export function createCampaignsRouter() {
    const router = Router();

    // ═══════════════════════════════════════════
    //  Campaigns
    // ═══════════════════════════════════════════

    router.get('/api/campaigns', (_req, res) => {
        ensureDirs();
        const files = fs.readdirSync(CAMPAIGNS_DIR).filter(f =>
            f.endsWith('.json') &&
            !f.includes('.state') &&
            !f.includes('.lore') &&
            !f.includes('.npcs') &&
            !f.includes('.archive') &&
            !f.includes('.index')
        );
        const campaigns = files
            .map(f => {
                const data = readJson(path.join(CAMPAIGNS_DIR, f));
                if (data && data.id && data.name && data.id !== 'undefined' && data.id !== 'null') {
                    return {
                        ...data,
                        lastPlayedAt: Number(data.lastPlayedAt) || 0
                    };
                }
                return null;
            })
            .filter(c => c !== null);

        console.log(`[API] Returning ${campaigns.length} campaigns:`, campaigns.map(c => c.id).join(', '));
        campaigns.sort((a, b) => (Number(b.lastPlayedAt) || 0) - (Number(a.lastPlayedAt) || 0));
        res.json(campaigns);
    });

    router.get('/api/campaigns/:id', (req, res) => {
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.json`);
        const campaign = readJson(filePath);
        if (!campaign) return res.status(404).json({ error: 'Not found' });
        res.json(campaign);
    });

    router.put('/api/campaigns/:id', (req, res) => {
        ensureDirs();
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.json`);
        writeJson(filePath, req.body);
        res.json({ ok: true });
    });

    router.delete('/api/campaigns/:id', (req, res) => {
        const id = req.params.id;
        const files = [
            path.join(CAMPAIGNS_DIR, `${id}.json`),
            path.join(CAMPAIGNS_DIR, `${id}.state.json`),
            path.join(CAMPAIGNS_DIR, `${id}.lore.json`),
            path.join(CAMPAIGNS_DIR, `${id}.npcs.json`),
            path.join(CAMPAIGNS_DIR, `${id}.archive.md`),
            path.join(CAMPAIGNS_DIR, `${id}.archive.index.json`),
            path.join(CAMPAIGNS_DIR, `${id}.facts.json`),
            path.join(CAMPAIGNS_DIR, `${id}.entities.json`),
        ];
        for (const f of files) {
            if (fs.existsSync(f)) fs.unlinkSync(f);
        }
        res.json({ ok: true });
    });

    // ═══════════════════════════════════════════
    //  Campaign State (context, messages, condenser)
    // ═══════════════════════════════════════════

    router.get('/api/campaigns/:id/state', (req, res) => {
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.state.json`);
        const state = readJson(filePath);
        if (!state) return res.status(404).json({ error: 'Not found' });
        res.json(state);
    });

    router.put('/api/campaigns/:id/state', (req, res) => {
        ensureDirs();
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.state.json`);
        writeJson(filePath, req.body);
        res.json({ ok: true });
    });

    // ═══════════════════════════════════════════
    //  Lore Chunks
    // ═══════════════════════════════════════════

    router.get('/api/campaigns/:id/lore', (req, res) => {
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.lore.json`);
        const lore = readJson(filePath, []);
        res.json(lore);
    });

    router.put('/api/campaigns/:id/lore', (req, res) => {
        ensureDirs();
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.lore.json`);
        writeJson(filePath, req.body);
        res.json({ ok: true });

        const chunks = req.body;
        if (Array.isArray(chunks)) {
            (async () => {
                for (const chunk of chunks) {
                    try {
                        const text = buildLoreText(chunk);
                        const embedding = await embedText(text);
                        storeLoreEmbedding(req.params.id, chunk.id, embedding);
                    } catch (err) {
                        console.error(`[Lore Embed] Failed for ${chunk.id}:`, err.message);
                    }
                }
                console.log(`[Lore Embed] Stored ${chunks.length} lore embeddings for ${req.params.id}`);
            })().catch(err => console.error('[Lore Embed] Batch failed:', err.message));
        }
    });

    // ═══════════════════════════════════════════
    //  NPC Ledger
    // ═══════════════════════════════════════════

    router.get('/api/campaigns/:id/npcs', (req, res) => {
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.npcs.json`);
        const npcs = readJson(filePath, []);
        res.json(npcs);
    });

    router.put('/api/campaigns/:id/npcs', (req, res) => {
        ensureDirs();
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.npcs.json`);
        writeJson(filePath, req.body);
        res.json({ ok: true });
    });

    return router;
}
