import { Router } from 'express';
import { Readable } from 'stream';
import { wrapAsync } from '../lib/asyncHandler.js';

export function createLLMProxyRouter() {
    const router = Router();

    // Transparent relay so the browser never calls AI providers directly.
    // Fixes CORS for providers (e.g. NVIDIA) that don't send Access-Control-Allow-Origin.
    // The client builds the real target/headers/body; we forward and stream the reply back.
    router.post('/api/llm/proxy', wrapAsync(async (req, res) => {
        const { target, method = 'POST', headers = {}, body } = req.body || {};
        if (!target || typeof target !== 'string') {
            res.status(400).json({ error: 'Missing proxy target' });
            return;
        }
        // A provider endpoint is always an http(s) URL. Anything else (file:,
        // data:, blob:, a bare path) is not a provider and must not be fetched
        // on the caller's behalf.
        let targetUrl;
        try {
            targetUrl = new URL(target);
        } catch {
            res.status(400).json({ error: 'Invalid proxy target' });
            return;
        }
        if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
            res.status(400).json({ error: 'Proxy target must be an http(s) URL' });
            return;
        }

        const controller = new AbortController();
        // Browser aborted the turn → tear down the upstream request too.
        // NOTE: listen on `res`, not `req`. express.json() fully consumes the request
        // body before this handler runs, so `req`'s 'close' fires immediately and would
        // abort every request. `res` 'close' only fires on a real client disconnect;
        // the writableEnded guard ignores our own normal completion.
        res.on('close', () => {
            if (!res.writableEnded) controller.abort();
        });

        let upstream;
        try {
            upstream = await fetch(target, {
                method,
                headers,
                body: method === 'GET' || method === 'HEAD' ? undefined : body,
                signal: controller.signal,
            });
        } catch (err) {
            if (controller.signal.aborted) return; // client went away; nothing to send
            res.status(502).json({ error: `Upstream fetch failed: ${err.message}` });
            return;
        }

        // Mirror status + content-type, then pipe the body straight through.
        // No buffering → streaming UX (SSE) is preserved.
        res.status(upstream.status);
        const ct = upstream.headers.get('content-type');
        if (ct) res.setHeader('Content-Type', ct);

        if (upstream.body) {
            Readable.fromWeb(upstream.body)
                .on('error', (err) => {
                    // AbortError is expected when the client disconnects mid-stream
                    // (stop/regenerate/close). Without this handler, the error becomes
                    // an uncaught exception that crashes the entire Express backend,
                    // causing 502s on every route until the server is restarted.
                    if (err.name !== 'AbortError') {
                        console.error('[LLM Proxy] Stream error:', err.message);
                    }
                })
                .pipe(res);
        } else {
            res.end();
        }
    }));

    return router;
}