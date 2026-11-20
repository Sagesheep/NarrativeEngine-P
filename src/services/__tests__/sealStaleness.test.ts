/* eslint-disable @typescript-eslint/no-explicit-any */
// A chapter seal runs a long model call. These tests pin what happens to the world that
// moved on during it: facts edited meanwhile survive, and a chapter that was reopened by
// a rewind (or removed) does not get the stale result written onto it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArchiveChapter, DivergenceEntry, DivergenceRegister, EndpointConfig } from '../../types';
import type { TurnState, TurnCallbacks } from '../turn/turnOrchestrator';

const sealChapterCombinedMock = vi.fn(async (..._args: unknown[]) => ({
    summary: { title: 'Sealed', themes: [], keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], tone: '', sceneCount: 3 },
    divergences: [{ id: 'new1', chapterId: 'CH01', category: 'world_state', text: 'The harbor flooded.', sceneRef: '003', npcIds: [], pinned: false, enabled: true, source: 'seal', importance: 7 }],
    divergenceParseError: false,
    witnessCorrections: {},
    sceneEventMap: {},
}));
vi.mock('../saveFileEngine', () => ({
    sealChapterCombined: (...args: unknown[]) => sealChapterCombinedMock(...args),
    generateChapterSummary: vi.fn().mockResolvedValue(null),
}));

const SEALED_AT = 1000;
const chaptersList = vi.fn();
vi.mock('../llm/apiClient', () => ({
    api: {
        archive: {
            fetchScenes: vi.fn().mockResolvedValue([]),
            getIndex: vi.fn().mockResolvedValue([]),
            patchWitnesses: vi.fn().mockResolvedValue(undefined),
            patchEvents: vi.fn().mockResolvedValue(undefined),
        },
        chapters: {
            list: (...args: unknown[]) => chaptersList(...args),
            update: vi.fn().mockResolvedValue(null),
            seal: vi.fn().mockResolvedValue(null),
        },
        timeline: { get: vi.fn().mockResolvedValue([]) },
    },
}));
vi.mock('../../store/campaignStore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../store/campaignStore')>()),
    saveDivergenceRegister: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../components/Toast', () => ({ toast: { info: vi.fn(), error: vi.fn(), warning: vi.fn(), success: vi.fn() } }));

import { runCombinedSeal } from '../turn/postTurnPipeline';
import { api } from '../llm/apiClient';

const PROVIDER = { endpoint: 'http://seal', apiKey: 'k', modelName: 'm' } as EndpointConfig;
const CHAPTER = {
    chapterId: 'CH01', title: 'The Road', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'],
    summary: '', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], tone: '', themes: [],
    sceneCount: 3, sealedAt: SEALED_AT,
} as ArchiveChapter;

const fact = (id: string, text: string, extra: Partial<DivergenceEntry> = {}): DivergenceEntry => ({
    id, chapterId: 'CH01', category: 'world_state', text, sceneRef: '001', npcIds: [], pinned: false,
    enabled: true, source: 'seal', ...extra,
} as DivergenceEntry);
const register = (entries: DivergenceEntry[]): DivergenceRegister => ({
    entries, chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2,
} as DivergenceRegister);

const state = { setChapters: vi.fn() } as any as TurnState;
let setRegister: ReturnType<typeof vi.fn>;
const callbacks = () => ({ setDivergenceRegister: setRegister, setArchiveIndex: vi.fn() }) as any as TurnCallbacks;

function inputs(snapshot: DivergenceRegister, live: () => DivergenceRegister) {
    return {
        npcLedger: [], archiveIndex: [], divergenceScanBudget: 1000, contextLimit: 4096,
        divergenceRegister: snapshot, getDivergenceRegister: live,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    setRegister = vi.fn();
    chaptersList.mockResolvedValue([{ ...CHAPTER }]);
});

describe('chapter seal against a world that moved on', () => {
    it('merges new facts into the register as it is now, keeping edits made during the seal', async () => {
        const snapshot = register([fact('a', 'Old fact'), fact('b', 'Fact the player deletes')]);
        // During the model call the player pinned `a` and deleted `b`.
        const live = register([fact('a', 'Old fact', { pinned: true })]);

        await runCombinedSeal(PROVIDER, CHAPTER, 'camp', state, callbacks(), true, inputs(snapshot, () => live));

        const written = setRegister.mock.calls.at(-1)![0] as DivergenceRegister;
        const ids = written.entries.map(e => e.id);
        expect(ids).toContain('new1');
        expect(ids).not.toContain('b');                       // the delete survives
        expect(written.entries.find(e => e.id === 'a')?.pinned).toBe(true); // the pin survives
    });

    it('writes nothing when a rewind reopened the chapter during the seal', async () => {
        chaptersList.mockResolvedValue([{ ...CHAPTER, sealedAt: undefined, invalidated: true }]);
        const snapshot = register([fact('a', 'Old fact')]);

        await runCombinedSeal(PROVIDER, CHAPTER, 'camp', state, callbacks(), true, inputs(snapshot, () => snapshot));

        expect(setRegister).not.toHaveBeenCalled();
        expect(api.chapters.update).not.toHaveBeenCalled();
    });

    it('writes nothing when a scene of the chapter was deleted during the seal', async () => {
        // Surgical delete keeps the chapter sealed and marks it invalidated.
        chaptersList.mockResolvedValue([{ ...CHAPTER, sceneCount: 2, invalidated: true }]);
        const snapshot = register([fact('a', 'Old fact')]);

        await runCombinedSeal(PROVIDER, CHAPTER, 'camp', state, callbacks(), true, inputs(snapshot, () => snapshot));

        expect(setRegister).not.toHaveBeenCalled();
        expect(api.chapters.update).not.toHaveBeenCalled();
    });

    it('still regenerates a chapter that was already marked invalidated', async () => {
        // The Repair / regenerate button runs on an invalidated chapter on purpose.
        const invalid = { ...CHAPTER, invalidated: true } as ArchiveChapter;
        chaptersList.mockResolvedValue([{ ...invalid }]);
        const snapshot = register([]);

        await runCombinedSeal(PROVIDER, invalid, 'camp', state, callbacks(), false, inputs(snapshot, () => snapshot));

        expect(api.chapters.update).toHaveBeenCalled();
    });

    it('writes nothing when the chapter was removed during the seal', async () => {
        chaptersList.mockResolvedValue([{ ...CHAPTER, chapterId: 'CH02' }]);
        const snapshot = register([]);

        await runCombinedSeal(PROVIDER, CHAPTER, 'camp', state, callbacks(), true, inputs(snapshot, () => snapshot));

        expect(setRegister).not.toHaveBeenCalled();
        expect(api.chapters.update).not.toHaveBeenCalled();
    });

    it('still writes when the chapter list could not be read', async () => {
        chaptersList.mockResolvedValue([]);
        const snapshot = register([]);

        await runCombinedSeal(PROVIDER, CHAPTER, 'camp', state, callbacks(), true, inputs(snapshot, () => snapshot));

        expect(api.chapters.update).toHaveBeenCalled();
    });
});
