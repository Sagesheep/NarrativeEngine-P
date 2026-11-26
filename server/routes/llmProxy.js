import { Router } from 'express';
import { Readable } from 'stream';
import { Agent, fetch as undiciFetch } from 'undici';
import { wrapAsync } from '../lib/asyncHandler.js';

/**
 * Upper bound on how long the proxy waits on a provider — for the first byte
 * of the response, and between chunks of a streamed one.
 *
 * Node's built-in `fetch` gives up after five minutes of either, measured at
 * 307 s against a provider that never answers. That silently overrode the
 * app's own story timeout, which defaults to ten minutes and can be set to
 * an hour: a slow local model still processing a long prompt was cut off at
 * five minutes with "fetch failed", whatever the user had configured.
 *
 * The client owns the real deadline. When it gives up it aborts, the
 * connection closes, and the `res` 'close' handler below tears the upstream
 * request down. This ceiling only has to stay above the longest deadline the
 * client can set, `MAX_STORY_TIMEOUT_SECONDS` in `src/services/llm/timeouts.ts`
 * (one hour), so the proxy is never the one that ends a request early. It
 * still bounds a request whose client never times out.
 */
export const UPSTREAM_TIMEOUT_MS = 65 * 60 * 1000;

/**
 * @param {{ upstreamTimeoutMs?: number, fetchImpl?: typeof undiciFetch }} [options]
 *   Tests shorten the ceiling or inject a fetch; production uses the defaults.
 */
export function createLLMProxyRouter({ upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS, fetchImpl = undiciFetch } = {}) {
    const router = Router();
    // undici's own fetch with undici's own dispatcher. Handing an installed
    // Agent to Node's built-in fetch is fragile across versions.
    const dispatcher = new Agent({
        headersTimeout: upstreamTimeoutMs,
        bodyTimeout: upstreamTimeoutMs,
    });

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
            upstream = await fetchImpl(target, {
                method,
                headers,
                body: method === 'GET' || method === 'HEAD' ? undefined : body,
                signal: controller.signal,
                dispatcher,
            });
        } catch (err) {
            if (controller.signal.aborted) return; // client went away; nothing to send
            // Name the timeout: the bare message is only "fetch failed".
            const code = err?.cause?.code;
            if (code === 'UND_ERR_HEADERS_TIMEOUT') {
                res.status(504).json({ error: 'Upstream provider did not respond before the proxy timeout' });
                return;
            }
            res.status(502).json({ error: `Upstream fetch failed: ${err.message}${code ? ` (${code})` : ''}` });
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