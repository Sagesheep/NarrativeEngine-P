import { Router } from 'express';
import { wrapAsync } from '../lib/asyncHandler.js';
import { initTts, generateSpeech, isTtsReady, getTtsStatus, listVoices, isAudioCached, loadCachedAudio } from '../lib/tts.js';

export function createTtsRouter() {
    const router = Router();

    // Status — polled by the client to drive the speaker button + Advanced tab.
    router.get('/api/tts/status', wrapAsync((_req, res) => {
        res.json(getTtsStatus());
    }));

    // Trigger model download + warmup. Returns once ready. Long-running; the
    // client polls /status while waiting.
    router.post('/api/tts/init', wrapAsync(async (_req, res) => {
        await initTts();
        res.json({ ok: true, ...getTtsStatus() });
    }));

    // List voices. Only meaningful after init.
    router.get('/api/tts/voices', wrapAsync((_req, res) => {
        res.json({ voices: listVoices() });
    }));

    // Batch check: which chunks are already cached on disk?
    // POST body: { chunks: [{ text, voice? }, ...] } -> { cached: boolean[] }
    router.post('/api/tts/check-cache', wrapAsync((req, res) => {
        const { chunks, voice } = req.body || {};
        if (!Array.isArray(chunks)) {
            return res.status(400).json({ error: 'Missing chunks array' });
        }
        const cached = chunks.map(c => isAudioCached(c.text, c.voice || voice));
        return res.json({ cached });
    }));

    // Load a cached WAV from disk without generating. GET /api/tts/cached?text=...&voice=...
    router.get('/api/tts/cached', wrapAsync((req, res) => {
        const text = req.query.text;
        const voice = req.query.voice;
        if (typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ error: 'Missing text' });
        }
        const buf = loadCachedAudio(text, voice);
        if (!buf) {
            return res.status(404).json({ error: 'Not cached' });
        }
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Length', String(buf.length));
        return res.send(buf);
    }));

    // Generate speech. Expects { text, voice? } in JSON body. Returns audio/wav.
    router.post('/api/tts/generate', wrapAsync(async (req, res) => {
        const { text, voice } = req.body || {};
        if (typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ error: 'Missing text' });
        }
        if (!isTtsReady()) {
            return res.status(503).json({ error: 'TTS model not ready. Download it first from Settings → Advanced.' });
        }
        const buf = await generateSpeech(text, voice);
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Length', String(buf.length));
        return res.send(buf);
    }));

    return router;
}