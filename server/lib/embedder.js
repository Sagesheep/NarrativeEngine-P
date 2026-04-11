import { DATA_DIR } from './fileStore.js';
import path from 'path';
import fs from 'fs';

const MODEL_ID = 'Xenova/mxbai-embed-large-v1';
const CACHE_DIR = path.join(DATA_DIR, '.embeddings_cache');
const ACTIVE_DIMS = 1024;
const ACTIVE_PROVIDER = 'local-mxbai';

let extractor = null;
let warmupPromise = null;

function ensureCacheDir() {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
}

async function loadModel() {
    if (extractor) return extractor;

    ensureCacheDir();

    const { pipeline } = await import('@huggingface/transformers');
    extractor = await pipeline('feature-extraction', MODEL_ID, {
        dtype: 'fp32',
        model_cache_dir: CACHE_DIR,
    });

    console.log(`[Embedder] Model loaded: ${MODEL_ID} (${ACTIVE_DIMS} dims, CPU)`);
    return extractor;
}

export async function warmup() {
    if (warmupPromise) return warmupPromise;

    warmupPromise = (async () => {
        try {
            const start = Date.now();
            const model = await loadModel();
            const result = await model('warmup', { pooling: 'mean', normalize: true });
            const ms = Date.now() - start;
            console.log(`[Embedder] Warmup complete (${ms}ms)`);
            return true;
        } catch (err) {
            console.error('[Embedder] Warmup failed:', err.message);
            warmupPromise = null;
            return false;
        }
    })();

    return warmupPromise;
}

export async function embedText(text) {
    if (!text || !text.trim()) return new Float32Array(ACTIVE_DIMS);

    const model = await loadModel();
    const output = await model(text, { pooling: 'mean', normalize: true });
    const data = output.data;
    return new Float32Array(data.buffer ? data : Float32Array.from(data));
}

export async function embedBatch(texts, batchSize = 10, delayMs = 100) {
    const results = [];
    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(t => embedText(t)));
        results.push(...batchResults);

        if (i + batchSize < texts.length && delayMs > 0) {
            await new Promise(r => setTimeout(r, delayMs));
        }

        console.log(`[Embedder] Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(texts.length / batchSize)} done`);
    }
    return results;
}

export function getActiveDims() {
    return ACTIVE_DIMS;
}

export function getActiveProvider() {
    return ACTIVE_PROVIDER;
}

export function buildArchiveText(indexEntry) {
    const parts = [];
    if (indexEntry.witnesses?.length) parts.push(indexEntry.witnesses.join(' '));
    if (indexEntry.npcsMentioned?.length) parts.push(indexEntry.npcsMentioned.join(' '));
    if (indexEntry.keywords?.length) parts.push(indexEntry.keywords.join(' '));
    if (indexEntry.userSnippet) parts.push(indexEntry.userSnippet);
    return parts.join(' ').slice(0, 500);
}

export function buildLoreText(chunk) {
    const parts = [];
    if (chunk.header) parts.push(chunk.header);
    if (chunk.summary) parts.push(chunk.summary);
    if (chunk.triggerKeywords?.length) parts.push(chunk.triggerKeywords.join(' '));
    if (chunk.linkedEntities?.length) parts.push(chunk.linkedEntities.join(' '));
    return parts.join(' ').slice(0, 500);
}
