import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock the embedder so the semantic-candidates route doesn't load the
// transformers model. embedText returns a fixed-length vector so the search
// path executes against the mocked searchArchive.
const embedTextMock = vi.fn(async () => new Float32Array(32));
vi.mock('../lib/embedder.js', () => ({
    embedText: embedTextMock,
    embedQuery: embedTextMock,
    buildScenePassages: vi.fn(() => ['MOCK passage']),
    buildLoreText: vi.fn(() => 'MOCK_LORE'),
    warmup: vi.fn(async () => {}),
    embedBatch: vi.fn(async () => []),
    getActiveDims: vi.fn(() => 32),
    getActiveModelId: vi.fn(() => 'mock'),
    isModelReady: vi.fn(() => true),
    EMBEDDING_VERSIONS: { scene: 2, lore: 1, rule: 1 },
}));

// Mock the vector store so DB init isn't required. The searchArchive mock
// records its `opts` argument so the test can assert scopeIds forwarding.
const searchArchiveMock = vi.fn(() => []);
vi.mock('../lib/vectorStore.js', () => ({
    storeArchiveEmbedding: vi.fn(),
    storeLoreEmbedding: vi.fn(),
    searchArchive: searchArchiveMock,
    searchLore: vi.fn(() => []),
    getEmbeddingStatus: vi.fn(() => ({ status: 'mock', loaded: true })),
    EMBEDDING_VERSIONS: { scene: 2, lore: 1, rule: 1 },
    getDb: vi.fn(() => null),
    deleteArchiveEmbedding: vi.fn(),
}));

let tmpDir;
let createArchiveRouter;
let request;

beforeEach(async () => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-scoped-'));
    process.env.DATA_DIR = tmpDir;

    vi.doMock('../lib/embedder.js', () => ({
        embedText: embedTextMock,
    embedQuery: embedTextMock,
        buildScenePassages: vi.fn(() => ['MOCK passage']),
        buildLoreText: vi.fn(() => 'MOCK_LORE'),
        warmup: vi.fn(async () => {}),
        embedBatch: vi.fn(async () => []),
        getActiveDims: vi.fn(() => 32),
        getActiveModelId: vi.fn(() => 'mock'),
        isModelReady: vi.fn(() => true),
        EMBEDDING_VERSIONS: { scene: 2, lore: 1, rule: 1 },
    }));
    vi.doMock('../lib/vectorStore.js', () => ({
        storeArchiveEmbedding: vi.fn(),
        storeLoreEmbedding: vi.fn(),
        searchArchive: searchArchiveMock,
        searchLore: vi.fn(() => []),
        getEmbeddingStatus: vi.fn(() => ({ status: 'mock', loaded: true })),
        EMBEDDING_VERSIONS: { scene: 2, lore: 1, rule: 1 },
        getDb: vi.fn(() => null),
        deleteArchiveEmbedding: vi.fn(),
    }));

    const store = await import('../lib/fileStore.js');
    fs.mkdirSync(store.CAMPAIGNS_DIR, { recursive: true });

    const mod = await import('../routes/archive.js');
    createArchiveRouter = mod.createArchiveRouter;

    const express = (await import('express')).default;
    const { serverError } = await import('../lib/serverError.js');
    const supertest = (await import('supertest')).default;
    const app = express();
    app.use(express.json());
    app.use('/', createArchiveRouter());
    app.use((err, _req, res, _next) => serverError(res, err, 'ArchiveScopedTest'));
    request = supertest(app);

    searchArchiveMock.mockClear();
    embedTextMock.mockClear();
});

afterEach(() => {
    vi.doUnmock('../lib/embedder.js');
    vi.doUnmock('../lib/vectorStore.js');
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ID = 'camp-scoped-test';

describe('POST /api/campaigns/:id/archive/semantic-candidates — scopeSceneIds (WO-10)', () => {
    it('forwards scopeSceneIds to searchArchive as opts.scopeIds', async () => {
        // The mock returns [] by default; we only care about the args here.
        await request
            .post(`/api/campaigns/${ID}/archive/semantic-candidates`)
            .send({ query: 'thief in the night', scopeSceneIds: ['001', '005', '010'] });

        expect(searchArchiveMock).toHaveBeenCalledTimes(1);
        const args = searchArchiveMock.mock.calls[0];
        // signature: (campaignId, queryEmbedding, limit, diversity, opts)
        expect(args[0]).toBe(ID);
        expect(args[2]).toBe(20); // default limit
        expect(args[3]).toBe(true); // default diversity
        expect(args[4]).toEqual({ scopeIds: ['001', '005', '010'] });
    });

    it('omits opts.scopeIds when scopeSceneIds is absent (existing callers unaffected)', async () => {
        await request
            .post(`/api/campaigns/${ID}/archive/semantic-candidates`)
            .send({ query: 'thief in the night' });

        expect(searchArchiveMock).toHaveBeenCalledTimes(1);
        const args = searchArchiveMock.mock.calls[0];
        // The route forwards req.body unchanged; the service forwards
        // scopeSceneIds: undefined → searchArchiveCandidates forwards
        // { scopeIds: undefined } → searchArchive receives opts.scopeIds: undefined.
        expect(args[4]).toEqual({ scopeIds: undefined });
    });

    it('treats an empty scopeSceneIds array as unscoped (additive no-op)', async () => {
        await request
            .post(`/api/campaigns/${ID}/archive/semantic-candidates`)
            .send({ query: 'thief in the night', scopeSceneIds: [] });

        expect(searchArchiveMock).toHaveBeenCalledTimes(1);
        const args = searchArchiveMock.mock.calls[0];
        // Empty array collapses to undefined at the route layer → unscoped.
        expect(args[4]).toEqual({ scopeIds: undefined });
    });

    it('drops non-string and empty entries from scopeSceneIds (tolerant filter)', async () => {
        await request
            .post(`/api/campaigns/${ID}/archive/semantic-candidates`)
            .send({ query: 'thief in the night', scopeSceneIds: ['001', '', 42, '005'] });

        expect(searchArchiveMock).toHaveBeenCalledTimes(1);
        const args = searchArchiveMock.mock.calls[0];
        expect(args[4]).toEqual({ scopeIds: ['001', '005'] });
    });

    it('rejects a non-array scopeSceneIds with 400', async () => {
        const res = await request
            .post(`/api/campaigns/${ID}/archive/semantic-candidates`)
            .send({ query: 'thief in the night', scopeSceneIds: '001' });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/array of strings/);
        expect(searchArchiveMock).not.toHaveBeenCalled();
    });

    it('rejects an over-cap scopeSceneIds array with 400', async () => {
        // WO-11b Correction 2: cap raised from 256 to 4096. 4097 is the new reject boundary.
        const tooMany = Array.from({ length: 4097 }, (_, i) => String(i).padStart(4, '0'));
        const res = await request
            .post(`/api/campaigns/${ID}/archive/semantic-candidates`)
            .send({ query: 'thief in the night', scopeSceneIds: tooMany });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/length cap/);
        expect(searchArchiveMock).not.toHaveBeenCalled();
    });

    it('accepts a 4096-entry scopeSceneIds array (at the cap)', async () => {
        // WO-11b Correction 2: cap raised from 256 to 4096. This exercises the new
        // boundary so a future regression to a lower cap trips this test.
        const atCap = Array.from({ length: 4096 }, (_, i) => String(i).padStart(4, '0'));
        const res = await request
            .post(`/api/campaigns/${ID}/archive/semantic-candidates`)
            .send({ query: 'thief in the night', scopeSceneIds: atCap });

        expect(res.status).toBe(200);
        expect(searchArchiveMock).toHaveBeenCalledTimes(1);
        const args = searchArchiveMock.mock.calls[0];
        expect(args[4].scopeIds).toHaveLength(4096);
    });

    it('producer-side: computeSynopsisScope does not truncate a scope exceeding 256 IDs', async () => {
        // WO-11b Correction 2 producer-side regression. Build 100 synopsis-tier
        // chapters × 3 scenes each = 300 synopsis scene IDs (> 256). The old cap
        // would have rejected this scope at the route; the new 4096 cap accepts it.
        // This test exercises the producer (computeSynopsisScope) + the route cap
        // together so a future tightening of the cap is caught here, not silently
        // in production.
        const { computeSynopsisScope } = await import('../../src/services/archive-memory/dynamicElevation.ts');
        const chapters = Array.from({ length: 100 }, (_, i) => {
            const chId = `CH${String(i + 1).padStart(3, '0')}`;
            const start = String(i * 3 + 1).padStart(3, '0');
            const end = String(i * 3 + 3).padStart(3, '0');
            return {
                chapterId: chId,
                title: `Chapter ${chId}`,
                sceneRange: [start, end],
                sceneIds: [String(i * 3 + 1).padStart(3, '0'), String(i * 3 + 2).padStart(3, '0'), String(i * 3 + 3).padStart(3, '0')],
                summary: `Summary ${chId}.`,
                keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [],
                tone: '', themes: [], sceneCount: 3, sealedAt: 1,
            };
        });
        // All chapters synopsis-tier (summaryChapters = 0 forces synopsis for all).
        const archiveIndex = chapters.flatMap(c => c.sceneIds.map(sid => ({
            sceneId: sid, timestamp: 0, keywords: [], npcsMentioned: [], witnesses: [], userSnippet: '',
        })));
        const msgs = chapters.flatMap(c => c.sceneIds.map(sid => ({ id: `m_${sid}`, role: 'assistant', content: 'x', timestamp: 0, sceneId: sid })));

        const { scopeSceneIds } = computeSynopsisScope({
            chapters,
            archiveIndex,
            onStageNpcIds: ['npc_a'],
            condensedUpToIndex: msgs.length - 1,
            messages: msgs,
            config: { summaryChapters: 0, importanceBonus: 0 },
        });

        // 100 chapters × 3 scenes = 300 synopsis scene IDs — exceeds the old 256 cap.
        expect(scopeSceneIds).toHaveLength(300);

        // Forward the full scope through the route to confirm the new cap accepts it.
        const res = await request
            .post(`/api/campaigns/${ID}/archive/semantic-candidates`)
            .send({ query: 'remember the old days', scopeSceneIds: scopeSceneIds });

        expect(res.status).toBe(200);
        expect(searchArchiveMock).toHaveBeenCalledTimes(1);
        expect(searchArchiveMock.mock.calls[0][4].scopeIds).toHaveLength(300);
    });

    it('forwards scopeSceneIds through the multi-query path (queries array)', async () => {
        await request
            .post(`/api/campaigns/${ID}/archive/semantic-candidates`)
            .send({
                queries: ['thief in the night', 'guard patrol routes'],
                scopeSceneIds: ['001', '005'],
            });

        // searchArchive is called once per query (2 here).
        expect(searchArchiveMock).toHaveBeenCalledTimes(2);
        for (const call of searchArchiveMock.mock.calls) {
            expect(call[4]).toEqual({ scopeIds: ['001', '005'] });
        }
    });

    it('returns sceneIds from the search results', async () => {
        searchArchiveMock.mockReturnValue([
            { sceneId: '005', distance: 0.1 },
            { sceneId: '001', distance: 0.2 },
        ]);
        const res = await request
            .post(`/api/campaigns/${ID}/archive/semantic-candidates`)
            .send({ query: 'thief in the night', scopeSceneIds: ['001', '005'] });

        expect(res.status).toBe(200);
        expect(res.body.sceneIds).toEqual(['005', '001']);
    });
});