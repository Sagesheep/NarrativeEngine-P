/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TurnState } from '../turn/turnOrchestrator';
import type { ArchiveScene, GameContext } from '../../types';

vi.mock('../archiveMemory', () => ({
    recallArchiveScenes: vi.fn().mockResolvedValue([]),
    retrieveArchiveMemory: vi.fn().mockReturnValue([]),
    fetchArchiveScenes: vi.fn().mockResolvedValue([]),
}));
vi.mock('../archive-memory/archiveChapterEngine', () => ({
    rankChapters: vi.fn().mockReturnValue([]),
    recallWithChapterFunnel: vi.fn().mockResolvedValue([]),
    shouldAutoSeal: vi.fn().mockReturnValue(false),
}));
vi.mock('../contextRecommender', () => ({
    recommendContext: vi.fn().mockResolvedValue({ relevantNPCNames: [], relevantLoreIds: [] }),
}));
vi.mock('../archive-memory/dynamicElevation', () => ({
    gatherDynamicElevation: vi.fn(async () => ({ scenes: [], rankedSceneIds: [] })),
}));
vi.mock('../lore/loreRetriever', () => ({
    retrieveRelevantLore: vi.fn().mockReturnValue([]),
    searchLoreByQuery: vi.fn().mockReturnValue([]),
}));

// Mock fetch for the scene number endpoint
global.fetch = vi.fn().mockResolvedValue({
    ok: false,
} as Response);

import { gatherContext } from '../turn/contextGatherer';
import { fetchArchiveScenes } from '../archiveMemory';
import { gatherDynamicElevation } from '../archive-memory/dynamicElevation';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';

const mockFetchArchiveScenes = vi.mocked(fetchArchiveScenes);

const baseContext = (): GameContext => ({
    loreRaw: '',
    rulesRaw: '',
    canonState: '',
    headerIndex: '',
    starter: '',
    continuePrompt: '',
    inventory: '',
    characterProfile: '',
    notebook: [],
} as unknown as GameContext);

const makeState = (overrides: Partial<TurnState> = {}): TurnState => ({
    input: 'test input',
    displayInput: 'test input',
    settings: {} as any,
    context: baseContext(),
    messages: [],
    condenser: { condensedUpToIndex: -1 },
    loreChunks: [],
    npcLedger: [],
    archiveIndex: [],
    activeCampaignId: 'campaign-1',
    provider: undefined,
    getMessages: () => [],
    getFreshProvider: () => undefined,
    chapters: [],
    pinnedChapterIds: [],
    clearPinnedChapters: vi.fn(),
    setChapters: vi.fn(),
    incrementBookkeepingTurnCounter: vi.fn().mockReturnValue(1),
    resetBookkeepingTurnCounter: vi.fn(),
    autoBookkeepingInterval: 5,
    getFreshContext: () => baseContext(),
    ...overrides,
});

const noDeps = (overrides = {}) => ({
    chapters: [],
    pinnedChapterIds: [],
    clearPinnedChapters: vi.fn(),
    deepSearchThisTurn: false,
    ...overrides,
});

describe('gatherContext', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns empty archiveRecall when archiveIndex is empty', async () => {
        const state = makeState({ archiveIndex: [], activeCampaignId: 'c1' });
        const result = await gatherContext(state, 'attack', noDeps());
        expect(result.archiveRecall).toBeUndefined();
    });

    it('returns undefined relevantLore when loreChunks is empty', async () => {
        const state = makeState({ loreChunks: [] });
        const result = await gatherContext(state, 'attack', noDeps());
        expect(result.relevantLore).toBeUndefined();
    });

    it('returns empty timelineEvents when state.timeline is undefined', async () => {
        const state = makeState({ timeline: undefined });
        const result = await gatherContext(state, 'attack', noDeps());
        expect(result.timelineEvents).toEqual([]);
    });

    it('injects pinned scenes and calls clearPinnedChapters once', async () => {
        const pinnedScene: ArchiveScene = { sceneId: '005', content: 'pinned content', tokens: 10 };
        mockFetchArchiveScenes.mockResolvedValueOnce([pinnedScene]);

        const { retrieveArchiveMemory } = await import('../archiveMemory');
        vi.mocked(retrieveArchiveMemory).mockReturnValueOnce(['005']);

        const clearPinnedChapters = vi.fn();
        const state = makeState({ activeCampaignId: 'c1' });
        const deps = noDeps({
            pinnedChapterIds: ['ch1'],
            clearPinnedChapters,
            chapters: [{
                chapterId: 'ch1',
                sceneRange: ['005', '005'],
                title: 'Chapter 1',
                sealedAt: null,
                sceneCount: 1,
            }],
        });

        const result = await gatherContext(state, 'look', deps);

        expect(result.archiveRecall).toEqual([pinnedScene]);
        expect(clearPinnedChapters).toHaveBeenCalledOnce();
    });

    it('does not duplicate scenes already in archiveRecall', async () => {
        const existingScene: ArchiveScene = { sceneId: '005', content: 'existing', tokens: 10 };
        const { retrieveArchiveMemory } = await import('../archiveMemory');
        vi.mocked(retrieveArchiveMemory)
            .mockReturnValueOnce(['005'])
            .mockReturnValueOnce(['005', '006']);

        const pinnedScene: ArchiveScene = { sceneId: '006', content: 'pinned only', tokens: 10 };
        mockFetchArchiveScenes
            .mockResolvedValueOnce([existingScene])
            .mockResolvedValueOnce([pinnedScene]);

        const state = makeState({
            activeCampaignId: 'c1',
            archiveIndex: [{ sceneId: '005', timestamp: 1, keywords: [], npcsMentioned: [], witnesses: [], userSnippet: '' }],
        });
        const deps = noDeps({
            pinnedChapterIds: ['ch1'],
            clearPinnedChapters: vi.fn(),
            chapters: [{
                chapterId: 'ch1',
                sceneRange: ['005', '006'],
                sceneIds: ['005', '006'],
                title: 'Chapter 1',
                sealedAt: null,
                sceneCount: 2,
            }],
        });

        const result = await gatherContext(state, 'look', deps);

        const fetchedIds = mockFetchArchiveScenes.mock.calls[1]?.[1] ?? [];
        expect(fetchedIds).not.toContain('005');
        expect(fetchedIds).toContain('006');
        expect(result.archiveRecall).toEqual(expect.arrayContaining([existingScene, pinnedScene]));
    });

    it('does not call clearPinnedChapters when pinnedChapterIds is empty', async () => {
        const clearPinnedChapters = vi.fn();
        const state = makeState();
        const deps = noDeps({ pinnedChapterIds: [], clearPinnedChapters });

        await gatherContext(state, 'attack', deps);

        expect(clearPinnedChapters).not.toHaveBeenCalled();
    });
});

// The backstop used to be followed by awaiting every stage anyway, so a stuck stage
// still held the turn; and its uncleared timer logged a false timeout after every turn.
describe('gatherContext — backstop', () => {
    beforeEach(() => vi.clearAllMocks());

    it('continues without a stage that is still running at the backstop', async () => {
        vi.useFakeTimers();
        try {
            vi.mocked(gatherDynamicElevation).mockImplementationOnce(() => new Promise(() => {}));
            let done = false;
            const pending = gatherContext(makeState(), 'attack', noDeps()).then(r => { done = true; return r; });
            await vi.advanceTimersByTimeAsync(AI_CALL_TIMEOUT_MS - 1);
            expect(done).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            const result = await pending;
            expect(result.elevatedScenes ?? []).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('logs no timeout once the gather has finished', async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await gatherContext(makeState(), 'attack', noDeps());
            await vi.advanceTimersByTimeAsync(AI_CALL_TIMEOUT_MS + 1000);
            expect(warn.mock.calls.some(([m]) => /timeout|still running/i.test(String(m)))).toBe(false);
        } finally {
            warn.mockRestore();
            vi.useRealTimers();
        }
    });
});
