import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * The model switch as the settings screen drives it: download with progress,
 * then switch, re-open the store and re-index. A failed download (offline, a
 * dropped connection) must leave the running model and the saved choice alone.
 */

const state = vi.hoisted(() => ({
    active: 'english',
    downloaded: { english: true, multilingual: false },
    download: null,
    jobs: [],
}));

vi.mock('../lib/embedder.js', async (importOriginal) => {
    const real = await importOriginal();
    return {
        ...real,
        getActiveModelKey: () => state.active,
        isModelDownloaded: (k) => !!state.downloaded[k],
        downloadModel: (...args) => state.download(...args),
        setActiveModel: vi.fn((k) => { state.active = k; }),
        warmup: vi.fn(async () => true),
    };
});
vi.mock('../lib/vectorStore.js', () => ({
    initDb: vi.fn(),
    getDb: vi.fn(() => null),
    markVectorStoreUnavailable: vi.fn(),
    EMBEDDING_VERSIONS: { scene: 2, lore: 1, rule: 1 },
}));
vi.mock('../lib/embedJobs.js', () => ({ getActiveJobs: () => state.jobs }));
vi.mock('../services/archiveService.js', () => ({ reindexEmbeddings: vi.fn(async () => ({})) }));
vi.mock('../routes/rules.js', () => ({ reindexCampaignRules: vi.fn(async () => ({ status: 'success' })) }));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-model-svc-'));
process.env.DATA_DIR = tmpDir;

const { SETTINGS_FILE } = await import('../lib/fileStore.js');
const svc = await import('../services/embeddingModelService.js');
const vectorStore = await import('../lib/vectorStore.js');
const embedder = await import('../lib/embedder.js');

const savedChoice = () => {
    try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')).settings?.embeddingModelKey; } catch { return undefined; }
};
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

beforeEach(() => {
    state.active = 'english';
    state.downloaded = { english: true, multilingual: false };
    state.jobs = [];
    svc._resetEmbeddingModelState();
    vi.clearAllMocks();
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ settings: { theme: 'dark' } }), 'utf-8');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('embedding model service', () => {
    it('reports both models and which is running', () => {
        const s = svc.getEmbeddingModelStatus();
        expect(s.active).toBe('english');
        expect(s.selected).toBe('english');
        expect(s.models.map(m => [m.key, m.downloaded])).toEqual([['english', true], ['multilingual', false]]);
        expect(s.models.find(m => m.key === 'multilingual').approxDownloadMB).toBeGreaterThan(0);
    });

    it('downloads with progress, then switches, rebuilds the store and saves the choice', async () => {
        let finish;
        state.download = vi.fn((_key, onProgress) => {
            onProgress({ status: 'progress', file: 'onnx/model_quantized.onnx', loaded: 50, total: 100 });
            onProgress({ status: 'progress', file: 'tokenizer.json', loaded: 10, total: 20 });
            return new Promise(r => { finish = r; });
        });

        expect(svc.selectEmbeddingModel('multilingual')).toEqual({ status: 'downloading' });
        const mid = svc.getEmbeddingModelStatus();
        expect(mid.download).toMatchObject({ key: 'multilingual', state: 'downloading', loaded: 60, total: 120 });
        expect(mid.active).toBe('english');
        expect(savedChoice()).toBeUndefined();

        const pipeline = { fake: true };
        finish(pipeline);
        await settle();

        expect(embedder.setActiveModel).toHaveBeenCalledWith('multilingual', pipeline);
        expect(vectorStore.initDb).toHaveBeenCalledTimes(1);
        expect(savedChoice()).toBe('multilingual');
        expect(svc.getEmbeddingModelStatus().download.state).toBe('done');
    });

    it('keeps the current model when the download fails (offline)', async () => {
        state.download = vi.fn(async () => { throw new Error('fetch failed'); });
        svc.selectEmbeddingModel('multilingual');
        await settle();

        const s = svc.getEmbeddingModelStatus();
        expect(s.download).toMatchObject({ state: 'failed', error: 'fetch failed' });
        expect(s.active).toBe('english');
        expect(savedChoice()).toBeUndefined();
        expect(embedder.setActiveModel).not.toHaveBeenCalled();
        expect(vectorStore.initDb).not.toHaveBeenCalled();
    });

    it('switches at once to a model already on disk', () => {
        state.downloaded.multilingual = true;
        expect(svc.selectEmbeddingModel('multilingual')).toEqual({ status: 'switched' });
        expect(embedder.setActiveModel).toHaveBeenCalledWith('multilingual', null);
        expect(vectorStore.initDb).toHaveBeenCalledTimes(1);
        expect(savedChoice()).toBe('multilingual');
    });

    it('does nothing for the model already running', () => {
        expect(svc.selectEmbeddingModel('english')).toEqual({ status: 'unchanged' });
        expect(vectorStore.initDb).not.toHaveBeenCalled();
    });

    it('refuses an unknown model and a switch while indexing runs', () => {
        expect(() => svc.selectEmbeddingModel('klingon')).toThrow(/Unknown/);
        state.jobs = [{ campaignId: 'c', kind: 'archive' }];
        expect(() => svc.selectEmbeddingModel('multilingual')).toThrow(svc.EmbeddingModelError);
    });
});
