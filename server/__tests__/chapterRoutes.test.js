import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The chapters router pulls in archiveService (for refit), which reaches the
// embedder and vector store at import time. Mock both so no model loads.
const embedderMock = () => ({
    embedText: vi.fn(async () => new Float32Array(32)),
    buildArchiveText: vi.fn((entry) => `MOCK ${entry.sceneId}`),
    buildLoreText: vi.fn(() => 'MOCK_LORE'),
    warmup: vi.fn(async () => {}),
    embedBatch: vi.fn(async () => []),
    getActiveDims: vi.fn(() => 32),
    getActiveModelId: vi.fn(() => 'mock'),
    isModelReady: vi.fn(() => true),
    EMBEDDING_VERSION: 1,
});
const vectorStoreMock = () => ({
    storeArchiveEmbedding: vi.fn(),
    storeLoreEmbedding: vi.fn(),
    searchArchive: vi.fn(async () => []),
    searchLore: vi.fn(async () => []),
    getEmbeddingStatus: vi.fn(() => ({ status: 'mock', loaded: true })),
    EMBEDDING_VERSION: 1,
    getDb: vi.fn(() => null),
    deleteArchiveEmbedding: vi.fn(),
    deleteAllArchiveEmbeddings: vi.fn(),
});

// `vi.mock` is hoisted above the consts above, so these factories are inline.
// The `vi.doMock` calls in beforeEach (not hoisted) reuse the helpers.
vi.mock('../lib/embedder.js', () => ({
    embedText: vi.fn(async () => new Float32Array(32)),
    buildArchiveText: vi.fn((entry) => `MOCK ${entry.sceneId}`),
    buildLoreText: vi.fn(() => 'MOCK_LORE'),
    warmup: vi.fn(async () => {}),
    embedBatch: vi.fn(async () => []),
    getActiveDims: vi.fn(() => 32),
    getActiveModelId: vi.fn(() => 'mock'),
    isModelReady: vi.fn(() => true),
    EMBEDDING_VERSION: 1,
}));
vi.mock('../lib/vectorStore.js', () => ({
    storeArchiveEmbedding: vi.fn(),
    storeLoreEmbedding: vi.fn(),
    searchArchive: vi.fn(async () => []),
    searchLore: vi.fn(async () => []),
    getEmbeddingStatus: vi.fn(() => ({ status: 'mock', loaded: true })),
    EMBEDDING_VERSION: 1,
    getDb: vi.fn(() => null),
    deleteArchiveEmbedding: vi.fn(),
    deleteAllArchiveEmbeddings: vi.fn(),
}));

let tmpDir;
let CAMPAIGNS_DIR;
let request;

const ID = 'camp-chapters';
const pad = (n) => String(n).padStart(3, '0');

beforeEach(async () => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chapter-routes-'));
    process.env.DATA_DIR = tmpDir;

    vi.doMock('../lib/embedder.js', embedderMock);
    vi.doMock('../lib/vectorStore.js', vectorStoreMock);

    const store = await import('../lib/fileStore.js');
    CAMPAIGNS_DIR = store.CAMPAIGNS_DIR;
    fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });

    const { createChaptersRouter } = await import('../routes/chapters.js');
    const express = (await import('express')).default;
    const { serverError } = await import('../lib/serverError.js');
    const supertest = (await import('supertest')).default;

    const app = express();
    app.use(express.json());
    app.use('/', createChaptersRouter());
    app.use((err, _req, res, _next) => serverError(res, err, 'ChapterRoutesTest'));
    request = supertest(app);
});

afterEach(() => {
    vi.doUnmock('../lib/embedder.js');
    vi.doUnmock('../lib/vectorStore.js');
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write `count` scenes into the index (and matching prose) starting at 1, skipping `skip`. */
function seedScenes(count, skip = []) {
    const nums = [];
    for (let n = 1; n <= count; n++) {
        if (!skip.includes(n)) nums.push(n);
    }
    const index = nums.map(n => ({
        sceneId: pad(n), timestamp: Date.now(), keywords: [], npcsMentioned: [],
        witnesses: [], npcStrengths: {}, importance: 3, userSnippet: `scene ${n}`,
    }));
    fs.writeFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.index.json`), JSON.stringify(index));
    const md = nums.map(n => `## SCENE ${pad(n)}\n\n**[USER]**\nu\n\n**[GM]**\ng\n\n---\n`).join('\n');
    fs.writeFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.md`), md);
    return nums;
}

function seedChapters(chapters) {
    fs.writeFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.chapters.json`), JSON.stringify(chapters));
}

function readChaptersFile() {
    return JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.chapters.json`), 'utf-8'));
}

const chapter = (id, start, end, extra = {}) => ({
    chapterId: id,
    title: `Chapter ${id}`,
    sceneRange: [pad(start), pad(end)],
    sceneIds: [],
    summary: '',
    keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], tone: '', themes: [],
    sceneCount: end - start + 1,
    ...extra,
});

describe('GET chapters — hydration', () => {
    it('reports the scenes that actually exist, not the stored counter', async () => {
        seedScenes(25, [10, 20]); // 23 real scenes
        seedChapters([chapter('CH01', 1, 25)]); // claims 25

        const res = await request.get(`/api/campaigns/${ID}/archive/chapters`);
        expect(res.status).toBe(200);
        expect(res.body[0].sceneCount).toBe(23);
        // The correction is persisted, so every later reader agrees.
        expect(readChaptersFile()[0].sceneCount).toBe(23);
    });

    it('leaves the range alone while correcting the count', async () => {
        seedScenes(25, [10]);
        seedChapters([chapter('CH01', 1, 25)]);
        const res = await request.get(`/api/campaigns/${ID}/archive/chapters`);
        expect(res.body[0].sceneRange).toEqual(['001', '025']);
    });
});

describe('POST chapters — id assignment', () => {
    it('does not reuse an id after a chapter is removed', async () => {
        seedScenes(50);
        seedChapters([chapter('CH01', 1, 25, { sealedAt: 1 }), chapter('CH03', 26, 50, { sealedAt: 2 })]);

        const res = await request.post(`/api/campaigns/${ID}/archive/chapters`).send({});
        expect(res.status).toBe(200);
        expect(res.body.chapterId).toBe('CH04');
        expect(res.body.title).toBe('Chapter 4');
    });

    it('does not collide after a merge shortened the list', async () => {
        seedScenes(75);
        seedChapters([
            chapter('CH01', 1, 25, { sealedAt: 1 }),
            chapter('CH02', 26, 50, { sealedAt: 2 }),
            chapter('CH03', 51, 75, { sealedAt: 3 }),
        ]);
        await request.post(`/api/campaigns/${ID}/archive/chapters/merge`)
            .send({ chapterIdA: 'CH01', chapterIdB: 'CH02' });

        const res = await request.post(`/api/campaigns/${ID}/archive/chapters`).send({});
        // Two chapters remain, so the old `length + 1` produced CH03 — which exists.
        expect(res.body.chapterId).toBe('CH04');
        const ids = readChaptersFile().map(c => c.chapterId);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('serializes concurrent creates instead of losing one', async () => {
        seedScenes(25);
        seedChapters([chapter('CH01', 1, 25, { sealedAt: 1 })]);

        // The double-click: two creates dispatched without awaiting the first.
        const [a, b] = await Promise.all([
            request.post(`/api/campaigns/${ID}/archive/chapters`).send({}),
            request.post(`/api/campaigns/${ID}/archive/chapters`).send({}),
        ]);

        const ids = readChaptersFile().map(c => c.chapterId);
        expect(ids).toHaveLength(3);
        expect(new Set(ids).size).toBe(3);
        expect(a.body.chapterId).not.toBe(b.body.chapterId);
    });
});

describe('DELETE chapter', () => {
    it('removes an empty chapter', async () => {
        seedScenes(25);
        seedChapters([chapter('CH01', 1, 25, { sealedAt: 1 }), chapter('CH02', 26, 26, { sceneCount: 0 })]);

        const res = await request.delete(`/api/campaigns/${ID}/archive/chapters/CH02`);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(readChaptersFile().map(c => c.chapterId)).toEqual(['CH01']);
    });

    it('refuses a chapter that holds scenes', async () => {
        seedScenes(25);
        seedChapters([chapter('CH01', 1, 25, { sealedAt: 1 })]);

        const res = await request.delete(`/api/campaigns/${ID}/archive/chapters/CH01`);
        expect(res.status).toBe(409);
        expect(res.body.sceneCount).toBe(25);
        expect(readChaptersFile()).toHaveLength(1);
    });

    it('refuses a chapter that has a summary but no scenes', async () => {
        seedScenes(25);
        seedChapters([
            chapter('CH01', 1, 25, { sealedAt: 1 }),
            chapter('CH02', 26, 26, { sceneCount: 0, summary: 'They regrouped.' }),
        ]);
        const res = await request.delete(`/api/campaigns/${ID}/archive/chapters/CH02`);
        expect(res.status).toBe(409);
    });

    it('allows a chapter whose scenes were all deleted', async () => {
        // The stored counter says 25; the index says none of them exist.
        seedScenes(25, [...Array(25)].map((_, i) => i + 1));
        seedChapters([chapter('CH01', 1, 25)]);

        const res = await request.delete(`/api/campaigns/${ID}/archive/chapters/CH01`);
        expect(res.status).toBe(200);
        expect(readChaptersFile()).toHaveLength(0);
    });

    it('404s for an unknown chapter', async () => {
        seedScenes(5);
        seedChapters([chapter('CH01', 1, 5)]);
        const res = await request.delete(`/api/campaigns/${ID}/archive/chapters/CH99`);
        expect(res.status).toBe(404);
    });
});

describe('refit', () => {
    it('previews the cost without writing', async () => {
        seedScenes(75, [30, 40]); // 73 scenes
        const before = [
            chapter('CH01', 1, 25, { sealedAt: 1 }),
            chapter('CH02', 26, 50, { sealedAt: 2 }),
            chapter('CH03', 51, 75, { sealedAt: 3 }),
        ];
        seedChapters(before);

        const res = await request.get(`/api/campaigns/${ID}/archive/chapters/refit/preview`);
        expect(res.status).toBe(200);
        expect(res.body.wouldChange).toBe(true);
        expect(res.body.totalScenes).toBe(73);
        expect(res.body.changedCount).toBe(2); // CH01 untouched
        // Nothing written.
        expect(readChaptersFile()[1].sceneRange).toEqual(['026', '050']);
    });

    it('reflows 25 / 23 / 25 into 25 / 25 / 23 with the last reopened', async () => {
        seedScenes(75, [30, 40]);
        seedChapters([
            chapter('CH01', 1, 25, { sealedAt: 1 }),
            chapter('CH02', 26, 50, { sealedAt: 2, sceneCount: 23 }),
            chapter('CH03', 51, 75, { sealedAt: 3 }),
        ]);

        const res = await request.post(`/api/campaigns/${ID}/archive/chapters/refit`);
        expect(res.status).toBe(200);
        expect(res.body.changed).toBe(true);

        const after = readChaptersFile();
        expect(after.map(c => c.sceneCount)).toEqual([25, 25, 23]);
        expect(after[0].invalidated).toBeUndefined();
        expect(after[1].invalidated).toBe(true);
        expect(after[2].sealedAt).toBeUndefined();
        // Exactly one open chapter, so the append path is unambiguous.
        expect(after.filter(c => !c.sealedAt)).toHaveLength(1);
    });

    it('is a no-op on a campaign that is already correctly fitted', async () => {
        // Mirrors the steady state a long campaign reaches: full sealed
        // chapters plus an empty open one holding the next scene's slot.
        seedScenes(50);
        seedChapters([
            chapter('CH01', 1, 25, { sealedAt: 1 }),
            chapter('CH02', 26, 50, { sealedAt: 2 }),
            chapter('CH03', 51, 51, { sceneCount: 0 }),
        ]);
        const res = await request.post(`/api/campaigns/${ID}/archive/chapters/refit`);
        expect(res.body.changed).toBe(false);
        expect(res.body.changedCount).toBe(0);
        // The complete chapter is not reopened, and the placeholder survives.
        const after = readChaptersFile();
        expect(after).toHaveLength(3);
        expect(after[1].sealedAt).toBe(2);
    });

    it('repoints divergence entries whose scene changed chapter', async () => {
        seedScenes(75, [30, 40]);
        seedChapters([
            chapter('CH01', 1, 25, { sealedAt: 1 }),
            chapter('CH02', 26, 50, { sealedAt: 2 }),
            chapter('CH03', 51, 75, { sealedAt: 3 }),
        ]);
        // Scene 051 sits in CH03 today; after refit it belongs to CH02.
        fs.writeFileSync(
            path.join(CAMPAIGNS_DIR, `${ID}.divergence.json`),
            JSON.stringify({
                entries: [{ id: 'e1', sceneRef: '051', chapterId: 'CH03', text: 'a fact' }],
                chapterToggles: {}, categoryToggles: {}, version: 2,
            }),
        );

        const res = await request.post(`/api/campaigns/${ID}/archive/chapters/refit`);
        expect(res.body.divergenceRepointed).toBe(1);

        const reg = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, `${ID}.divergence.json`), 'utf-8'));
        expect(reg.entries[0].chapterId).toBe('CH02');
        expect(reg.entries[0].text).toBe('a fact');
    });

    it('does not touch chapters before the first change', async () => {
        seedScenes(75, [70]);
        seedChapters([
            chapter('CH01', 1, 25, { sealedAt: 1, summary: 'keep me' }),
            chapter('CH02', 26, 50, { sealedAt: 2, summary: 'keep me too' }),
            chapter('CH03', 51, 75, { sealedAt: 3, summary: 'stale' }),
        ]);

        await request.post(`/api/campaigns/${ID}/archive/chapters/refit`);
        const after = readChaptersFile();
        expect(after[0].summary).toBe('keep me');
        expect(after[0].invalidated).toBeUndefined();
        expect(after[1].summary).toBe('keep me too');
        expect(after[1].invalidated).toBeUndefined();
    });
});
