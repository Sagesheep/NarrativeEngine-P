/**
 * Embedding model choice: download, switch, re-index.
 *
 * The player picks between the built-in English model and an opt-in multilingual
 * one (registry in `server/lib/embedder.js`). Switching is:
 *
 *   1. download — load the new model's pipeline with a progress callback, while
 *      the current model keeps serving. Offline or a failed download leaves
 *      everything as it was and reports the error.
 *   2. switch   — save the choice, make the new model active, and re-open the
 *      vector store. `initDb` sees the stored model id differ from the active one
 *      and rebuilds the tables, marking every embedding stale, so vectors from two
 *      models never mix.
 *   3. re-index — rebuild the stale embeddings of every campaign in the
 *      background. Until each is rebuilt it is excluded from recall, and keyword
 *      search covers the gap.
 *
 * State is in memory: a restart mid-download just means downloading again, and a
 * restart mid-re-index leaves the rest stale, which the banner reports and
 * Re-index Now fixes.
 */
import {
    EMBEDDING_MODELS,
    DEFAULT_EMBEDDING_MODEL_KEY,
    EMBEDDING_MODEL_SETTING_KEY,
    ModelChangedError,
    getActiveModelKey,
    readSelectedModelKey,
    isModelDownloaded,
    downloadModel,
    setActiveModel,
    warmup,
} from '../lib/embedder.js';
import { initDb, getDb, markVectorStoreUnavailable, EMBEDDING_VERSIONS } from '../lib/vectorStore.js';
import { getActiveJobs } from '../lib/embedJobs.js';
import { SETTINGS_FILE, readJson, writeJson } from '../lib/fileStore.js';
import { reindexEmbeddings } from './archiveService.js';
import { reindexCampaignRules } from '../routes/rules.js';

const idleDownload = () => ({ key: null, state: 'idle', loaded: 0, total: 0, error: null });
const idleReindex = () => ({ state: 'idle', done: 0, total: 0, error: null });

let download = idleDownload();
let downloadFiles = {};
let reindex = idleReindex();
// Bumped by every switch; a re-index run stops when it is no longer the latest.
let reindexRun = 0;

export class EmbeddingModelError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/** What the settings screen shows. */
export function getEmbeddingModelStatus() {
    return {
        selected: readSelectedModelKey(),
        active: getActiveModelKey(),
        defaultKey: DEFAULT_EMBEDDING_MODEL_KEY,
        models: Object.values(EMBEDDING_MODELS).map(m => ({
            key: m.key,
            id: m.id,
            dims: m.dims,
            approxDownloadMB: m.approxDownloadMB,
            downloaded: isModelDownloaded(m.key),
        })),
        download: { ...download },
        reindex: { ...reindex },
    };
}

function busyReason() {
    if (download.state === 'downloading') return 'A model download is already running.';
    if (reindex.state === 'running') return 'Campaigns are still re-indexing for the last model change.';
    if (getActiveJobs().length > 0) return 'Indexing is running; try again when it finishes.';
    return null;
}

/**
 * Choose `key`. Switches at once when the model is the built-in one or already
 * downloaded; otherwise starts the download and switches when it completes.
 * @returns {{ status: 'unchanged' | 'switched' | 'downloading' }}
 */
export function selectEmbeddingModel(key) {
    if (!EMBEDDING_MODELS[key]) throw new EmbeddingModelError(400, `Unknown embedding model: ${key}`);
    if (key === getActiveModelKey()) {
        // Already running it (e.g. picking English back while a never-finished
        // multilingual choice was saved): record the choice, nothing to rebuild.
        if (key !== readSelectedModelKey()) saveSelectedKey(key);
        return { status: 'unchanged' };
    }
    const busy = busyReason();
    if (busy) throw new EmbeddingModelError(409, busy);

    if (key === DEFAULT_EMBEDDING_MODEL_KEY || isModelDownloaded(key)) {
        activate(key, null);
        return { status: 'switched' };
    }
    void runDownload(key);
    return { status: 'downloading' };
}

function onProgress(info) {
    if (!info || info.status !== 'progress' || !info.file) return;
    downloadFiles[info.file] = { loaded: info.loaded ?? 0, total: info.total ?? 0 };
    let loaded = 0;
    let total = 0;
    for (const f of Object.values(downloadFiles)) {
        loaded += f.loaded;
        total += f.total;
    }
    download.loaded = loaded;
    download.total = total;
}

async function runDownload(key) {
    download = { ...idleDownload(), key, state: 'downloading' };
    downloadFiles = {};
    let model;
    try {
        model = await downloadModel(key, onProgress);
    } catch (err) {
        // Offline, a dropped connection, or a broken file: the running model is
        // untouched and the choice is not saved, so recall carries on as before.
        console.warn(`[EmbeddingModel] Download of ${key} failed: ${err.message}`);
        download = { ...download, state: 'failed', error: err.message };
        return;
    }
    // A bulk embed that started during the download would have its result thrown
    // away by the switch; let it finish first.
    while (getActiveJobs().length > 0) await new Promise(r => setTimeout(r, 1000));
    download = { ...download, state: 'done', loaded: download.total };
    activate(key, model);
}

function saveSelectedKey(key) {
    const settings = readJson(SETTINGS_FILE, {}) ?? {};
    settings.settings ??= {};
    settings.settings[EMBEDDING_MODEL_SETTING_KEY] = key;
    writeJson(SETTINGS_FILE, settings);
}

function activate(key, preloaded) {
    saveSelectedKey(key);
    setActiveModel(key, preloaded);
    try {
        initDb();   // the model id changed: tables rebuilt, every embedding marked stale
    } catch (err) {
        console.error('[EmbeddingModel] Vector store re-open failed:', err.message);
        markVectorStoreUnavailable(err.message);
        return;
    }
    if (!preloaded) void warmup();
    void reindexAllCampaigns();
}

/** Campaigns with at least one embedding below its type's current version. */
export function campaignsNeedingReindex(db) {
    if (!db) return [];
    return db.prepare(
        `SELECT DISTINCT campaign_id FROM embedding_meta
         WHERE (item_type = 'scene' AND version < ?) OR (item_type = 'lore' AND version < ?) OR (item_type = 'rule' AND version < ?)
         ORDER BY campaign_id`,
    ).all(EMBEDDING_VERSIONS.scene, EMBEDDING_VERSIONS.lore, EMBEDDING_VERSIONS.rule).map(r => r.campaign_id);
}

async function reindexAllCampaigns() {
    const run = ++reindexRun;
    const db = getDb();
    const ids = campaignsNeedingReindex(db);
    reindex = { ...idleReindex(), state: 'running', total: ids.length };
    try {
        for (const id of ids) {
            if (run !== reindexRun) return;
            await reindexEmbeddings(id, 'all');
            const staleRules = db.prepare(
                `SELECT COUNT(*) AS n FROM embedding_meta WHERE campaign_id = ? AND item_type = 'rule' AND version < ?`,
            ).get(id, EMBEDDING_VERSIONS.rule).n;
            if (staleRules > 0) {
                const result = await reindexCampaignRules(id);
                if (result.status !== 'success') {
                    // No rules text left to rebuild from: the stale rows describe
                    // nothing, and would keep the banner up forever.
                    db.prepare(`DELETE FROM embedding_meta WHERE campaign_id = ? AND item_type = 'rule' AND version < ?`)
                        .run(id, EMBEDDING_VERSIONS.rule);
                }
            }
            if (run === reindexRun) reindex.done++;
        }
        if (run === reindexRun) reindex.state = 'done';
    } catch (err) {
        if (err instanceof ModelChangedError || run !== reindexRun) return;   // a newer switch took over
        console.error('[EmbeddingModel] Re-index after model change failed:', err.message);
        reindex = { ...reindex, state: 'failed', error: err.message };
    }
}

/** Test hook: clear in-memory download/re-index state. */
export function _resetEmbeddingModelState() {
    download = idleDownload();
    downloadFiles = {};
    reindex = idleReindex();
    reindexRun++;
}
