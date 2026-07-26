import { API_BASE as API } from '../../lib/apiBase';

export type TtsStatus = {
    modelReady: boolean;
    modelCached: boolean;
    initializing: boolean;
    voice: string;
    modelId: string;
    dtype: string;
};

export async function getTtsStatus(): Promise<TtsStatus> {
    const res = await fetch(`${API}/tts/status`);
    if (!res.ok) throw new Error(`TTS status failed: ${res.status}`);
    return res.json();
}

/**
 * Trigger the one-time model download + warmup. Resolves once ready.
 * The caller should poll getTtsStatus() to show progress.
 */
export async function initTtsModel(): Promise<TtsStatus> {
    const res = await fetch(`${API}/tts/init`, { method: 'POST' });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`TTS init failed: ${err}`);
    }
    return res.json();
}

/**
 * Synthesize speech. Returns a Blob (audio/wav) ready for <audio>/AudioContext.
 */
export async function generateTts(text: string, voice?: string): Promise<Blob> {
    const res = await fetch(`${API}/tts/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice }),
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`TTS generate failed: ${err}`);
    }
    return res.blob();
}

/**
 * Batch-check which chunks are already cached on disk.
 * Returns a boolean array — true = already generated, no need to call generate.
 */
export async function checkCachedChunks(chunks: string[], voice?: string): Promise<boolean[]> {
    const res = await fetch(`${API}/tts/check-cache`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chunks: chunks.map(text => ({ text })), voice }),
    });
    if (!res.ok) return chunks.map(() => false);
    const data = await res.json();
    return data.cached as boolean[];
}

/**
 * Load a cached WAV from disk (no Kokoro call). Returns a Blob or null.
 */
export async function loadCachedTts(text: string, voice?: string): Promise<Blob | null> {
    const params = new URLSearchParams({ text });
    if (voice) params.set('voice', voice);
    const res = await fetch(`${API}/tts/cached?${params}`);
    if (!res.ok) return null;
    return res.blob();
}