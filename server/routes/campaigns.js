import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { CAMPAIGNS_DIR, SETTINGS_FILE, campaignFiles, readJson, writeJson, ensureDirs, validateCampaignId } from '../lib/fileStore.js';
import { isCampaignMetaFile } from '../lib/tableRegistry.js';
import { readMigrationLedger } from '../lib/legacyAdoption.js';
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
        // Derived positive test (WO-P5-03 §4): a campaign metadata file is a
        // .json whose name has no registered campaign-file suffix. Replaces the
        // hand-written negative substring filter (campaigns.js:20-33) which had
        // already drifted against the transfer.js filter and would drift again
        // on every mod-declared table.
        const files = fs.readdirSync(CAMPAIGNS_DIR).filter(f => isCampaignMetaFile(f));
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

    /**
     * Phase 8.5 — the campaign's migration ledger.
     *
     * "A migration that fails must leave the campaign openable, **with the
     * failure surfaced**" (8.5 §3.6). Openable is guaranteed by
     * `legacyAdoption.js` never throwing; this is the surface. It reports what
     * was adopted, from which retired file, how many records, and — the reason
     * it exists — anything that failed and why.
     *
     * Always 200 with a well-formed ledger, even for a campaign that has never
     * migrated anything (`{ adopted: {}, failures: {} }`). A diagnostic that
     * 404s is a diagnostic people stop calling.
     */
    router.get('/api/campaigns/:id/migrations', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        res.json(readMigrationLedger(req.params.id));
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
    //  Location Ledger
    // ═══════════════════════════════════════════


    router.get('/api/campaigns/:id/relationship-memory/npc-to-mc', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        const filePath = path.join(CAMPAIGNS_DIR, req.params.id + '.relationship-memory.npc-to-mc.json');
        res.json(readJson(filePath, []));
    }));

    router.get('/api/campaigns/:id/relationship-memory/npc-to-npc', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        const filePath = path.join(CAMPAIGNS_DIR, req.params.id + '.relationship-memory.npc-to-npc.json');
        res.json(readJson(filePath, []));
    }));

    router.put('/api/campaigns/:id/relationship-memory', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        ensureDirs();
        const npcToMc = Array.isArray(req.body?.npcToMc) ? req.body.npcToMc : [];
        const npcToNpc = Array.isArray(req.body?.npcToNpc) ? req.body.npcToNpc : [];
        writeJson(path.join(CAMPAIGNS_DIR, req.params.id + '.relationship-memory.npc-to-mc.json'), npcToMc);
        writeJson(path.join(CAMPAIGNS_DIR, req.params.id + '.relationship-memory.npc-to-npc.json'), npcToNpc);
        res.json({ ok: true });
    }));

    return router;
}
