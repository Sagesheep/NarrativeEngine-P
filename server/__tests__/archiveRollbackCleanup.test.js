// Scene-counter integrity on the server side.
//
// Two behaviours frozen here:
//   1. Rollback and clear-archive drop the vectors of the scenes they remove.
//      Only `deleteScene` ever did. Every regenerate/edit therefore left a live
//      vector pointing at prose that no longer existed — it could still win a
//      semantic-search slot, and `fetchScenesByIds` would then find no block for
//      it, silently spending the recall budget on nothing.
//   2. `getNextSceneNumber` never hands out an id that is already in use, in
//      either the prose or the index. A reused id is unrecoverable: scene ids
//      are the primary key for the index, chapters, embeddings, facts, timeline
//      and the divergence register, so two scenes sharing one merges history.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const deleteMock = vi.fn();
const deleteAllMock = vi.fn();

let tmpDir;
let CAMPAIGNS_DIR;
let svc;
let store;

beforeEach(async () => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-rollback-'));
    process.env.DATA_DIR = tmpDir;

    vi.doMock('../lib/embedder.js', () => ({
        embedText: vi.fn(async () => new Float32Array(32)),
        buildArchiveText: vi.fn((e) => `MOCK ${e.sceneId}`),
        buildLoreText: vi.fn(() => 'MOCK_LORE'),
        warmup: vi.fn(async () => {}),
        embedBatch: vi.fn(async () => []),
        getActiveDims: vi.fn(() => 32),
        getActiveModelId: vi.fn(() => 'mock'),
        EMBEDDING_VERSION: 1,
    }));
    vi.doMock('../lib/vectorStore.js', () => ({
        storeArchiveEmbedding: vi.fn(),
        storeLoreEmbedding: vi.fn(),
        searchArchive: vi.fn(async () => []),
        searchLore: vi.fn(async () => []),
        getEmbeddingStatus: vi.fn(() => ({ status: 'mock', loaded: true })),
        EMBEDDING_VERSION: 1,
        getDb: vi.fn(() => null),
        deleteArchiveEmbedding: deleteMock,
        deleteAllArchiveEmbeddings: deleteAllMock,
    }));

    store = await import('../lib/fileStore.js');
    CAMPAIGNS_DIR = store.CAMPAIGNS_DIR;
    fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });
    svc = await import('../services/archiveService.js');
});

afterEach(() => {
    vi.doUnmock('../lib/embedder.js');
    vi.doUnmock('../lib/vectorStore.js');
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    deleteMock.mockClear();
    deleteAllMock.mockClear();
});

const ID = 'camp-test';

function block(n) {
    const id = String(n).padStart(3, '0');
    return [`## SCENE ${id}`, '*t*', '', '**[USER]**', `input ${id}`, '', '**[GM]**', `reply ${id}`, '', '---', '', ''].join('\n');
}
function seed(nums) {
    fs.writeFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.md`), nums.map(block).join(''), 'utf-8');
    fs.writeFileSync(
        path.join(CAMPAIGNS_DIR, `${ID}.archive.index.json`),
        JSON.stringify(nums.map(n => ({
            sceneId: String(n).padStart(3, '0'), timestamp: n, keywords: [],
            npcsMentioned: [], witnesses: [], userSnippet: `input ${String(n).padStart(3, '0')}`,
        })), null, 2),
        'utf-8',
    );
}

describe('rollback / clear drop the vectors they orphan', () => {
    it('deletes an embedding for every scene the rollback removes', () => {
        seed([1, 2, 3, 4, 5]);
        svc.rollbackScenesFrom(ID, '003');
        const dropped = deleteMock.mock.calls.map(c => c[1]).sort();
        expect(dropped).toEqual(['003', '004', '005']);
    });

    it('leaves the surviving scenes\' vectors alone', () => {
        seed([1, 2, 3]);
        svc.rollbackScenesFrom(ID, '003');
        const dropped = deleteMock.mock.calls.map(c => c[1]);
        expect(dropped).not.toContain('001');
        expect(dropped).not.toContain('002');
    });

    it('drops a prose-only ghost that the index never knew about', () => {
        // An interrupted append can leave prose with no index entry. Collecting
        // removed ids from the index alone would miss it and strand its vector.
        seed([1, 2]);
        fs.appendFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.md`), block(3), 'utf-8');
        svc.rollbackScenesFrom(ID, '003');
        expect(deleteMock.mock.calls.map(c => c[1])).toContain('003');
    });

    it('clears every scene vector when the archive is cleared', () => {
        seed([1, 2, 3]);
        svc.clearArchive(ID);
        expect(deleteAllMock).toHaveBeenCalledWith(ID);
    });
});

describe('getNextSceneNumber never reuses a live id', () => {
    it('returns 1 for a campaign with no archive', () => {
        expect(store.getNextSceneNumber(ID)).toBe(1);
    });

    it('follows the highest scene, not the last one written', () => {
        // Descending prose — "last match" would return 002 and collide with 005.
        seed([5, 4, 3, 2, 1]);
        expect(store.getNextSceneNumber(ID)).toBe(6);
    });

    it('accounts for a scene that exists only in the index', () => {
        // Prose write interrupted before the index write landed, or vice versa.
        // Reading only the prose would hand out 003 a second time.
        seed([1, 2]);
        const idxp = path.join(CAMPAIGNS_DIR, `${ID}.archive.index.json`);
        const idx = JSON.parse(fs.readFileSync(idxp, 'utf-8'));
        idx.push({ sceneId: '003', timestamp: 3, keywords: [], npcsMentioned: [], witnesses: [], userSnippet: 'x' });
        fs.writeFileSync(idxp, JSON.stringify(idx), 'utf-8');
        expect(store.getNextSceneNumber(ID)).toBe(4);
    });

    it('accounts for a scene that exists only in the prose', () => {
        seed([1, 2]);
        fs.appendFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.md`), block(7), 'utf-8');
        expect(store.getNextSceneNumber(ID)).toBe(8);
    });

    it('preserves gaps left by a surgical delete instead of refilling them', () => {
        seed([1, 2, 4, 5]);
        expect(store.getNextSceneNumber(ID)).toBe(6);
    });
});
