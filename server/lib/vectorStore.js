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

let db = null;
let currentDims = null;

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
    } catch {
        return null;
    }
}

export function initDb() {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(DB_PATH);
    sqliteVec.load(db);

    const version = db.prepare("select vec_version() as v").get();
    console.log(`[VectorStore] sqlite-vec v${version.v} loaded`);

    currentDims = resolveDims();
    const storedDims = getStoredSchemaDims();

    if (storedDims !== null && storedDims !== currentDims) {
        console.warn(`[VectorStore] Dimension mismatch: schema=${storedDims}, active=${currentDims}. Rebuilding tables.`);
        db.exec("DROP TABLE IF EXISTS archive_vss");
        db.exec("DROP TABLE IF EXISTS lore_vss");
        console.warn('[VectorStore] Tables dropped — run migrateEmbeddings.js to re-index');
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

    const settings = readJson(SETTINGS_FILE, {});
    if (settings?.settings && !settings.settings[VEC_DIMS_KEY]) {
        settings.settings[VEC_DIMS_KEY] = currentDims;
        writeJson(SETTINGS_FILE, settings);
    }

    console.log(`[VectorStore] Initialized (${currentDims} dims, cosine, meta v${EMBEDDING_VERSION})`);
}

function createStoreFn(table, idCol, itemType) {
    return (campaignId, itemId, embedding) => {
        if (!db) return;
        db.prepare(`DELETE FROM ${table} WHERE campaign_id = ? AND ${idCol} = ?`).run(campaignId, itemId);
        db.prepare(`INSERT INTO ${table}(campaign_id, ${idCol}, embedding) VALUES (?, ?, ?)`).run(campaignId, itemId, embedding);
        // Stamp version metadata
        db.prepare(`INSERT OR REPLACE INTO embedding_meta (campaign_id, item_type, item_id, version, updated_at) VALUES (?, ?, ?, ?, ?)`)
            .run(campaignId, itemType, itemId, EMBEDDING_VERSION, Date.now());
    };
}
export const storeArchiveEmbedding = createStoreFn('archive_vss', 'scene_id', 'scene');
export const storeLoreEmbedding = createStoreFn('lore_vss', 'lore_id', 'lore');

function createSearchFn(table, idCol, resultKey, itemType) {
    return (campaignId, queryEmbedding, limit) => {
        if (!db) return [];
        try {
            const rows = db.prepare(`
                SELECT ${idCol}, distance
                FROM ${table}
                WHERE embedding MATCH ? AND campaign_id = ?
                ORDER BY distance
                LIMIT ?
            `).all(queryEmbedding, campaignId, limit);
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
            return rows
                .filter(r => !staleIds.has(r[idCol]))
                .map(r => ({ [resultKey]: r[idCol], distance: r.distance }));
        } catch (err) {
            console.error(`[VectorStore] ${table} search failed:`, err.message);
            return [];
        }
    };
}
export const searchArchive = createSearchFn('archive_vss', 'scene_id', 'sceneId', 'scene');
export const searchLore = createSearchFn('lore_vss', 'lore_id', 'loreId', 'lore');

export function deleteArchiveEmbedding(campaignId, sceneId) {
    if (!db) return;
    db.prepare("DELETE FROM archive_vss WHERE campaign_id = ? AND scene_id = ?").run(campaignId, sceneId);
    db.prepare("DELETE FROM embedding_meta WHERE campaign_id = ? AND item_type = 'scene' AND item_id = ?").run(campaignId, sceneId);
}

export function deleteCampaignEmbeddings(campaignId) {
    if (!db) return;
    db.prepare("DELETE FROM archive_vss WHERE campaign_id = ?").run(campaignId);
    db.prepare("DELETE FROM lore_vss WHERE campaign_id = ?").run(campaignId);
    db.prepare("DELETE FROM embedding_meta WHERE campaign_id = ?").run(campaignId);
}

export function getEmbeddingStatus(campaignId) {
    if (!db) return { scenes: { total: 0, current: 0, stale: 0 }, lore: { total: 0, current: 0, stale: 0 }, version: EMBEDDING_VERSION };
    const currentVersion = EMBEDDING_VERSION;
    const sceneMeta = db.prepare("SELECT version, COUNT(*) as count FROM embedding_meta WHERE campaign_id = ? AND item_type = 'scene' GROUP BY version").all(campaignId);
    const loreMeta = db.prepare("SELECT version, COUNT(*) as count FROM embedding_meta WHERE campaign_id = ? AND item_type = 'lore' GROUP BY version").all(campaignId);

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

    return {
        scenes: { total: scenesTotal, current: scenesCurrent, stale: scenesStale },
        lore: { total: loreTotal, current: loreCurrent, stale: loreStale },
        version: EMBEDDING_VERSION,
    };
}

export function getDb() { return db; }
