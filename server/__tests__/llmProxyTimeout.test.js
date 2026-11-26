// POST /api/llm/proxy — how long the proxy waits on a provider.
//
// Node's built-in fetch abandons a provider after five minutes without
// response headers (measured: 307 s, UND_ERR_HEADERS_TIMEOUT). That silently
// overrode the app's own story timeout, which defaults to ten minutes and can
// be set to an hour, so a slow local model mid-prompt was cut off early.
//
// These run the proxy's real fetch against a real local socket. They use a
// short ceiling so they finish quickly; that the option reaches the
// dispatcher is what makes the production ceiling the one that governs.
import http from 'http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { createLLMProxyRouter, UPSTREAM_TIMEOUT_MS } from '../routes/llmProxy.js';
import { MAX_STORY_TIMEOUT_SECONDS } from '../../src/services/llm/timeouts';

const NODE_FETCH_DEFAULT_HEADERS_TIMEOUT_MS = 300_000;

let provider;
let providerUrl;

beforeAll(async () => {
    // `/silent` accepts and never answers; `/slow` answers after 400 ms.
    provider = http.createServer((req, res) => {
        if (req.url === '/slow') {
            setTimeout(() => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{"ok":true}');
            }, 400);
        }
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    providerUrl = `http://127.0.0.1:${provider.address().port}`;
});

afterAll(async () => {
    provider.closeAllConnections?.();
    await new Promise((resolve) => provider.close(resolve));
});

function appWith(options) {
    const app = express();
    app.use(express.json());
    app.use(createLLMProxyRouter(options));
    return supertest(app);
}

describe('proxy upstream timeout', () => {
    it('waits longer than the longest story timeout a user can set', () => {
        expect(UPSTREAM_TIMEOUT_MS).toBeGreaterThan(MAX_STORY_TIMEOUT_SECONDS * 1000);
        expect(UPSTREAM_TIMEOUT_MS).toBeGreaterThan(NODE_FETCH_DEFAULT_HEADERS_TIMEOUT_MS);
    });

    it('lets a provider that is slow but within the ceiling answer', async () => {
        const res = await appWith({ upstreamTimeoutMs: 2000 })
            .post('/api/llm/proxy')
            .send({ target: `${providerUrl}/slow`, method: 'GET' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
    });

    it('gives up on a silent provider at the configured ceiling, and says so', async () => {
        const started = Date.now();
        const res = await appWith({ upstreamTimeoutMs: 300 })
            .post('/api/llm/proxy')
            .send({ target: `${providerUrl}/silent`, method: 'GET' });
        const elapsed = Date.now() - started;

        expect(res.status).toBe(504);
        expect(res.body.error).toMatch(/did not respond/);
        // Governed by the option, not by any hidden default.
        expect(elapsed).toBeGreaterThanOrEqual(250);
        expect(elapsed).toBeLessThan(5000);
    });
});
