// POST /api/llm/proxy — only http(s) targets are relayed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { createLLMProxyRouter } from '../routes/llmProxy.js';

let request;
let fetchMock;

beforeEach(() => {
    fetchMock = vi.fn(async () => ({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const app = express();
    app.use(express.json());
    app.use(createLLMProxyRouter());
    request = supertest(app);
});

afterEach(() => vi.unstubAllGlobals());

describe('proxy target validation', () => {
    it('relays an https provider URL', async () => {
        const res = await request.post('/api/llm/proxy').send({
            target: 'https://api.example.test/v1/chat/completions', method: 'POST', headers: {}, body: '{}',
        });
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.test/v1/chat/completions');
    });
    it('relays a plain-http local provider URL (Ollama, ComfyUI)', async () => {
        const res = await request.post('/api/llm/proxy').send({ target: 'http://localhost:11434/api/tags', method: 'GET' });
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('refuses non-http schemes without fetching', async () => {
        for (const target of ['file:///C:/Windows/win.ini', 'data:text/plain,hi', 'ftp://x.test/y']) {
            const res = await request.post('/api/llm/proxy').send({ target });
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/http\(s\)/);
        }
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('refuses a target that is not a URL', async () => {
        const res = await request.post('/api/llm/proxy').send({ target: '/v1/models' });
        expect(res.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('still requires a target', async () => {
        const res = await request.post('/api/llm/proxy').send({});
        expect(res.status).toBe(400);
    });
});
