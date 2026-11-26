import { generateTts, loadCachedTts, checkCachedChunks } from './ttsClient';
import { proseForTTS, chunkSentencesForTTS, splitWords } from './proseStripper';

/**
 * Kokoro audio buffering + playback engine, extracted from MessageBubble.
 *
 * Owns the chunk cache, the producer (generate/load audio per sentence chunk),
 * and the consumer loop (ordered playback with skip/pause/speed). All React
 * state updates flow through the callbacks; the component wires them to
 * useState via useTtsPlayback. One instance per message bubble.
 */

export type KokoroBufferCallbacks = {
    setLoading: (v: boolean) => void;
    setPlaying: (v: boolean) => void;
    setPaused: (v: boolean) => void;
    setFinished: (v: boolean) => void;
    setActiveSentenceIdx: (v: number) => void;
    setActiveWordIdx: (v: number) => void;
    setTotalChunks: (v: number) => void;
    setGeneratedChunks: (v: number) => void;
    setHasCache: (v: boolean) => void;
    setPlaybackRate: (v: number) => void;
};

type CachedChunk = { blob: Blob; url: string; words: string[] };
type QueueItem = { idx: number } & CachedChunk;

const WORDS_PER_SEC = 2.5;

export class KokoroBuffer {
    private cb: KokoroBufferCallbacks;
    private audio: HTMLAudioElement | null = null;
    private chunkAbort = false;
    private sentenceTimers: ReturnType<typeof setTimeout>[] = [];
    private wordTimers: ReturnType<typeof setTimeout>[] = [];
    private queue: QueueItem[] = [];
    // Persistent cache of generated chunks — survives stop + replay.
    // Only wiped by the trash button or destroy() on unmount.
    private cache = new Map<number, CachedChunk>();
    private skipToChunk: number | null = null;
    private initialSkip: number | null = null;  // set before speak() to start from a chunk
    private rate = 1;
    private pauseFlag = false;
    // Resolve function for the currently-playing chunk's `finished` promise.
    // stop() calls this to wake up the zombie consumer so it exits cleanly.
    private finishResolve: (() => void) | null = null;
    // Mirrors of the React state the component renders, so speak()/jump logic
    // can branch without waiting on a render cycle.
    private loading = false;
    private playing = false;

    constructor(cb: KokoroBufferCallbacks) {
        this.cb = cb;
    }

    private setLoading(v: boolean) { this.loading = v; this.cb.setLoading(v); }
    private setPlaying(v: boolean) { this.playing = v; this.cb.setPlaying(v); }

    private clearTimers() {
        for (const t of this.sentenceTimers) clearTimeout(t);
        for (const t of this.wordTimers) clearTimeout(t);
        this.sentenceTimers = [];
        this.wordTimers = [];
    }

    get isBusy(): boolean {
        return this.playing || this.loading;
    }

    /** Request a jump to a chunk while playback is running. */
    requestSkip(idx: number) {
        this.skipToChunk = idx;
    }

    /** Arm a start-from-chunk for the next speak() call (clicked while stopped). */
    setInitialSkip(idx: number) {
        this.initialSkip = idx;
    }

    // Stop playback + generation, but KEEP the cache. Next press resumes from
    // chunk 0 using cached blobs, only generating chunks that don't exist yet.
    stop() {
        this.chunkAbort = true;
        this.clearTimers();
        // Wake up the zombie consumer's `await finished` promise so it exits.
        const resolve = this.finishResolve;
        this.finishResolve = null;
        if (this.audio) {
            this.audio.onended = null;
            this.audio.onerror = null;
            this.audio.pause();
            this.audio = null;
        }
        if (resolve) resolve();
        this.queue = [];
        this.pauseFlag = false;
        this.setPlaying(false);
        this.setLoading(false);
        this.cb.setPaused(false);
        this.cb.setFinished(false);
        this.cb.setActiveSentenceIdx(-1);
        this.cb.setActiveWordIdx(-1);
    }

    // Full wipe — only called by the trash button on the TTS panel.
    wipe() {
        this.stop();
        for (const [, c] of this.cache) URL.revokeObjectURL(c.url);
        this.cache.clear();
        this.cb.setGeneratedChunks(0);
        this.cb.setTotalChunks(0);
        this.cb.setHasCache(false);
    }

    // Pause / resume the current audio.
    pauseResume() {
        if (!this.audio) return;
        if (this.pauseFlag) {
            this.pauseFlag = false;
            this.cb.setPaused(false);
            this.audio.play().catch(() => {});
        } else {
            this.pauseFlag = true;
            this.cb.setPaused(true);
            this.audio.pause();
        }
    }

    changeSpeed(delta: number) {
        const newRate = Math.min(2, Math.max(0.5, Math.round((this.rate + delta) * 10) / 10));
        this.rate = newRate;
        this.cb.setPlaybackRate(newRate);
        if (this.audio) this.audio.playbackRate = newRate;
    }

    async speak(markdownContent: string, voice: string) {
        // If currently playing or loading, stop (keep cache).
        if (this.playing || this.loading) {
            this.stop();
            return;
        }
        const clean = proseForTTS(markdownContent);
        if (!clean) return;
        const chunks = chunkSentencesForTTS(clean);
        if (!chunks.length) return;

        // Soft reset — keep cache.
        this.chunkAbort = true;
        this.clearTimers();
        if (this.audio) {
            this.audio.pause();
            this.audio = null;
        }
        this.queue = [];
        this.skipToChunk = null;
        this.pauseFlag = false;
        this.chunkAbort = false;
        this.cb.setTotalChunks(chunks.length);
        this.cb.setPaused(false);
        this.cb.setFinished(false);
        this.cb.setActiveSentenceIdx(-1);
        this.cb.setActiveWordIdx(-1);

        // If a start-from-chunk was requested (clicking a sentence while stopped),
        // seed the queue from cache at that index and set currentIdx.
        const startAt = this.initialSkip;
        this.initialSkip = null;

        const chunkWords = chunks.map(splitWords);

        let producerDone = false;

        // ── Producer: load cached blobs instantly, generate missing chunks.
        const produce = async () => {
            for (let i = 0; i < chunks.length; i++) {
                if (this.chunkAbort) return;
                const cached = this.cache.get(i);
                if (cached) {
                    this.queue.push({ idx: i, ...cached });
                    this.cb.setGeneratedChunks(i + 1);
                    continue;
                }
                try {
                    const blob = await generateTts(chunks[i], voice);
                    if (this.chunkAbort) return;
                    const entry = { blob, url: URL.createObjectURL(blob), words: chunkWords[i] };
                    this.cache.set(i, entry);
                    this.queue.push({ idx: i, ...entry });
                    this.cb.setGeneratedChunks(i + 1);
                    this.cb.setHasCache(true);
                } catch {
                    producerDone = true;
                    return;
                }
            }
            producerDone = true;
        };

        // If everything is cached, skip the loading spinner.
        const allCached = this.cache.size >= chunks.length;
        if (allCached) {
            this.cb.setGeneratedChunks(chunks.length);
            this.setPlaying(true);
        } else {
            this.setLoading(true);
        }

        produce();

        // Wait for the first chunk if not fully cached.
        if (!allCached) {
            while (!this.chunkAbort && this.queue.length === 0 && !producerDone) {
                await new Promise(r => setTimeout(r, 50));
            }
            if (this.chunkAbort) return;
            this.setLoading(false);
            this.setPlaying(true);
        }

        // ── Consumer — plays chunks in order, respects skip + pause.
        let currentIdx = startAt ?? 0;
        // If starting from a specific chunk, seed the queue from cache.
        if (startAt !== null && startAt > 0) {
            for (let ci = startAt; ci < chunks.length; ci++) {
                const cached = this.cache.get(ci);
                if (cached) this.queue.push({ idx: ci, ...cached });
            }
        }
        while (!this.chunkAbort) {
            // Check for a chunk-skip request (click a sentence).
            if (this.skipToChunk !== null) {
                const target = this.skipToChunk;
                this.skipToChunk = null;
                this.clearTimers();
                // Rebuild the queue from cache starting at the target chunk.
                // If the target isn't cached yet, the producer will generate it.
                this.queue = [];
                for (let ci = target; ci < chunks.length; ci++) {
                    const cached = this.cache.get(ci);
                    if (cached) {
                        this.queue.push({ idx: ci, ...cached });
                    }
                }
                currentIdx = target;
                // If the target chunk isn't generated yet, wait for the producer.
                while (!this.chunkAbort && this.queue.length === 0 && !producerDone) {
                    await new Promise(r => setTimeout(r, 50));
                }
                if (this.chunkAbort) return;
                if (this.queue.length === 0 && producerDone) break;
            }

            if (this.queue.length === 0) {
                if (producerDone) break;
                await new Promise(r => setTimeout(r, 50));
                continue;
            }

            // Find the chunk matching currentIdx.
            let item = this.queue.shift();
            while (item && item.idx < currentIdx) {
                item = this.queue.shift();
            }
            if (!item) continue;
            if (item.idx > currentIdx) {
                this.queue.unshift(item);
                currentIdx = item.idx;
            }

            const audio = new Audio(item.url);
            this.audio = audio;
            audio.playbackRate = this.rate;
            this.cb.setActiveSentenceIdx(item.idx);
            this.cb.setActiveWordIdx(0);

            // Word highlight schedule.
            const scheduleWords = () => {
                this.clearTimers();
                const dur = audio.duration && isFinite(audio.duration) ? audio.duration : (item!.words.length / WORDS_PER_SEC);
                const perWord = dur / Math.max(item!.words.length, 1);
                item!.words.forEach((_w, wi) => {
                    const t = setTimeout(() => {
                        if (!this.chunkAbort && this.skipToChunk === null) this.cb.setActiveWordIdx(wi);
                    }, wi * perWord * 1000);
                    this.wordTimers.push(t);
                });
            };
            audio.onloadedmetadata = () => {
                if (this.chunkAbort) return;
                scheduleWords();
            };

            const finished = new Promise<void>(resolve => {
                this.finishResolve = resolve;
                audio.onended = () => { this.finishResolve = null; resolve(); };
                audio.onerror = () => { this.finishResolve = null; resolve(); };
            });

            // Signal promise — resolves when a skip or stop is requested during playback.
            // This lets us race `finished` against user intervention instead of blocking.
            const interrupted = new Promise<boolean>(resolve => {
                const checker = setInterval(() => {
                    if (this.chunkAbort || this.skipToChunk !== null) {
                        clearInterval(checker);
                        resolve(true);
                    }
                }, 50);
                // Clean up the checker if finished wins the race.
                finished.then(() => clearInterval(checker));
            });

            try {
                await audio.play();
            } catch {
                this.stop();
                return;
            }

            const wasInterrupted = await Promise.race([finished.then(() => false), interrupted]);
            // Clean up audio whether we finished naturally or were interrupted.
            if (this.audio) {
                this.audio.onended = null;
                this.audio.onerror = null;
                this.audio.pause();
            }
            this.audio = null;
            this.finishResolve = null;
            if (this.chunkAbort) return;
            if (wasInterrupted) {
                // A skip was requested — loop back to the top to process it.
                continue;
            }

            currentIdx = item.idx + 1;
        }

        // Finished all chunks — keep the panel visible for replay.
        if (!this.chunkAbort) {
            this.setPlaying(false);
            this.cb.setFinished(true);
            this.cb.setActiveSentenceIdx(-1);
            this.cb.setActiveWordIdx(-1);
        }
    }

    // ── Preload disk-cached chunks ──
    // If this GM message was read before (audio generated + saved to disk by the
    // server), load all cached chunks into the cache so the speaker button works
    // instantly with no Kokoro calls. This survives server restarts + campaign switches.
    // Returns a cancel function for the caller's effect cleanup.
    preloadFromDisk(markdownContent: string, voice: string): () => void {
        let cancelled = false;
        const clean = proseForTTS(markdownContent);
        if (!clean) return () => { cancelled = true; };
        const chunks = chunkSentencesForTTS(clean);
        if (!chunks.length) return () => { cancelled = true; };

        (async () => {
            try {
                const cachedFlags = await checkCachedChunks(chunks, voice);
                if (cancelled) return;
                const cachedCount = cachedFlags.filter(Boolean).length;
                if (cachedCount === 0) return;

                // Load all cached WAVs from disk in parallel.
                const loadPromises = chunks.map(async (text, i) => {
                    if (!cachedFlags[i]) return null;
                    const blob = await loadCachedTts(text, voice);
                    if (!blob || cancelled) return null;
                    return { idx: i, blob };
                });
                const results = await Promise.all(loadPromises);
                if (cancelled) return;

                let loaded = 0;
                for (const r of results) {
                    if (!r) continue;
                    const words = splitWords(chunks[r.idx]);
                    const url = URL.createObjectURL(r.blob);
                    this.cache.set(r.idx, { blob: r.blob, url, words });
                    loaded++;
                }
                if (loaded > 0 && !cancelled) {
                    this.cb.setHasCache(true);
                    this.cb.setTotalChunks(chunks.length);
                    this.cb.setGeneratedChunks(loaded);
                }
            } catch {
                // best-effort — if the server is down or TTS isn't ready, silently skip.
            }
        })();

        return () => { cancelled = true; };
    }

    // Unmount cleanup — abort everything and release every object URL.
    destroy() {
        this.chunkAbort = true;
        this.clearTimers();
        if (this.audio) this.audio.pause();
        for (const item of this.queue) URL.revokeObjectURL(item.url);
        for (const [, c] of this.cache) URL.revokeObjectURL(c.url);
        this.cache.clear();
    }
}
