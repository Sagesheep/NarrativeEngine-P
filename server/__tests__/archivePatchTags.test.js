import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const EMBEDDER = () => ({
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
});
const VECTORS = () => ({
    storeArchiveEmbedding: vi.fn(),
    storeLoreEmbedding: vi.fn(),
    searchArchive: vi.fn(async () => []),
    searchLore: vi.fn(async () => []),
    getEmbeddingStatus: vi.fn(() => ({ status: 'mock', loaded: true })),
    EMBEDDING_VERSIONS: { scene: 2, lore: 1, rule: 1 },
    getDb: vi.fn(() => null),
    deleteArchiveEmbedding: vi.fn(),
});

let tmpDir;
let patchEvents;
let indexFile;

const readIndex = () => JSON.parse(fs.readFileSync(indexFile, 'utf8'));

beforeEach(async () => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-patch-tags-'));
    process.env.DATA_DIR = tmpDir;
    vi.doMock('../lib/embedder.js', EMBEDDER);
    vi.doMock('../lib/vectorStore.js', VECTORS);

    const store = await import('../lib/fileStore.js');
    store.ensureDirs();
    indexFile = store.archiveIndexPath('camp');
    fs.writeFileSync(indexFile, JSON.stringify([
        { sceneId: '001', events: [{ eventType: 'other', importance: 3, text: 'Kept.' }] },
        { sceneId: '002' },
    ]));
    ({ patchEvents } = await import('../services/archiveService.js'));
});

afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('patchEvents — scene tags and hooks', () => {
    it('saves tags and hooks without touching events it was not given', () => {
        const hooks = [{ id: '001:0', type: 'promise', with: ['Therese'], what: 'Findings first.', status: 'open' }];
        patchEvents('camp', [{ sceneId: '001', tags: { tense: 2 }, hooks }]);
        const [first] = readIndex();
        expect(first.tags).toEqual({ tense: 2 });
        expect(first.hooks).toEqual(hooks);
        expect(first.events).toEqual([{ eventType: 'other', importance: 3, text: 'Kept.' }]);
    });

    it('a hooks-only patch keeps the scene\'s tags', () => {
        patchEvents('camp', [{ sceneId: '002', tags: { tense: 2 }, hooks: [] }]);
        patchEvents('camp', [{ sceneId: '002', hooks: [{ id: '002:0', status: 'closed' }] }]);
        const second = readIndex()[1];
        expect(second.tags).toEqual({ tense: 2 });
        expect(second.hooks).toEqual([{ id: '002:0', status: 'closed' }]);
    });

    it('an events-only patch, as the chapter seal sends, keeps tags', () => {
        patchEvents('camp', [{ sceneId: '002', tags: { tense: 2 } }]);
        patchEvents('camp', [{ sceneId: '002', events: [] }]);
        const second = readIndex()[1];
        expect(second.tags).toEqual({ tense: 2 });
        expect(second.events).toEqual([]);
    });

    it('saves a definition alone, trimmed, keeping tags', () => {
        patchEvents('camp', [{ sceneId: '002', tags: { tense: 2 } }]);
        patchEvents('camp', [{ sceneId: '002', definition: '  Grey and Rin fight bandits at the ford. ' }]);
        const second = readIndex()[1];
        expect(second.definition).toBe('Grey and Rin fight bandits at the ford.');
        expect(second.tags).toEqual({ tense: 2 });
    });

    it('ignores malformed fields and unknown scenes', () => {
        patchEvents('camp', [
            { sceneId: '002', tags: ['tense'], hooks: 'none', events: 'none', definition: '   ' },
            { sceneId: '999', tags: { tense: 2 } },
            { tags: { tense: 2 } },
        ]);
        expect(readIndex()[1]).toEqual({ sceneId: '002' });
        expect(readIndex()).toHaveLength(2);
    });
});
