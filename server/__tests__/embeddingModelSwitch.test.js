import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * Switching the embedding model must drop every stored vector even when the new
 * model has the same size: two models' vectors live in unrelated spaces, and a
 * mixed table would rank nonsense. The stored model id is the signal; a change is
 * handled exactly like a size change — tables rebuilt, everything marked stale,
 * re-index rebuilds it.
 */

const model = vi.hoisted(() => ({ id: 'model-a', dims: 8 }));
vi.mock('../lib/embedder.js', () => ({
    getActiveDims: () => model.dims,
    getActiveModelId: () => model.id,
}));

let tmpDir;
let settingsFile;
let vs;

const vec = (dims, fill = 0.5) => Buffer.from(new Float32Array(dims).fill(fill).buffer);
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf-8')).settings;
const rowCount = (table) => vs.getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-model-switch-'));
    process.env.DATA_DIR = tmpDir;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fileStore = await import('../lib/fileStore.js');
    settingsFile = fileStore.SETTINGS_FILE;
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    vs = await import('../lib/vectorStore.js');
    vs.initDb();
});

afterAll(() => {
    vi.restoreAllMocks();
    try { vs.getDb()?.close(); } catch { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('vector store — embedding model change', () => {
    it('records the model that built the tables, even on a fresh install', () => {
        expect(readSettings()).toMatchObject({ embeddingDims: 8, embeddingModelId: 'model-a' });
    });

    it('keeps the vectors when the model is unchanged', () => {
        vs.storeArchiveEmbedding('camp', '001', vec(8));
        vs.storeLoreEmbedding('camp', 'lore-1', vec(8));
        vs.storeRulesEmbedding('camp', 'rule-1', vec(8));
        vs.initDb();
        expect(rowCount('archive_vss')).toBe(1);
        expect(vs.getVectorHealth('camp')).toEqual({ status: 'ok' });
    });

    it('drops every vector and marks everything stale when the model changes at the same size', () => {
        model.id = 'model-b';   // same 8 dims
        vs.initDb();

        expect(rowCount('archive_vss')).toBe(0);
        expect(rowCount('lore_vss')).toBe(0);
        expect(rowCount('rules_vss')).toBe(0);
        expect(vs.getEmbeddingStatus('camp').scenes).toEqual({ total: 1, current: 0, stale: 1 });
        expect(vs.getVectorHealth('camp')).toEqual({ status: 'reindex-needed', count: 3 });
        expect(readSettings()).toMatchObject({ embeddingDims: 8, embeddingModelId: 'model-b' });
    });

    it('does not rebuild again on the next start with the new model', () => {
        vs.storeArchiveEmbedding('camp', '001', vec(8));
        vs.initDb();
        expect(rowCount('archive_vss')).toBe(1);
    });

    it('takes the new model size, not the stored one, when the model and size both change', () => {
        model.id = 'model-c';
        model.dims = 16;
        vs.initDb();
        expect(readSettings()).toMatchObject({ embeddingDims: 16, embeddingModelId: 'model-c' });
        expect(() => vs.storeArchiveEmbedding('camp', '001', vec(16))).not.toThrow();
        expect(vs.getEmbeddingStatus('camp').scenes).toEqual({ total: 1, current: 1, stale: 0 });
    });
});
