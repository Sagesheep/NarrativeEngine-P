import fs from 'fs';
import { Router } from 'express';
import {
    CAMPAIGNS_DIR, readJson, writeJson, ensureDirs,
    archivePath, archiveIndexPath, chaptersPath, factsPath,
    entitiesPath, timelinePath,
} from '../lib/fileStore.js';
import { embedText, buildArchiveText, buildLoreText } from '../lib/embedder.js';
import { storeArchiveEmbedding, storeLoreEmbedding } from '../lib/vectorStore.js';
import { wrapAsync } from '../lib/asyncHandler.js';
import path from 'path';

function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function parseArchiveMd(content, indexEntries = []) {
    const byId = {};
    for (const e of indexEntries) byId[e.sceneId] = e;

    const blocks = content.split(/^(?=## SCENE )/m).filter(b => b.trim());
    return blocks.map(block => {
        const idMatch = block.match(/^## SCENE (\d+)/);
        if (!idMatch) return null;
        const sceneId = idMatch[1].padStart(3, '0');

        const entry = byId[sceneId];
        let timestamp = entry?.timestamp ?? 0;
        if (!timestamp) {
            const tsMatch = block.match(/^\*(.+)\*$/m);
            if (tsMatch) {
                const parsed = new Date(tsMatch[1]).getTime();
                if (!isNaN(parsed)) timestamp = parsed;
            }
        }

        const userMatch = block.match(/\*\*\[USER\]\*\*\n([\s\S]*?)\n\n\*\*\[GM\]\*\*/);
        const assistantMatch = block.match(/\*\*\[GM\]\*\*\n([\s\S]*?)(?:\n\n---|\n---|\s*$)/);
        return {
            sceneId,
            userContent: userMatch?.[1]?.trim() ?? '',
            assistantContent: assistantMatch?.[1]?.trim() ?? '',
            timestamp,
        };
    }).filter(Boolean);
}

function scenesToArchiveMd(scenes) {
    return scenes.map(s => {
        const ts = new Date(s.timestamp).toLocaleString();
        return `## SCENE ${s.sceneId}\n*${ts}*\n\n**[USER]**\n${s.userContent}\n\n**[GM]**\n${s.assistantContent}\n\n---\n\n`;
    }).join('');
}

export function createTransferRouter() {
    const router = Router();

    router.get('/api/campaigns/:id/export', wrapAsync((req, res) => {
        const id = req.params.id;
        const metaPath = path.join(CAMPAIGNS_DIR, `${id}.json`);
        if (!fs.existsSync(metaPath)) return res.status(404).json({ error: 'Campaign not found' });

        const campaign = readJson(metaPath, null);
        const state = readJson(path.join(CAMPAIGNS_DIR, `${id}.state.json`), null);
        const lore = readJson(path.join(CAMPAIGNS_DIR, `${id}.lore.json`), []);
        const npcs = readJson(path.join(CAMPAIGNS_DIR, `${id}.npcs.json`), []);
        const archiveIndex = readJson(archiveIndexPath(id), []);
        const chapters = readJson(chaptersPath(id), []);
        const facts = readJson(factsPath(id), []);
        const timeline = readJson(timelinePath(id), []);
        const entities = readJson(entitiesPath(id), []);

        const fp = archivePath(id);
        const scenes = fs.existsSync(fp)
            ? parseArchiveMd(fs.readFileSync(fp, 'utf-8'), archiveIndex)
            : [];

        const bundle = {
            version: 1,
            exportedAt: Date.now(),
            sourcePlatform: 'desktop',
            campaign,
            state,
            lore,
            npcs,
            scenes,
            archiveIndex,
            chapters,
            facts,
            timeline,
            entities,
        };

        const safeName = (campaign.name || id).replace(/[^a-z0-9]+/gi, '_').toLowerCase();
        const filename = `${safeName}_${new Date().toISOString().slice(0, 10)}.campaign`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/json');
        res.json(bundle);
    }));

    router.post('/api/campaigns/import', wrapAsync(async (req, res) => {
        ensureDirs();
        const bundle = req.body;
        if (bundle?.version !== 1) return res.status(400).json({ error: 'Unsupported bundle version' });

        const existingIds = new Set(
            fs.readdirSync(CAMPAIGNS_DIR)
                .filter(f => f.endsWith('.json') && !f.includes('.state') && !f.includes('.lore') && !f.includes('.npcs') && !f.includes('.archive') && !f.includes('.index') && !f.includes('.timeline') && !f.includes('.entities') && !f.includes('.facts') && !f.includes('.overworld') && !f.includes('.chapters'))
                .map(f => f.slice(0, -5))
        );
        const originalId = bundle.campaign?.id;
        const newId = existingIds.has(originalId) ? uid() : originalId;

        const campaign = { ...bundle.campaign, id: newId };

        writeJson(path.join(CAMPAIGNS_DIR, `${newId}.json`), campaign);

        if (bundle.state) {
            writeJson(path.join(CAMPAIGNS_DIR, `${newId}.state.json`), bundle.state);
        }

        if (bundle.lore?.length) {
            writeJson(path.join(CAMPAIGNS_DIR, `${newId}.lore.json`), bundle.lore);
        }

        if (bundle.npcs?.length) {
            writeJson(path.join(CAMPAIGNS_DIR, `${newId}.npcs.json`), bundle.npcs);
        }

        if (bundle.archiveIndex?.length) {
            writeJson(archiveIndexPath(newId), bundle.archiveIndex);
        }

        if (bundle.scenes?.length) {
            fs.writeFileSync(archivePath(newId), scenesToArchiveMd(bundle.scenes), 'utf-8');
        }

        if (bundle.chapters?.length) writeJson(chaptersPath(newId), bundle.chapters);
        if (bundle.facts?.length) writeJson(factsPath(newId), bundle.facts);
        if (bundle.timeline?.length) writeJson(timelinePath(newId), bundle.timeline);
        if (bundle.entities?.length) writeJson(entitiesPath(newId), bundle.entities);

        setImmediate(async () => {
            try {
                for (const entry of bundle.archiveIndex || []) {
                    const vec = await embedText(buildArchiveText(entry)).catch(() => null);
                    if (vec) storeArchiveEmbedding(newId, entry.sceneId, vec);
                }
                for (const chunk of bundle.lore || []) {
                    const vec = await embedText(buildLoreText(chunk)).catch(() => null);
                    if (vec) storeLoreEmbedding(newId, chunk.id, vec);
                }
            } catch { /* non-fatal */ }
        });

        res.json({ ok: true, id: newId, name: campaign.name });
    }));

    return router;
}