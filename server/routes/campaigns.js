import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { CAMPAIGNS_DIR, SETTINGS_FILE, campaignFiles, readJson, writeJson, ensureDirs, validateCampaignId } from '../lib/fileStore.js';
import { embedText, buildLoreText, resolveIndexingSpeed } from '../lib/embedder.js';
import { storeLoreEmbedding, deleteCampaignEmbeddings } from '../lib/vectorStore.js';
import { startJob, tickJob, endJob } from '../lib/embedJobs.js';
import { wrapAsync } from '../lib/asyncHandler.js';

export function createCampaignsRouter() {
    const router = Router();

    // ═══════════════════════════════════════════
    //  Campaigns
    // ═══════════════════════════════════════════

    router.get('/api/campaigns', wrapAsync((_req, res) => {
        ensureDirs();
        const files = fs.readdirSync(CAMPAIGNS_DIR).filter(f =>
            f.endsWith('.json') &&
            !f.includes('.state') &&
            !f.includes('.lore') &&
            !f.includes('.npcs') &&
            !f.includes('.enemies') &&
            !f.includes('.enemy-instances') &&
            !f.includes('.enemy-encounters') &&
            !f.includes('.locations') &&
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
    }));

    router.get('/api/campaigns/:id', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.json`);
        const campaign = readJson(filePath);
        if (!campaign) return res.status(404).json({ error: 'Not found' });
        res.json(campaign);
    }));

    router.put('/api/campaigns/:id', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        ensureDirs();
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.json`);
        writeJson(filePath, req.body);
        res.json({ ok: true });
    }));

    router.delete('/api/campaigns/:id', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        const id = req.params.id;
        const files = campaignFiles(id);
        for (const f of files) {
            fs.unlinkSync(path.join(CAMPAIGNS_DIR, f));
        }
        deleteCampaignEmbeddings(id);
        res.json({ ok: true });
    }));

    // ═══════════════════════════════════════════
    //  Campaign State (context, messages, condenser)
    // ═══════════════════════════════════════════

    router.get('/api/campaigns/:id/state', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.state.json`);
        const state = readJson(filePath);
        if (!state) return res.status(404).json({ error: 'Not found' });
        res.json(state);
    }));

    router.put('/api/campaigns/:id/state', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        ensureDirs();
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.state.json`);
        const { context, messages, condenser } = req.body;
        // pinnedExcerpts is optional on CampaignState, but this is a full-record overwrite —
        // a caller that *omits* the field would silently wipe the user's pinned memories
        // (Header.handleExit / CampaignHub edits did exactly this). Guard: when the field is
        // undefined (omitted, not an explicit [] clear), preserve whatever is already persisted.
        // The hot turn path always passes pinnedExcerpts explicitly, so this extra read never
        // fires there. (cda15f4)
        let pinnedExcerpts = req.body.pinnedExcerpts;
        if (pinnedExcerpts === undefined) {
            const prev = fs.existsSync(filePath) ? readJson(filePath, null) : null;
            if (prev && Array.isArray(prev.pinnedExcerpts) && prev.pinnedExcerpts.length > 0) {
                pinnedExcerpts = prev.pinnedExcerpts;
            }
        }
        const safe = {
            context,
            condenser,
            messages: (messages || []).map(({ debugPayload: _dp, ...msg }) => msg),
            pinnedExcerpts,
        };
        writeJson(filePath, safe);

        // B5 — bump lastPlayedAt on turn-commit (state save), not just on open/edit. The stamp
        // otherwise reads "last opened" and breaks the recency sort in listCampaigns. Touches
        // only the meta record; non-fatal on meta-write failure (the state save above already
        // succeeded). One small extra write per turn.
        try {
            const metaPath = path.join(CAMPAIGNS_DIR, `${req.params.id}.json`);
            const meta = readJson(metaPath, null);
            if (meta && meta.id) {
                meta.lastPlayedAt = Date.now();
                writeJson(metaPath, meta);
            }
        } catch (metaErr) {
            console.warn(`[API] Non-fatal: failed to bump lastPlayedAt for ${req.params.id}:`, metaErr);
        }

        res.json({ ok: true });
    }));

    // ═══════════════════════════════════════════
    //  Lore Chunks
    // ═══════════════════════════════════════════

    router.get('/api/campaigns/:id/lore', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.lore.json`);
        const lore = readJson(filePath, []);
        res.json(lore);
    }));

    router.put('/api/campaigns/:id/lore', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        ensureDirs();
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.lore.json`);
        writeJson(filePath, req.body);
        res.json({ ok: true });

        const chunks = req.body;
        if (Array.isArray(chunks) && chunks.length > 0) {
            const campaignId = req.params.id;
            // Indexing speed governs batch size + inter-batch yield. Read fresh each
            // import so a settings change takes effect without a server restart.
            const serverSettings = readJson(SETTINGS_FILE, {});
            const { batchSize, delayMs } = resolveIndexingSpeed(serverSettings?.settings?.indexingSpeed);
            (async () => {
                startJob(campaignId, 'lore', chunks.length);
                let ok = 0;
                let fail = 0;
                try {
                    for (let i = 0; i < chunks.length; i += batchSize) {
                        const batch = chunks.slice(i, i + batchSize);
                        await Promise.all(batch.map(async (chunk) => {
                            try {
                                const embedding = await embedText(buildLoreText(chunk));
                                storeLoreEmbedding(campaignId, chunk.id, embedding);
                                ok++;
                            } catch (err) {
                                console.warn(`[Lore Embed] Failed for ${chunk.id}: ${err.message}`);
                                fail++;
                            }
                        }));
                        tickJob(campaignId, 'lore', batch.length);
                        if (i + batchSize < chunks.length && delayMs > 0) {
                            await new Promise(r => setTimeout(r, delayMs));
                        }
                    }
                    console.log(`[Lore Embed] Stored ${ok}/${chunks.length} lore embeddings for ${campaignId}${fail ? ` (${fail} failed)` : ''}`);
                } finally {
                    endJob(campaignId, 'lore');
                }
            })().catch(err => { endJob(campaignId, 'lore'); console.error('[Lore Embed] Batch failed:', err.message); });
        }
    }));

    // ═══════════════════════════════════════════
    //  NPC Ledger
    // ═══════════════════════════════════════════

    router.get('/api/campaigns/:id/npcs', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.npcs.json`);
        const npcs = readJson(filePath, []);
        res.json(npcs);
    }));

    router.put('/api/campaigns/:id/npcs', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        ensureDirs();
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.npcs.json`);
        writeJson(filePath, req.body);
        res.json({ ok: true });
    }));

    // ═══════════════════════════════════════════
    //  Enemy Compendium
    // ═══════════════════════════════════════════

    router.get('/api/campaigns/:id/enemies', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        res.json(readJson(path.join(CAMPAIGNS_DIR, `${req.params.id}.enemies.json`), []));
    }));

    router.put('/api/campaigns/:id/enemies', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Enemy compendium must be an array' });
        ensureDirs();
        writeJson(path.join(CAMPAIGNS_DIR, `${req.params.id}.enemies.json`), req.body);
        res.json({ ok: true });
    }));

    // ─── Enemy Instances ────────────────────────────────────────────────

    router.get('/api/campaigns/:id/enemy-instances', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        res.json(readJson(path.join(CAMPAIGNS_DIR, `${req.params.id}.enemy-instances.json`), []));
    }));

    router.put('/api/campaigns/:id/enemy-instances', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Enemy instances must be an array' });
        ensureDirs();
        writeJson(path.join(CAMPAIGNS_DIR, `${req.params.id}.enemy-instances.json`), req.body);
        res.json({ ok: true });
    }));

    // ─── Enemy Encounters ───────────────────────────────────────────────

    router.get('/api/campaigns/:id/enemy-encounters', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        res.json(readJson(path.join(CAMPAIGNS_DIR, `${req.params.id}.enemy-encounters.json`), []));
    }));

    router.put('/api/campaigns/:id/enemy-encounters', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Enemy encounters must be an array' });
        ensureDirs();
        writeJson(path.join(CAMPAIGNS_DIR, `${req.params.id}.enemy-encounters.json`), req.body);
        res.json({ ok: true });
    }));

    // ═══════════════════════════════════════════
    //  Location Ledger
    // ═══════════════════════════════════════════

    router.get('/api/campaigns/:id/locations', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.locations.json`);
        const locations = readJson(filePath, []);
        res.json(locations);
    }));

    router.put('/api/campaigns/:id/locations', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        ensureDirs();
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.locations.json`);
        writeJson(filePath, req.body);
        res.json({ ok: true });
    }));

    return router;
}
