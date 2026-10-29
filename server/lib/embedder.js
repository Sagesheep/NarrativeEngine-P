import { DATA_DIR } from './fileStore.js';
import path from 'path';
import fs from 'fs';

const MODEL_ID = 'mixedbread-ai/mxbai-embed-large-v1';
const CACHE_DIR = path.join(DATA_DIR, '.embeddings_cache');
const ACTIVE_DIMS = 1024;
const ACTIVE_PROVIDER = 'local-mxbai';

let extractor = null;
let warmupPromise = null;
let modelReady = false;

const EMBED_CACHE_MAX = 512;
const embedCache = new Map();

function cacheGet(text) {
    if (!embedCache.has(text)) return null;
    const v = embedCache.get(text);
    embedCache.delete(text);
    embedCache.set(text, v);
    return new Float32Array(v);
}

function cacheSet(text, vec) {
    if (embedCache.size >= EMBED_CACHE_MAX) {
        const oldest = embedCache.keys().next().value;
        if (oldest !== undefined) embedCache.delete(oldest);
    }
    embedCache.set(text, new Float32Array(vec));
}

/**
 * True once the model is loaded AND has served at least one inference (warmup or a
 * real embed). Until this flips, the first embed call pays the full cold-load cost,
 * so callers on the hot path (turn-1 semantic retrieval) should short-circuit instead
 * of blocking. See server/routes/archive.js semantic-candidates routes.
 */
export function isModelReady() {
    return modelReady;
}

/**
 * Map an indexing-speed setting to embedBatch params. The model is a single CPU
 * instance, so batchSize barely changes raw throughput — the real lever is delayMs,
 * which yields the event loop between batches so the server stays responsive to the
 * active turn. 'eco' keeps the UI snappy during a big import; 'aggressive' finishes
 * fastest but starves other requests while it runs.
 */
export function resolveIndexingSpeed(speed) {
    switch (speed) {
        case 'eco': return { batchSize: 4, delayMs: 250 };
        case 'aggressive': return { batchSize: 16, delayMs: 0 };
        case 'balanced':
        default: return { batchSize: 8, delayMs: 100 };
    }
}

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
        dtype: 'q8',
        cache_dir: CACHE_DIR,
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
            void result;
            modelReady = true;
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

async function runInference(texts) {
    const model = await loadModel();
    const output = await model(texts, { pooling: 'mean', normalize: true });
    modelReady = true;
    const data = output.data;
    const src = data.buffer ? new Float32Array(data.buffer, data.byteOffset, data.length) : Float32Array.from(data);
    const batch = texts.length;
    const dims = src.length / batch;
    const out = new Array(batch);
    for (let i = 0; i < batch; i++) {
        out[i] = src.slice(i * dims, (i + 1) * dims);
    }
    return out;
}

export async function embedText(text) {
    if (!text || !text.trim()) return new Float32Array(ACTIVE_DIMS);

    const cached = cacheGet(text);
    if (cached) return cached;

    const [vec] = await runInference([text]);
    cacheSet(text, vec);
    return vec;
}

export async function embedBatch(texts, batchSize = 10, delayMs = 100) {
    const results = new Array(texts.length);

    for (let i = 0; i < texts.length; i += batchSize) {
        const batchSlice = texts.slice(i, i + batchSize);
        const batchPositions = [];
        const uncached = [];
        const cachedVecs = [];

        for (let j = 0; j < batchSlice.length; j++) {
            const text = batchSlice[j];
            if (!text || !text.trim()) {
                cachedVecs[j] = new Float32Array(ACTIVE_DIMS);
                continue;
            }
            const c = cacheGet(text);
            if (c) {
                cachedVecs[j] = c;
            } else {
                batchPositions.push(j);
                uncached.push(text);
            }
        }

        if (uncached.length > 0) {
            const out = await runInference(uncached);
            for (let k = 0; k < uncached.length; k++) {
                cachedVecs[batchPositions[k]] = out[k];
                cacheSet(uncached[k], out[k]);
            }
        }

        for (let j = 0; j < batchSlice.length; j++) {
            results[i + j] = cachedVecs[j];
        }

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

export function getActiveModelId() {
    return MODEL_ID;
}

// mxbai-embed-large-v1 is trained for asymmetric retrieval: a search query carries
// this instruction and the passages it is matched against carry none (model card).
const QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: ';

/** Embed text that is searched FOR (a player message, an expanded query). */
export async function embedQuery(text) {
    if (!text || !text.trim()) return embedText('');
    return embedText(QUERY_INSTRUCTION + text);
}

// A scene is embedded as passages of its own prose and ranked by its best passage,
// so the whole scene is searchable: GMs often recap the deal or the outcome at the
// END of a scene. The model reads at most 512 tokens per input; ~1,500 characters
// plus the context line stays under that.
const PASSAGE_CHARS = 1500;
const MAX_PASSAGES_PER_SCENE = 16;

// Lines that carry no story: rules, table separators, and engine roll results such as
// "[SOCIAL: Normal: Failure | KNOWLEDGE: Normal: Success]".
const NOISE_LINE = /^(?:[\s|:-]*-{3,}[\s|:-]*|\s*\[[A-Z][A-Z /&-]*:[^\]]*\]\s*)$/;

function cleanProse(text) {
    return String(text ?? '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter(line => !NOISE_LINE.test(line))
        .join('\n')
        .replace(/[*[\]]/g, '')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/[ \t]+/g, ' ')
        .trim();
}

// The GM's status line ("Scene #533 | 📅 … | 📍 Soll Estate, Study | 👥 [**Rin**], …")
// names the place and the cast. Its 📍 and 👥 parts become a context line on every
// passage; the clock part is dropped so same-day scenes don't look alike for it.
function splitStatusLine(gmText) {
    const lines = String(gmText ?? '').replace(/\r\n/g, '\n').split('\n');
    const first = lines.findIndex(l => l.trim());
    if (first < 0 || !/📍|👥/u.test(lines[first])) return { context: '', body: gmText ?? '' };
    const context = lines[first]
        .split('|')
        .map(part => part.trim())
        .filter(part => /^(📍|👥)/u.test(part))
        .map(part => cleanProse(part.replace(/^(📍|👥)\s*/u, '')))
        .filter(Boolean)
        .join(' — ');
    return { context, body: lines.slice(first + 1).join('\n') };
}

function splitLong(paragraph) {
    if (paragraph.length <= PASSAGE_CHARS) return [paragraph];
    const pieces = [];
    let current = '';
    for (const sentence of paragraph.split(/(?<=[.!?…]["”’)]?)\s+/u)) {
        if (current && current.length + 1 + sentence.length > PASSAGE_CHARS) {
            pieces.push(current);
            current = '';
        }
        current = current ? `${current} ${sentence}` : sentence;
        while (current.length > PASSAGE_CHARS) {
            pieces.push(current.slice(0, PASSAGE_CHARS));
            current = current.slice(PASSAGE_CHARS);
        }
    }
    if (current) pieces.push(current);
    return pieces;
}

/**
 * The texts a scene is embedded as:
 *   - its prose (the player's message, then the GM's reply) cleaned of markup and
 *     roll lines, packed by paragraph into passages of at most PASSAGE_CHARS, each
 *     led by the scene's place-and-cast line when the GM wrote one;
 *   - one cast card naming who was in it (`names`: the index's witnesses and
 *     mentioned NPCs), so a question about a person finds their scenes even where
 *     the prose names them only in passing. Measured on the Turn Prep probes, prose
 *     alone lost "who" questions (a market scene outranked Helena's) and names alone
 *     lost "what happened" questions; passages plus the card won both.
 * Empty when the scene has neither prose nor names.
 */
export function buildScenePassages(userContent, assistantContent, names = []) {
    const card = [...new Set((names ?? []).map(n => String(n).trim()).filter(Boolean))].join(', ');
    return [...buildProsePassages(userContent, assistantContent), ...(card ? [card] : [])];
}

function buildProsePassages(userContent, assistantContent) {
    const { context, body } = splitStatusLine(assistantContent);
    const user = cleanProse(userContent);
    const paragraphs = [
        ...(user ? [`Player: ${user}`] : []),
        ...cleanProse(body).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean),
    ].flatMap(splitLong);

    const passages = [];
    let current = '';
    for (const p of paragraphs) {
        if (current && current.length + 2 + p.length > PASSAGE_CHARS) {
            passages.push(current);
            current = '';
        }
        current = current ? `${current}\n\n${p}` : p;
    }
    if (current) passages.push(current);

    return passages
        .slice(0, MAX_PASSAGES_PER_SCENE)
        .map(p => (context ? `${context}\n${p}` : p));
}

export function buildLoreText(chunk) {
    const parts = [];
    if (chunk.header) parts.push(chunk.header);
    if (chunk.summary) parts.push(chunk.summary);
    if (chunk.triggerKeywords?.length) parts.push(chunk.triggerKeywords.join(' '));
    if (chunk.linkedEntities?.length) parts.push(chunk.linkedEntities.join(' '));
    return parts.join(' ').slice(0, 500);
}
