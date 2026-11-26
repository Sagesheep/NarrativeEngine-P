import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock the embedder so the route's embedding step doesn't load the transformers model.
vi.mock('../lib/embedder.js', () => ({
    embedText: vi.fn(async () => new Float32Array(32)),
    embedQuery: vi.fn(async () => new Float32Array(32)),
    buildScenePassages: vi.fn(() => ['MOCK passage']),
    buildLoreText: vi.fn(() => 'MOCK_LORE'),
    warmup: vi.fn(async () => {}),
    embedBatch: vi.fn(async () => []),
    getActiveDims: vi.fn(() => 32),
    getActiveModelId: vi.fn(() => 'mock'),
    isModelReady: vi.fn(() => true),
    EMBEDDING_VERSIONS: { scene: 2, lore: 1, rule: 1 },
}));

// Mock the vector store so DB init isn't required.
const storeMock = vi.fn();
vi.mock('../lib/vectorStore.js', () => ({
    storeArchiveEmbedding: storeMock,
    storeLoreEmbedding: vi.fn(),
    searchArchive: vi.fn(async () => []),
    searchLore: vi.fn(async () => []),
    getEmbeddingStatus: vi.fn(() => ({ status: 'mock', loaded: true })),
    EMBEDDING_VERSIONS: { scene: 2, lore: 1, rule: 1 },
    getDb: vi.fn(() => null),
    deleteArchiveEmbedding: vi.fn(),
}));

let tmpDir;
let CAMPAIGNS_DIR;
let createArchiveRouter;
let request;

beforeEach(async () => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-append-'));
    process.env.DATA_DIR = tmpDir;

    vi.doMock('../lib/embedder.js', () => ({
        embedText: vi.fn(async () => new Float32Array(32)),
    embedQuery: vi.fn(async () => new Float32Array(32)),
        buildScenePassages: vi.fn(() => ['MOCK passage']),
        buildLoreText: vi.fn(() => 'MOCK_LORE'),
        warmup: vi.fn(async () => {}),
        embedBatch: vi.fn(async () => []),
        getActiveDims: vi.fn(() => 32),
        getActiveModelId: vi.fn(() => 'mock'),
        EMBEDDING_VERSIONS: { scene: 2, lore: 1, rule: 1 },
    }));
    vi.doMock('../lib/vectorStore.js', () => ({
        storeArchiveEmbedding: storeMock,
        storeLoreEmbedding: vi.fn(),
        searchArchive: vi.fn(async () => []),
        searchLore: vi.fn(async () => []),
        getEmbeddingStatus: vi.fn(() => ({ status: 'mock', loaded: true })),
        EMBEDDING_VERSIONS: { scene: 2, lore: 1, rule: 1 },
        getDb: vi.fn(() => null),
        deleteArchiveEmbedding: vi.fn(),
    }));

    const store = await import('../lib/fileStore.js');
    CAMPAIGNS_DIR = store.CAMPAIGNS_DIR;
    fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });

    const mod = await import('../routes/archive.js');
    createArchiveRouter = mod.createArchiveRouter;

    const express = (await import('express')).default;
    const { serverError } = await import('../lib/serverError.js');
    const supertest = (await import('supertest')).default;
    const app = express();
    app.use(express.json());
    app.use('/', createArchiveRouter());
    app.use((err, _req, res, _next) => serverError(res, err, 'ArchiveAppendTest'));
    request = supertest(app);
});

afterEach(() => {
    vi.doUnmock('../lib/embedder.js');
    vi.doUnmock('../lib/vectorStore.js');
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    storeMock.mockClear();
});

const ID = 'camp-append-test';

describe('POST /api/campaigns/:id/archive — fast/deferred split', () => {
    it('responds immediately with { ok, sceneNumber, sceneId }', async () => {
        const res = await request
            .post(`/api/campaigns/${ID}/archive`)
            .send({ userContent: 'I attack the goblin.', assistantContent: 'The goblin falls.' });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.sceneNumber).toBe(1);
        expect(res.body.sceneId).toBe('001');
    });

    it('writes prose to .archive.md before responding', async () => {
        await request
            .post(`/api/campaigns/${ID}/archive`)
            .send({ userContent: 'I enter the tavern.', assistantContent: 'The barkeep nods.' });

        const md = fs.readFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.md`), 'utf-8');
        expect(md).toContain('## SCENE 001');
        expect(md).toContain('I enter the tavern.');
        expect(md).toContain('The barkeep nods.');
    });

    it('writes index entry with heuristic witnesses before responding', async () => {
        const res = await request
            .post(`/api/campaigns/${ID}/archive`)
            .send({ userContent: 'I talk to [Aldric].', assistantContent: '[Aldric] waves.' });

        expect(res.status).toBe(200);
        const idx = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.index.json`), 'utf-8'));
        expect(idx).toHaveLength(1);
        expect(idx[0].sceneId).toBe('001');
        expect(Array.isArray(idx[0].witnesses)).toBe(true);
    });

    it('writes chapters before responding', async () => {
        await request
            .post(`/api/campaigns/${ID}/archive`)
            .send({ userContent: 'I explore.', assistantContent: 'You find a cave.' });

        const ch = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.chapters.json`), 'utf-8'));
        expect(ch.length).toBeGreaterThan(0);
        expect(ch[0].sceneCount).toBe(1);
    });

    it('rejects empty userContent with 400', async () => {
        const res = await request
            .post(`/api/campaigns/${ID}/archive`)
            .send({ userContent: '', assistantContent: 'x' });
        expect(res.status).toBe(400);
    });

    it('rejects missing assistantContent with 400', async () => {
        const res = await request
            .post(`/api/campaigns/${ID}/archive`)
            .send({ userContent: 'x' });
        expect(res.status).toBe(400);
    });

    it('does NOT call LLM when utilityConfig is absent (dormant path)', async () => {
        // Mock llmProxy so we can assert it's never called when utilityConfig is absent
        const witnessMock = vi.fn(async () => null);
        const timelineMock = vi.fn(async () => null);
        vi.doMock('../services/llmProxy.js', () => ({
            extractWitnessesLLM: witnessMock,
            extractTimelineEventsLLM: timelineMock,
        }));

        vi.resetModules();
        const store = await import('../lib/fileStore.js');
        CAMPAIGNS_DIR = store.CAMPAIGNS_DIR;
        fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });
        const mod = await import('../routes/archive.js');
        const express = (await import('express')).default;
        const { serverError } = await import('../lib/serverError.js');
        const supertest = (await import('supertest')).default;
        const app = express();
        app.use(express.json());
        app.use('/', mod.createArchiveRouter());
        app.use((err, _req, res, _next) => serverError(res, err, 'ArchiveDormantTest'));
        const req = supertest(app);

        const res = await req
            .post(`/api/campaigns/${ID}/archive`)
            .send({ userContent: 'I talk to [Aldric].', assistantContent: '[Aldric] nods.' });

        expect(res.status).toBe(200);
        // Allow a tick for any stray setImmediate
        await new Promise(r => setTimeout(r, 50));
        expect(witnessMock).not.toHaveBeenCalled();
        expect(timelineMock).not.toHaveBeenCalled();

        // Index should have heuristic witnesses (not LLM)
        const idx = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.index.json`), 'utf-8'));
        expect(idx[0].witnessSource).not.toBe('llm');
    });
});

describe('POST /api/campaigns/:id/archive — concurrency (per-campaign write lock)', () => {
    it('two concurrent appends both land in the index without lost updates', async () => {
        const [r1, r2] = await Promise.all([
            request.post(`/api/campaigns/${ID}/archive`).send({ userContent: 'First scene.', assistantContent: 'GM reply one.' }),
            request.post(`/api/campaigns/${ID}/archive`).send({ userContent: 'Second scene.', assistantContent: 'GM reply two.' }),
        ]);

        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);

        const idx = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.index.json`), 'utf-8'));
        expect(idx).toHaveLength(2);
        // Both scenes should have distinct sceneIds (001 and 002 in some order)
        const sceneIds = idx.map(e => e.sceneId).sort();
        expect(sceneIds).toEqual(['001', '002']);
    });

    it('three concurrent appends all land without lost updates', async () => {
        await Promise.all([
            request.post(`/api/campaigns/${ID}/archive`).send({ userContent: 'A', assistantContent: 'B' }),
            request.post(`/api/campaigns/${ID}/archive`).send({ userContent: 'C', assistantContent: 'D' }),
            request.post(`/api/campaigns/${ID}/archive`).send({ userContent: 'E', assistantContent: 'F' }),
        ]);

        const idx = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.index.json`), 'utf-8'));
        expect(idx).toHaveLength(3);
        const sceneIds = idx.map(e => e.sceneId).sort();
        expect(sceneIds).toEqual(['001', '002', '003']);
    });
});

describe('POST /api/campaigns/:id/archive — deferred LLM path', () => {
    it('patches witnesses via LLM when utilityConfig is provided (deferred)', async () => {
        // Mock llmProxy so the deferred path runs instantly
        vi.doMock('../services/llmProxy.js', () => ({
            extractWitnessesLLM: vi.fn(async () => ({ witnesses: ['Aldric'], mentioned: ['Aldric'] })),
            extractTimelineEventsLLM: vi.fn(async () => null),
        }));

        // Re-import the router with the mocked llmProxy
        vi.resetModules();
        const store = await import('../lib/fileStore.js');
        CAMPAIGNS_DIR = store.CAMPAIGNS_DIR;
        fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });
        const mod = await import('../routes/archive.js');
        const express = (await import('express')).default;
        const { serverError } = await import('../lib/serverError.js');
        const supertest = (await import('supertest')).default;
        const app = express();
        app.use(express.json());
        app.use('/', mod.createArchiveRouter());
        app.use((err, _req, res, _next) => serverError(res, err, 'ArchiveLLMTest'));
        const req = supertest(app);

        const res = await req
            .post(`/api/campaigns/${ID}/archive`)
            .send({
                userContent: 'I talk to [Aldric].',
                assistantContent: '[Aldric] waves at you.',
                utilityConfig: { endpoint: 'http://mock-llm', apiKey: 'k', modelName: 'mock' },
            });

        expect(res.status).toBe(200);
        // Wait for the setImmediate deferred task to complete
        await new Promise(r => setTimeout(r, 100));

        const idx = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.index.json`), 'utf-8'));
        expect(idx).toHaveLength(1);
        // The deferred LLM task should have patched the witnesses
        expect(idx[0].witnesses).toContain('Aldric');
        expect(idx[0].witnessSource).toBe('llm');
    });

    it('appends timeline events via LLM when utilityConfig is provided (deferred)', async () => {
        vi.doMock('../services/llmProxy.js', () => ({
            extractWitnessesLLM: vi.fn(async () => ({ witnesses: ['Aldric'], mentioned: ['Aldric'] })),
            extractTimelineEventsLLM: vi.fn(async () => [
                { subject: 'Aldric', predicate: 'met', object: 'PC', summary: 'Aldric met PC', importance: 3, sceneId: '001', chapterId: 'CH01', source: 'llm' },
            ]),
        }));

        vi.resetModules();
        const store = await import('../lib/fileStore.js');
        CAMPAIGNS_DIR = store.CAMPAIGNS_DIR;
        fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });
        const mod = await import('../routes/archive.js');
        const express = (await import('express')).default;
        const { serverError } = await import('../lib/serverError.js');
        const supertest = (await import('supertest')).default;
        const app = express();
        app.use(express.json());
        app.use('/', mod.createArchiveRouter());
        app.use((err, _req, res, _next) => serverError(res, err, 'ArchiveTimelineTest'));
        const req = supertest(app);

        await req
            .post(`/api/campaigns/${ID}/archive`)
            .send({
                userContent: 'I meet [Aldric].',
                assistantContent: '[Aldric] greets you warmly.',
                utilityConfig: { endpoint: 'http://mock-llm', apiKey: 'k', modelName: 'mock' },
            });

        // Wait for the deferred task
        await new Promise(r => setTimeout(r, 100));

        const tl = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, `${ID}.timeline.json`), 'utf-8'));
        expect(tl.length).toBeGreaterThan(0);
        expect(tl[0].subject).toBe('Aldric');
        expect(tl[0].id).toMatch(/^tl_\d{4}$/);
    });
});