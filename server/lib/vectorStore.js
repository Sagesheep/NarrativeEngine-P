import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { DATA_DIR, readJson, writeJson, SETTINGS_FILE } from './fileStore.js';
import { getActiveDims as embedderDims } from './embedder.js';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(DATA_DIR, 'embeddings.db');
const VEC_DIMS_KEY = 'embeddingDims';

// Bump this when the embedding model changes. Stale embeddings will be
// excluded from recall and flagged for re-indexing.
export const EMBEDDING_VERSION = 1;

// ─── MMR diversity reranking (Phase G) ──────────────────────────────────────
// Ported from mobileApp/src/services/embedding/vectorSearch.ts. mobileApp runs
// this client-side because its vectors live in IndexedDB; mainApp's vectors
// live here on the server, so MMR belongs here, where the data is.

/**
 * Balance between query-relevance (1.0) and diversity (0.0).
 * 0.7 = strongly relevance-leaning, still penalises near-duplicates.
 * (Carbonell & Goldstein 1998 standard.)
 */
const MMR_LAMBDA = 0.7;

/**
 * Minimum pool size before MMR is worth running.
 * Below this the diversity benefit is negligible and we skip for speed.
 */
const MMR_MIN_POOL = 4;

export function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

/**
 * Greedy Maximal Marginal Relevance selection.
 * Picks `topK` items from `pool` balancing query-relevance against similarity
 * to already-selected items, using `lambda` to weight the trade-off.
 *
 * `pool` entries are `{ id, score, vector }`. The returned hits are
 * `{ id, score }` with the vector stripped. Always seeds with the
 * highest-relevance candidate, so the top-1 hit is never displaced by MMR.
 */
export function mmrSelect(pool, topK, lambda = MMR_LAMBDA) {
    // Defense-in-depth: a missing/corrupt embedding blob yields a null vector, and
    // cosineSimilarity(null, ...) would throw. Drop those before any pairwise scoring.
    pool = pool.filter(p => p && p.vector);
    if (pool.length <= topK) return pool.map(({ id, score }) => ({ id, score }));

    const selected = [];
    const remaining = [...pool];

    // Seed with the highest-relevance candidate
    remaining.sort((a, b) => b.score - a.score);
    selected.push(remaining.shift());

    while (selected.length < topK && remaining.length > 0) {
        let bestIdx = -1;
        let bestMmr = -Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const candidate = remaining[i];
            // Max similarity to any already-selected item
            let maxSim = 0;
            for (const sel of selected) {
                const sim = cosineSimilarity(candidate.vector, sel.vector);
                if (sim > maxSim) maxSim = sim;
            }
            const mmr = lambda * candidate.score - (1 - lambda) * maxSim;
            if (mmr > bestMmr) {
                bestMmr = mmr;
                bestIdx = i;
            }
        }

        if (bestIdx === -1) break;
        selected.push(remaining.splice(bestIdx, 1)[0]);
    }

    return selected.map(({ id, score }) => ({ id, score }));
}

/** Decode a sqlite-vec embedding column (a Node Buffer of float32 LE) into a Float32Array. */
function blobToFloat32(blob) {
    if (!blob) return null;
    // `new Uint8Array(buffer)` copies into a fresh, 4-byte-aligned ArrayBuffer.
    return new Float32Array(new Uint8Array(blob).buffer);
}

let db = null;
let currentDims = null;

/**
 * Embeddings whose vectors were dropped by a schema rebuild are marked with
 * this version in `embedding_meta`. It is below every real `EMBEDDING_VERSION`,
 * so re-index picks them up through its ordinary stale path, and it is never
 * written by a store — so a row at this version means exactly "needs rebuild".
 */
const REBUILD_PENDING_VERSION = 0;

/** Set when `initDb` throws; the reason is shown to the user. */
let unavailableReason = null;

/**
 * Whether semantic recall is actually working, for the client's status banner.
 *
 * Both failure modes used to be a console line and nothing else: recall
 * quietly fell back to keyword search and the user had no way to know.
 *   - 'unavailable'     — the database failed to open. Vector calls are no-ops
 *                          for the life of the process.
 *   - 'reindex-needed'  — the embedding size changed, so the vector tables
 *                          were recreated empty, and `count` of this campaign's
 *                          embeddings are still waiting to be rebuilt.
 *
 * Derived from the database rather than held in memory, so it survives a
 * restart and clears itself as re-index rebuilds each vector.
 *
 * @param {string | undefined} campaignId — scope the count to one campaign.
 * @returns {{ status: 'ok' } | { status: 'unavailable', detail: string } | { status: 'reindex-needed', count: number }}
 */
export function getVectorHealth(campaignId) {
    if (unavailableReason !== null) return { status: 'unavailable', detail: unavailableReason };
    if (!db) return { status: 'ok' };
    const row = campaignId
        ? db.prepare('SELECT COUNT(*) AS n FROM embedding_meta WHERE campaign_id = ? AND version = ?')
            .get(campaignId, REBUILD_PENDING_VERSION)
        : db.prepare('SELECT COUNT(*) AS n FROM embedding_meta WHERE version = ?')
            .get(REBUILD_PENDING_VERSION);
    return row.n > 0 ? { status: 'reindex-needed', count: row.n } : { status: 'ok' };
}

/**
 * Called by the server when `initDb` throws. Also drops any half-opened
 * handle: every vector function guards on `db`, so nulling it is what makes
 * them the no-ops the fallback relies on, rather than SQL errors against a
 * database whose vector extension never loaded.
 */
export function markVectorStoreUnavailable(detail) {
    unavailableReason = String(detail);
    try { db?.close(); } catch { /* already unusable */ }
    db = null;
}

function resolveDims() {
    const settings = readJson(SETTINGS_FILE, {});
    const dims = settings?.settings?.[VEC_DIMS_KEY];
    if (dims) return dims;
    return embedderDims();
}

function getStoredSchemaDims() {
    if (!db) return null;
    try {
        const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='archive_vss'").get();
        if (!row) return null;
        const match = row.sql.match(/float\[(\d+)\]/i);
        return match ? parseInt(match[1], 10) : null;
    } catch (e) {
        console.warn(`[VectorStore] Schema dims read failed: ${e.message}`);
        return null;
    }
}

export function initDb() {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // A second `initDb` in one process must not leak the first connection.
    // Closing it also means anything still holding statements prepared on it
    // fails loudly instead of quietly writing through a stale handle — which
    // is why the store functions re-prepare when the handle changes.
    if (db) {
        try { db.close(); } catch { /* already closed */ }
    }

    db = new Database(DB_PATH);
    sqliteVec.load(db);

    // Durability settings, not schema — no table, column or query changes.
    //
    // The default journal mode is `delete`, which fsyncs on every statement.
    // Storing one scene embedding is three statements (delete, insert, stamp),
    // so a single turn's embed paid three full fsyncs on the write path.
    // WAL plus `synchronous = NORMAL` is the standard local-application
    // setting: an OS crash can lose the last commits, a process crash cannot
    // corrupt the file, and embeddings are derived data that can be rebuilt
    // with `migrateEmbeddings.js` anyway.
    //
    // WAL writes `embeddings.db-wal` and `-shm` siblings. `data/` is gitignored
    // and `backup.js` enumerates campaign files by name, so neither sees them.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    const version = db.prepare("select vec_version() as v").get();
    console.log(`[VectorStore] sqlite-vec v${version.v} loaded`);

    currentDims = resolveDims();
    const storedDims = getStoredSchemaDims();

    let rebuilt = false;
    if (storedDims !== null && storedDims !== currentDims) {
        console.warn(`[VectorStore] Dimension mismatch: schema=${storedDims}, active=${currentDims}. Rebuilding tables.`);
        db.exec("DROP TABLE IF EXISTS archive_vss");
        db.exec("DROP TABLE IF EXISTS lore_vss");
        db.exec("DROP TABLE IF EXISTS rules_vss");
        rebuilt = true;
    }

    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS archive_vss USING vec0(
            campaign_id TEXT,
            scene_id TEXT,
            embedding FLOAT[${currentDims}] distance_metric=cosine
        )
    `);
    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS lore_vss USING vec0(
            campaign_id TEXT,
            lore_id TEXT,
            embedding FLOAT[${currentDims}] distance_metric=cosine
        )
    `);
    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS rules_vss USING vec0(
            campaign_id TEXT,
            rule_id TEXT,
            embedding FLOAT[${currentDims}] distance_metric=cosine
        )
    `);

    // Metadata table for embedding versioning
    db.exec(`
        CREATE TABLE IF NOT EXISTS embedding_meta (
            campaign_id TEXT NOT NULL,
            item_type TEXT NOT NULL,
            item_id TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            updated_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (campaign_id, item_type, item_id)
        )
    `);

    if (rebuilt) {
        // The vectors are gone, but `embedding_meta` still recorded every item
        // as embedded at the current version. Status reads only this table, so
        // it reported everything current; and re-index only re-embeds rows
        // below the current version, so it found nothing to do. Changing the
        // embedding model therefore left recall permanently empty with no way
        // back through the UI.
        //
        // Marking the rows stale — rather than deleting them — keeps the record
        // of WHAT was embedded, which is exactly the list re-index needs. The
        // existing stale-version path then rebuilds every vector.
        const { changes } = db.prepare('UPDATE embedding_meta SET version = ?').run(REBUILD_PENDING_VERSION);
        console.warn(`[VectorStore] Tables rebuilt for ${currentDims} dims; marked ${changes} embeddings stale for re-index.`);
    }

    const settings = readJson(SETTINGS_FILE, {});
    if (settings?.settings && !settings.settings[VEC_DIMS_KEY]) {
        settings.settings[VEC_DIMS_KEY] = currentDims;
        writeJson(SETTINGS_FILE, settings);
    }

    console.log(`[VectorStore] Initialized (${currentDims} dims, cosine, meta v${EMBEDDING_VERSION})`);
}

function createStoreFn(table, idCol, itemType) {
    // Prepared once per table and reused, rather than re-compiled on every
    // call, and run as ONE transaction instead of three implicit ones. Same
    // three statements, same order, same SQL — only the commit boundary and
    // the statement lifetime change.
    let stmts = null;
    let runTx = null;
    // The handle the cached statements belong to. A statement is bound to the
    // connection that prepared it, so if `initDb` ever opens a new one the
    // cache must be rebuilt rather than reused against the old handle.
    let preparedFor = null;

    return (campaignId, itemId, embedding) => {
        if (!db) return;
        if (preparedFor !== db) {
            preparedFor = db;
            stmts = {
                del: db.prepare(`DELETE FROM ${table} WHERE campaign_id = ? AND ${idCol} = ?`),
                ins: db.prepare(`INSERT INTO ${table}(campaign_id, ${idCol}, embedding) VALUES (?, ?, ?)`),
                meta: db.prepare(`INSERT OR REPLACE INTO embedding_meta (campaign_id, item_type, item_id, version, updated_at) VALUES (?, ?, ?, ?, ?)`),
            };
            runTx = db.transaction((cId, iId, emb) => {
                stmts.del.run(cId, iId);
                stmts.ins.run(cId, iId, emb);
                // Stamp version metadata
                stmts.meta.run(cId, itemType, iId, EMBEDDING_VERSION, Date.now());
            });
        }
        runTx(campaignId, itemId, embedding);
    };
}
export const storeArchiveEmbedding = createStoreFn('archive_vss', 'scene_id', 'scene');
export const storeLoreEmbedding = createStoreFn('lore_vss', 'lore_id', 'lore');
export const storeRulesEmbedding = createStoreFn('rules_vss', 'rule_id', 'rule');

// ─── Scoped vector search (WO-10) ───────────────────────────────────────────
// Over-fetch cap for the scoped-search fallback path. sqlite-vec vec0 restricts
// auxiliary WHERE clauses on KNN queries; when the `IN (...)` scope constraint
// is rejected, we over-fetch (limit * 4, capped here) and JS-filter to scopeIds.
// The cap bounds the worst-case row count pulled back before filtering.
const SCOPE_FALLBACK_OVERFETCH_CAP = 64;

/**
 * Normalize the optional `scopeIds` opt. Returns null when no scope is requested
 * (missing, non-array, or empty after filtering to non-empty strings) so the
 * search function takes the unchanged unscoped path. A degenerate empty array
 * is treated as "no scope" (returns all) — the additive no-op reading per WO-10
 * invariant 8 (existing callers unaffected).
 */
function normalizeScopeIds(scopeIds) {
    if (scopeIds === undefined || scopeIds === null) return null;
    if (!Array.isArray(scopeIds)) return null;
    const filtered = scopeIds.filter(s => typeof s === 'string' && s.length > 0);
    return filtered.length > 0 ? filtered : null;
}

// `applyMmr` is fixed per search type at construction time. archive + lore are
// diversified (near-duplicate scenes/lore are redundant); rules are NOT — rule
// chunks aren't redundant, and diversity-reranking could evict the one rule a
// turn needs in favour of a "more different" but less relevant one. searchRules
// is built with applyMmr=false and ignores the `diversity` flag entirely.
function createSearchFn(table, idCol, resultKey, itemType, applyMmr) {
    return (campaignId, queryEmbedding, limit, diversity = true, opts = {}) => {
        if (!db) return [];
        const useMmr = applyMmr && diversity !== false;
        // Pull a wider candidate pool than the final limit so MMR has room to
        // diversify, then return `limit` after reranking.
        const poolSize = useMmr ? Math.max(limit, MMR_MIN_POOL, limit * 3) : limit;
        const cols = useMmr ? `${idCol}, distance, embedding` : `${idCol}, distance`;
        try {
            let rows;
            const scopeIds = normalizeScopeIds(opts.scopeIds);
            if (scopeIds) {
                // Scoped path (WO-10): add an `AND {idCol} IN (...)` constraint to
                // the KNN query, parameterized. sqlite-vec vec0 restricts auxiliary
                // WHERE clauses on KNN queries; if this throws, fall back below.
                try {
                    const placeholders = scopeIds.map(() => '?').join(',');
                    rows = db.prepare(`
                        SELECT ${cols}
                        FROM ${table}
                        WHERE embedding MATCH ? AND campaign_id = ? AND ${idCol} IN (${placeholders})
                        ORDER BY distance
                        LIMIT ?
                    `).all(queryEmbedding, campaignId, ...scopeIds, poolSize);
                } catch (scopeErr) {
                    // sqlite-vec rejected the IN constraint — over-fetch (limit * 4,
                    // cap 64) and JS-filter to scopeIds. The fallback query's own
                    // errors propagate to the outer catch.
                    console.warn(`[VectorStore] ${table} scoped search (SQL IN) failed, falling back to over-fetch: ${scopeErr.message}`);
                    const overFetch = Math.min(limit * 4, SCOPE_FALLBACK_OVERFETCH_CAP);
                    rows = db.prepare(`
                        SELECT ${cols}
                        FROM ${table}
                        WHERE embedding MATCH ? AND campaign_id = ?
                        ORDER BY distance
                        LIMIT ?
                    `).all(queryEmbedding, campaignId, overFetch);
                    const scopeSet = new Set(scopeIds);
                    rows = rows.filter(r => scopeSet.has(r[idCol]));
                }
            } else {
                rows = db.prepare(`
                    SELECT ${cols}
                    FROM ${table}
                    WHERE embedding MATCH ? AND campaign_id = ?
                    ORDER BY distance
                    LIMIT ?
                `).all(queryEmbedding, campaignId, poolSize);
            }
            // Filter out stale embeddings (version mismatch) and unversioned embeddings (no meta entry)
            const currentVersion = EMBEDDING_VERSION;
            const staleIds = new Set();
            if (rows.length > 0) {
                const ids = rows.map(r => r[idCol]);
                const placeholders = ids.map(() => '?').join(',');
                const metaRows = db.prepare(
                    `SELECT item_id, version FROM embedding_meta WHERE campaign_id = ? AND item_type = ? AND item_id IN (${placeholders})`
                ).all(campaignId, itemType, ...ids);
                const metaIds = new Set(metaRows.map(m => m.item_id));
                for (const m of metaRows) {
                    if (m.version < currentVersion) staleIds.add(m.item_id);
                }
                // Also filter out embeddings that have no meta entry (unversioned/orphans)
                for (const id of ids) {
                    if (!metaIds.has(id)) staleIds.add(id);
                }
            }

            // rows arrive sorted by distance ascending (most relevant first).
            const fresh = rows.filter(r => !staleIds.has(r[idCol]));

            if (useMmr && fresh.length >= MMR_MIN_POOL && fresh.length > limit) {
                // sqlite-vec cosine distance = 1 - cosine similarity.
                const pool = fresh
                    .map(r => ({
                        id: r[idCol],
                        score: 1 - r.distance,
                        vector: blobToFloat32(r.embedding),
                    }))
                    .filter(p => p.vector); // drop rows with missing/corrupt embedding blobs; cosineSimilarity(null,...) would throw
                if (pool.length > 0) {
                    return mmrSelect(pool, limit).map(h => ({ [resultKey]: h.id, distance: 1 - h.score }));
                }
                // else: every fresh row lacked a usable vector — fall through to the plain slice below
            }

            return fresh.slice(0, limit).map(r => ({ [resultKey]: r[idCol], distance: r.distance }));
        } catch (err) {
            console.error(`[VectorStore] ${table} search failed:`, err.message);
            return [];
        }
    };
}
export const searchArchive = createSearchFn('archive_vss', 'scene_id', 'sceneId', 'scene', true);
export const searchLore = createSearchFn('lore_vss', 'lore_id', 'loreId', 'lore', true);
// Rules are deliberately never diversified — see comment above createSearchFn.
export const searchRules = createSearchFn('rules_vss', 'rule_id', 'ruleId', 'rule', false);

/**
 * Every scene id that currently holds a vector for this campaign.
 *
 * Read from `embedding_meta` rather than `archive_vss`: the meta table is a
 * plain table (scannable), and both are written together by
 * `storeArchiveEmbedding`, so their id sets match. Used by backup restore to
 * find vectors whose scene no longer exists in the restored index.
 */
export function listArchiveSceneIds(campaignId) {
    if (!db) return [];
    return db.prepare("SELECT item_id FROM embedding_meta WHERE campaign_id = ? AND item_type = 'scene'")
        .all(campaignId)
        .map(r => r.item_id);
}

export function deleteArchiveEmbedding(campaignId, sceneId) {
    if (!db) return;
    db.prepare("DELETE FROM archive_vss WHERE campaign_id = ? AND scene_id = ?").run(campaignId, sceneId);
    db.prepare("DELETE FROM embedding_meta WHERE campaign_id = ? AND item_type = 'scene' AND item_id = ?").run(campaignId, sceneId);
}

/**
 * Drop EVERY scene vector for a campaign, leaving lore + rules untouched.
 * Used by clear-archive, which wipes the prose/index/chapters/timeline but has
 * no business touching the lore or rules indexes.
 */
export function deleteAllArchiveEmbeddings(campaignId) {
    if (!db) return;
    db.prepare("DELETE FROM archive_vss WHERE campaign_id = ?").run(campaignId);
    db.prepare("DELETE FROM embedding_meta WHERE campaign_id = ? AND item_type = 'scene'").run(campaignId);
}

export function deleteRulesEmbedding(campaignId, ruleId) {
    if (!db) return;
    db.prepare("DELETE FROM rules_vss WHERE campaign_id = ? AND rule_id = ?").run(campaignId, ruleId);
    db.prepare("DELETE FROM embedding_meta WHERE campaign_id = ? AND item_type = 'rule' AND item_id = ?").run(campaignId, ruleId);
}

export function deleteCampaignEmbeddings(campaignId) {
    if (!db) return;
    db.prepare("DELETE FROM archive_vss WHERE campaign_id = ?").run(campaignId);
    db.prepare("DELETE FROM lore_vss WHERE campaign_id = ?").run(campaignId);
    db.prepare("DELETE FROM rules_vss WHERE campaign_id = ?").run(campaignId);
    db.prepare("DELETE FROM embedding_meta WHERE campaign_id = ?").run(campaignId);
}

export function getEmbeddingStatus(campaignId) {
    if (!db) return { scenes: { total: 0, current: 0, stale: 0 }, lore: { total: 0, current: 0, stale: 0 }, rules: { total: 0, current: 0, stale: 0 }, version: EMBEDDING_VERSION };
    const currentVersion = EMBEDDING_VERSION;
    const sceneMeta = db.prepare("SELECT version, COUNT(*) as count FROM embedding_meta WHERE campaign_id = ? AND item_type = 'scene' GROUP BY version").all(campaignId);
    const loreMeta = db.prepare("SELECT version, COUNT(*) as count FROM embedding_meta WHERE campaign_id = ? AND item_type = 'lore' GROUP BY version").all(campaignId);
    const rulesMeta = db.prepare("SELECT version, COUNT(*) as count FROM embedding_meta WHERE campaign_id = ? AND item_type = 'rule' GROUP BY version").all(campaignId);

    let scenesTotal = 0, scenesCurrent = 0, scenesStale = 0;
    for (const row of sceneMeta) {
        scenesTotal += row.count;
        if (row.version >= currentVersion) scenesCurrent += row.count;
        else scenesStale += row.count;
    }

    let loreTotal = 0, loreCurrent = 0, loreStale = 0;
    for (const row of loreMeta) {
        loreTotal += row.count;
        if (row.version >= currentVersion) loreCurrent += row.count;
        else loreStale += row.count;
    }

    let rulesTotal = 0, rulesCurrent = 0, rulesStale = 0;
    for (const row of rulesMeta) {
        rulesTotal += row.count;
        if (row.version >= currentVersion) rulesCurrent += row.count;
        else rulesStale += row.count;
    }

    return {
        scenes: { total: scenesTotal, current: scenesCurrent, stale: scenesStale },
        lore: { total: loreTotal, current: loreCurrent, stale: loreStale },
        rules: { total: rulesTotal, current: rulesCurrent, stale: rulesStale },
        version: EMBEDDING_VERSION,
    };
}

export function getDb() { return db; }
