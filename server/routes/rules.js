import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { CAMPAIGNS_DIR, readJson } from '../lib/fileStore.js';
import { embedText, embedQuery, embedBatch, isModelReady, getActiveModelId } from '../lib/embedder.js';
import { storeRulesEmbedding, deleteRulesEmbedding, searchRules, getEmbeddingStatus, getDb } from '../lib/vectorStore.js';
import { isJobRunning } from '../lib/embedJobs.js';
import { wrapAsync } from '../lib/asyncHandler.js';

function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function chunkRulesServer(markdown) {
    const lines = markdown.split(/\r?\n/);
    const chunks = [];
    const usedIds = new Set();
    
    let currentHeader = '';
    let currentLines = [];
    
    const flush = () => {
        const content = currentLines.join('\n').trim();
        if (content && currentHeader) {
            const baseId = slugify(currentHeader);
            let uniqueId = baseId;
            let counter = 1;
            while (usedIds.has(uniqueId)) {
                uniqueId = `${baseId}-${counter}`;
                counter++;
            }
            usedIds.add(uniqueId);
            
            chunks.push({
                id: uniqueId,
                header: currentHeader,
                content: content
            });
        }
    };
    
    for (const line of lines) {
        if (line.match(/^\s*(#{2,3})\s+(.+)/)) {
            const match = line.match(/^\s*(#{2,3})\s+(.+)/);
            flush();
            currentHeader = match[2].trim();
            currentLines = [];
        } else {
            currentLines.push(line);
        }
    }
    flush();
    return chunks;
}

export function createRulesRouter() {
    const router = Router();

    // Upsert single rule chunk embedding
    router.post('/api/campaigns/:id/rules/embed', wrapAsync(async (req, res) => {
        const campaignId = req.params.id;
        const { chunkId, text } = req.body;
        if (!chunkId || typeof text !== 'string') {
            return res.status(400).json({ error: 'chunkId and text are required' });
        }

        const embedding = await embedText(text.slice(0, 500));
        storeRulesEmbedding(campaignId, chunkId, embedding);

        res.json({
            chunkId,
            modelId: getActiveModelId(),
            version: 1
        });
    }));

    // Delete single rule chunk embedding
    router.delete('/api/campaigns/:id/rules/embed/:chunkId', wrapAsync((req, res) => {
        const campaignId = req.params.id;
        const chunkId = req.params.chunkId;
        deleteRulesEmbedding(campaignId, chunkId);
        res.json({ ok: true });
    }));

    // Search rules vector store (top-K candidate rule IDs)
    router.post('/api/campaigns/:id/rules/search', wrapAsync(async (req, res) => {
        const campaignId = req.params.id;
        // Non-blocking hot path — see archive semantic-candidates routes.
        if (!isModelReady() || isJobRunning(campaignId, 'rules')) {
            return res.json({ ruleIds: [], pending: true });
        }
        const { query, limit } = req.body;
        if (typeof query !== 'string' || !query.trim()) {
            return res.json({ ruleIds: [] });
        }

        const embedding = await embedQuery(query);
        const results = searchRules(campaignId, embedding, limit || 15);
        res.json({ ruleIds: results.map(r => r.ruleId) });
    }));

    // Server-side Rules Reindexing
    router.post('/api/campaigns/:id/rules/reindex', wrapAsync(async (req, res) => {
        const result = await reindexCampaignRules(req.params.id);
        if (result.status === 'not-found') {
            return res.status(404).json({ error: 'Campaign state not found' });
        }
        res.json(result);
    }));

    return router;
}

/**
 * Rebuild a campaign's rule embeddings from the rules text in its state file.
 * Used by the re-index route and by an embedding-model switch.
 */
export async function reindexCampaignRules(campaignId) {
    console.log(`[Rules Reindex] Starting server-side rules reindex for campaign ${campaignId}`);

    const campaignStatePath = path.join(CAMPAIGNS_DIR, `${campaignId}.state.json`);
    if (!fs.existsSync(campaignStatePath)) {
        return { status: 'not-found', totalChunks: 0 };
    }

    const campaignState = readJson(campaignStatePath);
    const rulesRaw = campaignState?.context?.rulesRaw || '';

    if (!rulesRaw.trim()) {
        return { status: 'ignored', totalChunks: 0, reason: 'No rules text' };
    }

    const chunks = chunkRulesServer(rulesRaw);

    try {
        const sqliteDb = getDb();
        if (sqliteDb) {
            sqliteDb.prepare("DELETE FROM rules_vss WHERE campaign_id = ?").run(campaignId);
            sqliteDb.prepare("DELETE FROM embedding_meta WHERE campaign_id = ? AND item_type = 'rule'").run(campaignId);
        }
    } catch (err) {
        console.warn('[Rules Reindex] Failed to clear DB explicitly:', err.message);
    }

    if (chunks.length === 0) {
        return { status: 'success', totalChunks: 0 };
    }

    const texts = chunks.map(c => `${c.header}\n${c.content}`.slice(0, 500));
    const embeddings = await embedBatch(texts, 10, 100);

    for (let i = 0; i < chunks.length; i++) {
        storeRulesEmbedding(campaignId, chunks[i].id, embeddings[i]);
    }

    const newStatus = getEmbeddingStatus(campaignId);
    console.log(`[Rules Reindex] Successfully indexed ${chunks.length} chunks.`);

    return {
        status: 'success',
        totalChunks: chunks.length,
        embeddingStatus: newStatus
    };
}
