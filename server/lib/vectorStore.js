import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { DATA_DIR, readJson, writeJson, SETTINGS_FILE } from './fileStore.js';
import { getActiveDims as embedderDims } from './embedder.js';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(DATA_DIR, 'embeddings.db');
const VEC_DIMS_KEY = 'embeddingDims';

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

    const settings = readJson(SETTINGS_FILE, {});
    if (settings?.settings && !settings.settings[VEC_DIMS_KEY]) {
        settings.settings[VEC_DIMS_KEY] = currentDims;
        writeJson(SETTINGS_FILE, settings);
    }

    console.log(`[VectorStore] Initialized (${currentDims} dims, cosine)`);
}

function createStoreFn(table, idCol) {
    return (campaignId, itemId, embedding) => {
        if (!db) return;
        db.prepare(`DELETE FROM ${table} WHERE campaign_id = ? AND ${idCol} = ?`).run(campaignId, itemId);
        db.prepare(`INSERT INTO ${table}(campaign_id, ${idCol}, embedding) VALUES (?, ?, ?)`).run(campaignId, itemId, embedding);
    };
}
export const storeArchiveEmbedding = createStoreFn('archive_vss', 'scene_id');
export const storeLoreEmbedding = createStoreFn('lore_vss', 'lore_id');

function createSearchFn(table, idCol, resultKey) {
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
            return rows.map(r => ({ [resultKey]: r[idCol], distance: r.distance }));
        } catch (err) {
            console.error(`[VectorStore] ${table} search failed:`, err.message);
            return [];
        }
    };
}
export const searchArchive = createSearchFn('archive_vss', 'scene_id', 'sceneId');
export const searchLore = createSearchFn('lore_vss', 'lore_id', 'loreId');

export function deleteArchiveEmbedding(campaignId, sceneId) {
    if (!db) return;
    db.prepare("DELETE FROM archive_vss WHERE campaign_id = ? AND scene_id = ?").run(campaignId, sceneId);
}

export function deleteCampaignEmbeddings(campaignId) {
    if (!db) return;
    db.prepare("DELETE FROM archive_vss WHERE campaign_id = ?").run(campaignId);
    db.prepare("DELETE FROM lore_vss WHERE campaign_id = ?").run(campaignId);
}

export function getDb() { return db; }
