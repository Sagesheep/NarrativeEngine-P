import { DATA_DIR } from './fileStore.js';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const CACHE_DIR = path.join(DATA_DIR, '.tts_cache');
const AUDIO_CACHE_DIR = path.join(CACHE_DIR, 'audio');
const DTYPE = 'q8';
const DEFAULT_VOICE = 'af_heart';

let tts = null;
let initPromise = null;
let modelReady = false;
let activeVoice = DEFAULT_VOICE;

function ensureCacheDir() {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    if (!fs.existsSync(AUDIO_CACHE_DIR)) {
        fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
    }
}

/**
 * Stable hash of (text + voice) — used as the on-disk audio cache key.
 * Same input always maps to the same WAV file, so generated audio survives
 * server restarts and campaign switches.
 */
function audioCacheHash(text, voice) {
    return crypto.createHash('sha256').update(`${voice||DEFAULT_VOICE}|${text}`).digest('hex').slice(0, 24);
}

function audioCachePath(text, voice) {
    return path.join(AUDIO_CACHE_DIR, `${audioCacheHash(text, voice)}.wav`);
}

/**
 * Check if a chunk's audio is already on disk (previously generated).
 */
export function isAudioCached(text, voice) {
    return fs.existsSync(audioCachePath(text, voice));
}

/**
 * Load a cached WAV file from disk. Returns a Buffer or null if not found.
 */
export function loadCachedAudio(text, voice) {
    const p = audioCachePath(text, voice);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
}

/**
 * kokoro-js v1.2.1 bundles its own nested @huggingface/transformers that ignores
 * the `cache_dir` option and writes to `<kokoro-js>/node_modules/.cache/...`.
 * In the packaged Electron build that path is inside the read-only ASAR, which
 * would force a re-download on every launch.
 *
 * Workaround: set the HF/Transformers.js env cache dirs BEFORE importing kokoro-js
 * so its nested transformers instance picks them up. We point both at our
 * data/.tts_cache so the model survives server restarts and stays writable.
 */
function applyCacheEnv() {
    ensureCacheDir();
    process.env.HF_HOME = CACHE_DIR;
    process.env.TRANSFORMERS_CACHE = CACHE_DIR;
    process.env.HF_HUB_CACHE = CACHE_DIR;
    process.env.XDG_CACHE_HOME = CACHE_DIR;
}

export function isTtsReady() {
    return modelReady;
}

export function getTtsStatus() {
    return {
        modelReady,
        // A cached model survives server/app restarts, but needs a short warmup
        // before it can synthesize. Expose that distinction so the UI does not
        // incorrectly tell users their download vanished during startup.
        modelCached: isTtsModelCached(),
        initializing: !!initPromise,
        voice: activeVoice,
        modelId: MODEL_ID,
        dtype: DTYPE,
    };
}

/**
 * Lazy-load Kokoro. The first call downloads ~90MB (q8) from Hugging Face into
 * CACHE_DIR. Subsequent calls reuse the cached weights. Returns the ready model.
 * Safe to call concurrently — the second caller awaits the first init.
 */
export async function initTts() {
    if (modelReady && tts) return tts;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        try {
            applyCacheEnv();
            const { KokoroTTS } = await import('kokoro-js');
            tts = await KokoroTTS.from_pretrained(MODEL_ID, {
                dtype: DTYPE,
                device: 'cpu',
                cache_dir: CACHE_DIR,
            });
            modelReady = true;
            initPromise = null; // clear so getTtsStatus() reports initializing:false once ready
            console.log(`[TTS] Kokoro model loaded: ${MODEL_ID} (${DTYPE})`);
            return tts;
        } catch (err) {
            console.error('[TTS] Init failed:', err.message);
            initPromise = null;
            throw err;
        }
    })();

    return initPromise;
}

/**
 * Synthesize speech for a single text chunk. Returns a WAV buffer.
 * Caller passes pre-stripped prose; we don't sanitize here.
 */
export async function generateSpeech(text, voice) {
    if (!text || !text.trim()) {
        const err = new Error('Empty text');
        err.statusCode = 400;
        throw err;
    }
    const v = voice || activeVoice;
    activeVoice = v;

    // Check disk cache first — if we've generated this exact (text, voice) before,
    // return the saved WAV without spinning up Kokoro.
    ensureCacheDir();
    const cached = loadCachedAudio(text, v);
    if (cached) return cached;

    const model = await initTts();
    const audio = await model.generate(text, { voice: v });
    let buf;
    if (typeof audio.toBuffer === 'function') {
        buf = Buffer.from(audio.toBuffer());
    } else if (typeof audio.blob === 'function') {
        const ab = await audio.blob();
        buf = Buffer.from(await ab.arrayBuffer());
    } else {
        const tmp = path.join(CACHE_DIR, `_tts_${Date.now()}.wav`);
        await audio.save(tmp);
        buf = fs.readFileSync(tmp);
        fs.unlink(tmp, () => {});
    }

    // Persist to disk so this chunk survives server restarts.
    try {
        fs.writeFileSync(audioCachePath(text, v), buf);
    } catch (e) {
        console.warn('[TTS] Failed to cache audio to disk:', e.message);
    }

    return buf;
}

/**
 * Check if the Kokoro model is already downloaded in the cache dir.
 * Transformers.js stores it under .cache/onnx-community/<model>/onnx/model_quantized.onnx
 * (the env vars we set append a .cache subfolder).
 */
export function isTtsModelCached() {
    const modelFile = path.join(CACHE_DIR, '.cache', 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model_quantized.onnx');
    return fs.existsSync(modelFile);
}

/**
 * Auto-warm Kokoro on server boot IF the model is already cached.
 * Does NOT trigger a download — if the user hasn't opted in yet, this is a no-op.
 * Once they've downloaded the model once, every subsequent server start will
 * have it ready instantly with no button press.
 */
export async function warmupTts() {
    if (!isTtsModelCached()) {
        return false;
    }
    try {
        const start = Date.now();
        await initTts();
        const ms = Date.now() - start;
        console.log(`[TTS] Warmup complete (${ms}ms) — model was cached, ready instantly`);
        return true;
    } catch (err) {
        console.error('[TTS] Warmup failed:', err.message);
        return false;
    }
}

/**
 * List available voices from the loaded model. Returns [] before init.
 */
export function listVoices() {
    if (!tts || typeof tts.list_voices !== 'function') return [];
    try {
        return tts.list_voices();
    } catch {
        return [];
    }
}