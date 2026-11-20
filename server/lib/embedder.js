import { DATA_DIR, SETTINGS_FILE, readJson } from './fileStore.js';
import path from 'path';
import fs from 'fs';

const CACHE_DIR = path.join(DATA_DIR, '.embeddings_cache');

/**
 * The embedding models a player can pick. `english` is the built-in default and
 * what every existing install runs; `multilingual` is an opt-in download.
 *
 *   id               Hugging Face repo, loaded by transformers.js into CACHE_DIR
 *   dims             vector size (the vec tables are built for it)
 *   dtype            transformers.js dtype; q8 loads onnx/model_quantized.onnx
 *   queryPrefix      put before text that is searched FOR (embedQuery)
 *   passagePrefix    put before text that is stored and searched (embedText/embedBatch)
 *   maxInputTokens   the model reads at most this many tokens; the tokenizer truncates
 *   approxDownloadMB weights + tokenizer, shown in settings before the download
 *
 * Multilingual pick: Xenova/multilingual-e5-small. It has a transformers.js ONNX
 * build with a q8 file (onnx/model_quantized.onnx, 118 MB, plus a 17 MB tokenizer),
 * uses mean pooling like mxbai (so the same pipeline call works), covers ~100
 * languages including Polish, and is fast on CPU. The alternative, Xenova/bge-m3,
 * is 570 MB at q8, uses CLS pooling and is several times slower per passage on
 * CPU; its 8k context buys nothing here because scenes are embedded as
 * ~1,500-character passages. e5 is trained with "query: " / "passage: " prefixes
 * and loses quality without them.
 */
export const EMBEDDING_MODELS = Object.freeze({
    english: Object.freeze({
        key: 'english',
        id: 'mixedbread-ai/mxbai-embed-large-v1',
        provider: 'local-mxbai',
        dims: 1024,
        dtype: 'q8',
        // mxbai-embed-large-v1 is trained for asymmetric retrieval: a search query
        // carries this instruction and the passages it is matched against carry
        // none (model card).
        queryPrefix: 'Represent this sentence for searching relevant passages: ',
        passagePrefix: '',
        maxInputTokens: 512,
        approxDownloadMB: 340,
        weightsFile: 'onnx/model_quantized.onnx',
    }),
    multilingual: Object.freeze({
        key: 'multilingual',
        id: 'Xenova/multilingual-e5-small',
        provider: 'local-e5-multilingual',
        dims: 384,
        dtype: 'q8',
        queryPrefix: 'query: ',
        passagePrefix: 'passage: ',
        maxInputTokens: 512,
        approxDownloadMB: 135,
        weightsFile: 'onnx/model_quantized.onnx',
    }),
});

export const DEFAULT_EMBEDDING_MODEL_KEY = 'english';

/** Server setting (data/settings.json → settings) holding the player's model choice. */
export const EMBEDDING_MODEL_SETTING_KEY = 'embeddingModelKey';

/** The registry entry for `key`; the default for anything unknown. */
export function getModelSpec(key) {
    return EMBEDDING_MODELS[key] ?? EMBEDDING_MODELS[DEFAULT_EMBEDDING_MODEL_KEY];
}

/** Text as the model expects it for a search query. */
export function formatQuery(text, key) {
    return getModelSpec(key).queryPrefix + text;
}

/** Text as the model expects it for a stored passage. */
export function formatPassage(text, key) {
    return getModelSpec(key).passagePrefix + text;
}

/**
 * True when the model's weights and tokenizer are already in the local cache, so
 * loading it needs no network. transformers.js writes each file under a temp name
 * and renames it when complete, so a present file is a whole file.
 */
export function isModelDownloaded(key) {
    const spec = EMBEDDING_MODELS[key];
    if (!spec) return false;
    const dir = path.join(CACHE_DIR, ...spec.id.split('/'));
    return [spec.weightsFile, 'tokenizer.json', 'config.json']
        .every(f => fs.existsSync(path.join(dir, f)));
}

/**
 * The model the server should run: the player's choice when it is a known model
 * whose files are on disk, otherwise the default. The default needs no check — it
 * downloads on first use, as it always has. So a failed or unfinished download,
 * or deleted files, fall back to the built-in model instead of breaking recall.
 */
export function resolveModelKey(requested, downloaded = isModelDownloaded) {
    if (!requested || !EMBEDDING_MODELS[requested]) return DEFAULT_EMBEDDING_MODEL_KEY;
    if (requested === DEFAULT_EMBEDDING_MODEL_KEY) return requested;
    return downloaded(requested) ? requested : DEFAULT_EMBEDDING_MODEL_KEY;
}

/** The model the player chose in settings (not necessarily the one running). */
export function readSelectedModelKey() {
    const requested = readJson(SETTINGS_FILE, {})?.settings?.[EMBEDDING_MODEL_SETTING_KEY];
    return EMBEDDING_MODELS[requested] ? requested : DEFAULT_EMBEDDING_MODEL_KEY;
}

let activeKey = null;
// Bumped on every model switch. An inference that started under an older model
// must not hand its vectors to a store that now holds another model's.
let generation = 0;

function activeSpec() {
    if (activeKey === null) {
        const requested = readSelectedModelKey();
        activeKey = resolveModelKey(requested);
        if (activeKey !== requested) {
            console.warn(`[Embedder] Selected model "${requested}" is not downloaded; using "${activeKey}".`);
        }
    }
    return EMBEDDING_MODELS[activeKey];
}

/** Registry key of the model in use. */
export function getActiveModelKey() {
    return activeSpec().key;
}

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

async function createExtractor(spec, progressCallback) {
    ensureCacheDir();
    const { pipeline } = await import('@huggingface/transformers');
    return pipeline('feature-extraction', spec.id, {
        dtype: spec.dtype,
        cache_dir: CACHE_DIR,
        ...(progressCallback ? { progress_callback: progressCallback } : {}),
    });
}

let loadingPromise = null;

async function loadModel() {
    if (extractor) return extractor;
    if (!loadingPromise) {
        const spec = activeSpec();
        const gen = generation;
        loadingPromise = createExtractor(spec).then(
            (model) => {
                loadingPromise = null;
                if (gen !== generation) {
                    // The model was switched while this one loaded.
                    void model.dispose?.();
                    return loadModel();
                }
                extractor = model;
                console.log(`[Embedder] Model loaded: ${spec.id} (${spec.dims} dims, CPU)`);
                return extractor;
            },
            (err) => {
                loadingPromise = null;
                throw err;
            },
        );
    }
    return loadingPromise;
}

/**
 * Download (if needed) and load `key`'s model WITHOUT making it active, reporting
 * transformers.js progress events to `onProgress`. Resolves to the loaded pipeline,
 * which `setActiveModel` can adopt so the switch does not load it twice. Rejects
 * when offline or the download fails; the active model is untouched either way.
 */
export async function downloadModel(key, onProgress) {
    const spec = EMBEDDING_MODELS[key];
    if (!spec) throw new Error(`Unknown embedding model: ${key}`);
    const model = await createExtractor(spec, onProgress);
    // One inference proves the files are usable, not just present.
    await model('warmup', { pooling: 'mean', normalize: true });
    return model;
}

/**
 * Make `key` the running model. Drops the loaded pipeline and the embedding cache
 * and bumps the generation, so nothing computed by the old model is reused. Pass a
 * pipeline from `downloadModel` to adopt it instead of loading it again.
 */
export function setActiveModel(key, preloaded = null) {
    const spec = EMBEDDING_MODELS[key];
    if (!spec) throw new Error(`Unknown embedding model: ${key}`);
    const old = extractor;
    generation++;
    activeKey = key;
    extractor = preloaded;
    loadingPromise = null;
    warmupPromise = null;
    modelReady = !!preloaded;
    embedCache.clear();
    if (old && old !== preloaded) void old.dispose?.();
    console.log(`[Embedder] Active model: ${spec.id} (${spec.dims} dims)`);
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

export class ModelChangedError extends Error {
    constructor() {
        super('Embedding model changed during inference; result discarded');
        this.name = 'ModelChangedError';
    }
}

function assertGeneration(gen) {
    if (gen !== generation) throw new ModelChangedError();
}

async function runInference(texts) {
    const gen = generation;
    const model = await loadModel();
    assertGeneration(gen);
    const output = await model(texts, { pooling: 'mean', normalize: true });
    assertGeneration(gen);
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

// Embed one text exactly as given (prefix already applied).
async function embedRaw(text) {
    const cached = cacheGet(text);
    if (cached) return cached;

    const [vec] = await runInference([text]);
    cacheSet(text, vec);
    return vec;
}

/** Embed text that is stored and searched (a scene passage, a lore chunk, a rule). */
export async function embedText(text) {
    if (!text || !text.trim()) return new Float32Array(getActiveDims());
    return embedRaw(formatPassage(text, getActiveModelKey()));
}

/** Embed many stored texts, prefixed like `embedText`. */
export async function embedBatch(rawTexts, batchSize = 10, delayMs = 100) {
    const gen = generation;
    const key = getActiveModelKey();
    const texts = rawTexts.map(t => (t && t.trim() ? formatPassage(t, key) : t));
    const results = new Array(texts.length);

    for (let i = 0; i < texts.length; i += batchSize) {
        const batchSlice = texts.slice(i, i + batchSize);
        const batchPositions = [];
        const uncached = [];
        const cachedVecs = [];

        for (let j = 0; j < batchSlice.length; j++) {
            const text = batchSlice[j];
            if (!text || !text.trim()) {
                cachedVecs[j] = new Float32Array(getActiveDims());
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
    // Cached vectors and the delays between batches can span a model switch.
    assertGeneration(gen);
    return results;
}

export function getActiveDims() {
    return activeSpec().dims;
}

export function getActiveProvider() {
    return activeSpec().provider;
}

export function getActiveModelId() {
    return activeSpec().id;
}

/** Embed text that is searched FOR (a player message, an expanded query). */
export async function embedQuery(text) {
    if (!text || !text.trim()) return embedText('');
    return embedRaw(formatQuery(text, getActiveModelKey()));
}

// A scene is embedded as passages of its own prose and ranked by its best passage,
// so the whole scene is searchable: GMs often recap the deal or the outcome at the
// END of a scene. Both registry models read at most 512 tokens per input (see
// `maxInputTokens`); ~1,500 characters plus the context line stays under that.
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
