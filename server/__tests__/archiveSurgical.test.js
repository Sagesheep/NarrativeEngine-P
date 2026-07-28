import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock the embedder so the edit-sync route's re-embed step doesn't load the
// transformers model (heavy, slow, network-dependent). The mock returns a
// fixed-length Float32Array so the storeArchiveEmbedding path executes.
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

// Mock the vector store so DB init isn't required. The mock records calls so
// assertions can verify deleteArchiveEmbedding ran for surgical delete.
const storeMock = vi.fn();
const deleteMock = vi.fn();
vi.mock('../lib/vectorStore.js', () => ({
    storeArchiveEmbedding: storeMock,
    storeLoreEmbedding: vi.fn(),
    searchArchive: vi.fn(async () => []),
    searchLore: vi.fn(async () => []),
    getEmbeddingStatus: vi.fn(() => ({ status: 'mock', loaded: true })),
    EMBEDDING_VERSION: 1,
    getDb: vi.fn(() => null),
    deleteArchiveEmbedding: deleteMock,
}));

let tmpDir;
let CAMPAIGNS_DIR;
let createArchiveRouter;
let request;

beforeEach(async () => {
    // Reset the module cache so fileStore re-evaluates with the new DATA_DIR.
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-surgical-'));
    process.env.DATA_DIR = tmpDir;

    // Re-mock after resetModules (vi.mock is hoisted but resetModules clears the registry).
    vi.doMock('../lib/embedder.js', () => ({
        embedText: vi.fn(async () => new Float32Array(32)),
        buildArchiveText: vi.fn((entry) => `MOCK ${entry.sceneId}`),
        buildLoreText: vi.fn(() => 'MOCK_LORE'),
        warmup: vi.fn(async () => {}),
        embedBatch: vi.fn(async () => []),
        getActiveDims: vi.fn(() => 32),
        getActiveModelId: vi.fn(() => 'mock'),
        EMBEDDING_VERSION: 1,
    }));
    vi.doMock('../lib/vectorStore.js', () => ({
        storeArchiveEmbedding: storeMock,
        storeLoreEmbedding: vi.fn(),
        searchArchive: vi.fn(async () => []),
        searchLore: vi.fn(async () => []),
        getEmbeddingStatus: vi.fn(() => ({ status: 'mock', loaded: true })),
        EMBEDDING_VERSION: 1,
        getDb: vi.fn(() => null),
        deleteArchiveEmbedding: deleteMock,
    }));

    // Dynamic imports pick up the temp DATA_DIR (fileStore derives CAMPAIGNS_DIR at module load).
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
    // Central error handler mirrors server.js — maps err.statusCode to the HTTP response.
    app.use((err, _req, res, _next) => serverError(res, err, 'ArchiveTest'));
    request = supertest(app);
});

afterEach(() => {
    vi.doUnmock('../lib/embedder.js');
    vi.doUnmock('../lib/vectorStore.js');
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    storeMock.mockClear();
    deleteMock.mockClear();
});

const ID = 'camp-test';

function seedArchive() {
    const md = [
        '## SCENE 001',
        `*${new Date(2025, 0, 1).toISOString()}*`,
        '',
        '**[USER]**',
        'I enter the tavern.',
        '',
        '**[GM]**',
        'The barkeep greets you.',
        '',
        '---',
        '',
        '## SCENE 002',
        `*${new Date(2025, 0, 2).toISOString()}*`,
        '',
        '**[USER]**',
        'I order ale.',
        '',
        '**[GM]**',
        'The barkeep pours ale.',
        '',
        '---',
        '',
    ].join('\n');
    fs.writeFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.md`), md);

    const index = [
        { sceneId: '001', timestamp: Date.now(), keywords: ['tavern'], npcsMentioned: [], witnesses: [], npcStrengths: {}, importance: 3, userSnippet: 'I enter the tavern.' },
        { sceneId: '002', timestamp: Date.now(), keywords: ['ale'], npcsMentioned: [], witnesses: [], npcStrengths: {}, importance: 2, userSnippet: 'I order ale.' },
    ];
    fs.writeFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.index.json`), JSON.stringify(index));

    const facts = [{ sceneId: '001', text: 'PC is in a tavern' }, { sceneId: '002', text: 'PC ordered ale' }];
    fs.writeFileSync(path.join(CAMPAIGNS_DIR, `${ID}.facts.json`), JSON.stringify(facts));

    const timeline = [{ sceneId: '001', event: 'arrived' }, { sceneId: '002', event: 'ordered' }];
    fs.writeFileSync(path.join(CAMPAIGNS_DIR, `${ID}.timeline.json`), JSON.stringify(timeline));

    const chapters = [{ id: 'ch1', title: 'Ch 1', sceneRange: ['001', '002'], sceneIds: ['001', '002'], sceneCount: 2, sealedAt: Date.now() }];
    fs.writeFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.chapters.json`), JSON.stringify(chapters));
}

describe('WO-F: surgical scene delete', () => {
    it('removes only the target scene from archive/index/facts/timeline and repairs its chapter', async () => {
        seedArchive();

        const res = await request.delete(`/api/campaigns/${ID}/archive/scenes/001`);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.sceneExisted).toBe(true);
        expect(res.body.chapterRepaired).toBe(true);

        // .archive.md: only scene 002 remains
        const md = fs.readFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.md`), 'utf-8');
        expect(md).not.toContain('## SCENE 001');
        expect(md).toContain('## SCENE 002');

        // index: 002 only
        const idx = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.index.json`), 'utf-8'));
        expect(idx).toHaveLength(1);
        expect(idx[0].sceneId).toBe('002');

        // facts/timeline: scene 001 facts/events removed
        const facts = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, `${ID}.facts.json`), 'utf-8'));
        expect(facts.every(f => f.sceneId !== '001')).toBe(true);
        const tl = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, `${ID}.timeline.json`), 'utf-8'));
        expect(tl.every(e => e.sceneId !== '001')).toBe(true);

        // chapter repaired: 001 dropped, sceneCount recomputed, summary flagged stale
        const ch = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.chapters.json`), 'utf-8'));
        expect(ch[0].sceneIds).toEqual(['002']);
        expect(ch[0].sceneCount).toBe(1);
        expect(ch[0].invalidated).toBe(true);
        // Stays sealed. Deleting a scene used to unseal its chapter, which was a
        // latent hazard: the append path takes the FIRST chapter without
        // `sealedAt` as the open one, so unsealing a chapter mid-book would send
        // new scenes into it while the real trailing chapter sat idle.
        // `invalidated` already signals "summary needs regenerating".
        expect(ch[0].sealedAt).toBeDefined();

        // embedding deleted
        expect(deleteMock).toHaveBeenCalledWith(ID, '001');
    });

    it('returns sceneExisted=false when the scene is absent', async () => {
        seedArchive();
        const res = await request.delete(`/api/campaigns/${ID}/archive/scenes/999`);
        expect(res.status).toBe(200);
        expect(res.body.sceneExisted).toBe(false);
    });

    it('rejects an invalid sceneId', async () => {
        const res = await request.delete(`/api/campaigns/${ID}/archive/scenes/abc`);
        expect(res.status).toBe(400);
    });
});

describe('WO-F: edit-sync (updateSceneAssistant)', () => {
    it('rewrites the GM block, rebuilds the index entry, and re-embeds', async () => {
        seedArchive();

        const res = await request
            .patch(`/api/campaigns/${ID}/archive/scenes/002/assistant`)
            .send({ assistantContent: 'The barkeep pours a dark stout and winks.' });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.userContent).toBe('I order ale.');

        // .archive.md: scene 002 GM block updated
        const md = fs.readFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.md`), 'utf-8');
        expect(md).toContain('The barkeep pours a dark stout and winks.');
        expect(md).not.toContain('The barkeep pours ale.');
        // user block preserved
        expect(md).toContain('**[USER]**\nI order ale.');

        // index entry rebuilt for scene 002
        const idx = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.index.json`), 'utf-8'));
        const entry002 = idx.find(e => e.sceneId === '002');
        expect(entry002).toBeDefined();
        expect(entry002.userSnippet).toBe('I order ale.');

        // re-embed ran
        expect(storeMock).toHaveBeenCalled();
    });

    it('rejects empty assistantContent', async () => {
        seedArchive();
        const res = await request
            .patch(`/api/campaigns/${ID}/archive/scenes/002/assistant`)
            .send({ assistantContent: '   ' });
        expect(res.status).toBe(400);
    });

    it('returns 404 for a missing scene', async () => {
        seedArchive();
        const res = await request
            .patch(`/api/campaigns/${ID}/archive/scenes/999/assistant`)
            .send({ assistantContent: 'x' });
        expect(res.status).toBe(404);
    });

    it('returns 404 when the archive file does not exist', async () => {
        const res = await request
            .patch(`/api/campaigns/${ID}/archive/scenes/001/assistant`)
            .send({ assistantContent: 'x' });
        expect(res.status).toBe(404);
    });
});