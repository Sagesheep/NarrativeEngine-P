/**
 * Vector Service — thin wrapper over the red-zone vector store + embedder.
 *
 * Phase 5 split: every SQLite / embedding-model call goes through here. The
 * underlying `server/lib/vectorStore.js` and `server/lib/embedder.js` are NOT
 * modified (red zone per AI_CODEBASE_MAP.md blast radius matrix). This module
 * only re-exports and lightly composes their functions so the service/controller
 * layers have a single, narrow vector seam.
 *
 * IMPORTANT: this wrapper adds no behavioural change — same args, same returns,
 * same error semantics as the underlying calls. It exists for architectural
 * separation only, not optimisation.
 */

import { reciprocalRankFusion } from '../lib/rankFusion.js';
import {
    storeArchiveEmbedding,
    storeLoreEmbedding,
    searchArchive,
    searchLore,
    getEmbeddingStatus,
    deleteArchiveEmbedding,
    deleteAllArchiveEmbeddings,
    EMBEDDING_VERSIONS,
    getDb,
} from '../lib/vectorStore.js';
import {
    embedText,
    embedQuery,
    buildScenePassages,
    buildLoreText,
    warmup,
    embedBatch,
    getActiveDims,
    getActiveModelId,
    isModelReady,
} from '../lib/embedder.js';
import { isJobRunning } from '../lib/embedJobs.js';

// ─── Re-exports (no behaviour change) ──────────────────────────────────────
export {
    storeArchiveEmbedding,
    storeLoreEmbedding,
    searchArchive,
    searchLore,
    getEmbeddingStatus,
    deleteArchiveEmbedding,
    deleteAllArchiveEmbeddings,
    EMBEDDING_VERSIONS,
    getDb,
    embedText,
    embedQuery,
    buildScenePassages,
    buildLoreText,
    warmup,
    embedBatch,
    getActiveDims,
    getActiveModelId,
    isModelReady,
    isJobRunning,
};

// ─── Thin compositions ─────────────────────────────────────────────────────

/**
 * Embed a scene as passages of its prose plus a card naming its cast (`names`: the
 * index entry's witnesses and mentioned NPCs), and store them under its id,
 * replacing the scene's old vectors. Fire-and-forget semantics are the caller's
 * responsibility (append uses .then().catch(); edit-sync awaits).
 *
 * Throws if embedding throws; the caller decides whether to swallow.
 */
export async function embedAndStoreScene(campaignId, sceneId, userContent, assistantContent, names = []) {
    const passages = buildScenePassages(userContent, assistantContent, names);
    const vectors = passages.length > 0 ? await embedBatch(passages, 16, 0) : [];
    storeArchiveEmbedding(campaignId, sceneId, vectors);
}

/**
 * Embed `text` and store it as a lore embedding.
 */
export async function embedAndStoreLore(campaignId, loreId, text) {
    const embedding = await embedText(text);
    if (embedding) storeLoreEmbedding(campaignId, loreId, embedding);
}

/**
 * Search the archive for `query` (single or multi-query). Used by the
 * semantic-candidates route. Returns an array of { sceneId } hits.
 *
 * If `queries` is a non-empty array, runs each query and fuses the ranked lists
 * (reciprocal rank fusion, `lib/rankFusion.js`). Otherwise runs the single `query`.
 *
 * `scopeSceneIds` (WO-10): optional array of scene IDs to restrict recall to.
 * Forwarded as `opts.scopeIds` to `searchArchive`; null/empty/absent → unscoped
 * (existing callers unaffected). The scope filter is additive on the search
 * function — see `createSearchFn` in `vectorStore.js` for the SQL IN / fallback
 * implementation.
 */
export async function searchArchiveCandidates(campaignId, { query, queries, limit, diversity = true, scopeSceneIds } = {}) {
    if (queries && Array.isArray(queries) && queries.length > 0) {
        const lists = [];
        for (const q of queries) {
            if (!q?.trim()) continue;
            const embedding = await embedQuery(q);
            lists.push(searchArchive(campaignId, embedding, limit || 20, diversity, { scopeIds: scopeSceneIds }).map(r => r.sceneId));
        }
        const sceneIds = reciprocalRankFusion(lists);
        console.log(`[VectorStore] archive candidates for ${queries.length} queries: [${sceneIds.join(', ')}]`);
        return sceneIds;
    }
    if (!query?.trim()) return [];
    const embedding = await embedQuery(query);
    const results = searchArchive(campaignId, embedding, limit || 20, diversity, { scopeIds: scopeSceneIds });
    console.log(`[VectorStore] archive candidates for "${query.slice(0, 50)}": [${results.map(r => r.sceneId).join(', ')}]`);
    return results.map(r => r.sceneId);
}

/**
 * Search the lore for `query` (single or multi-query). Mirrors
 * `searchArchiveCandidates` but returns loreIds. Used by the lore
 * semantic-candidates route.
 */
export async function searchLoreCandidates(campaignId, { query, queries, limit, diversity = true }) {
    if (queries && Array.isArray(queries) && queries.length > 0) {
        const lists = [];
        for (const q of queries) {
            if (!q?.trim()) continue;
            const embedding = await embedQuery(q);
            lists.push(searchLore(campaignId, embedding, limit || 15, diversity).map(r => r.loreId));
        }
        const loreIds = reciprocalRankFusion(lists);
        console.log(`[VectorStore] lore candidates for ${queries.length} queries: [${loreIds.join(', ')}]`);
        return loreIds;
    }
    if (!query?.trim()) return [];
    const embedding = await embedQuery(query);
    const results = searchLore(campaignId, embedding, limit || 15, diversity);
    console.log(`[VectorStore] lore candidates for "${query.slice(0, 50)}": [${results.map(r => r.loreId).join(', ')}]`);
    return results.map(r => r.loreId);
}