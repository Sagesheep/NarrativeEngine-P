import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TurnState } from '../turnOrchestrator';
import type { ArchiveScene, GameContext } from '../../types';

vi.mock('../archiveMemory', () => ({
    recallArchiveScenes: vi.fn().mockResolvedValue([]),
    retrieveArchiveMemory: vi.fn().mockReturnValue([]),
    fetchArchiveScenes: vi.fn().mockResolvedValue([]),
}));
vi.mock('../archiveChapterEngine', () => ({
    rankChapters: vi.fn().mockReturnValue([]),
    recallWithChapterFunnel: vi.fn().mockResolvedValue([]),
    shouldAutoSeal: vi.fn().mockReturnValue(false),
}));
vi.mock('../contextRecommender', () => ({
    recommendContext: vi.fn().mockResolvedValue({ relevantNPCNames: [], relevantLoreIds: [] }),
}));
vi.mock('../loreRetriever', () => ({
    retrieveRelevantLore: vi.fn().mockReturnValue([]),
    searchLoreByQuery: vi.fn().mockReturnValue([]),
}));

// Mock fetch for the scene number endpoint
global.fetch = vi.fn().mockResolvedValue({
    ok: false,
} as Response);

import { gatherContext } from '../contextGatherer';
import { fetchArchiveScenes } from '../archiveMemory';

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
    interventionQueue: [],
    interventionChance: 0,
    notebook: [],
} as unknown as GameContext);

const makeState = (overrides: Partial<TurnState> = {}): TurnState => ({
    input: 'test input',
    displayInput: 'test input',
    settings: {} as any,
    context: baseContext(),
    messages: [],
    condenser: { condensedSummary: '', condensedUpToIndex: -1, isCondensing: false },
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
        // archiveRecall already has scene 005 (from archive retrieval)
        const { recallArchiveScenes } = await import('../archiveMemory');
        vi.mocked(recallArchiveScenes).mockResolvedValueOnce([existingScene]);

        const pinnedScene: ArchiveScene = { sceneId: '006', content: 'pinned only', tokens: 10 };
        mockFetchArchiveScenes.mockResolvedValueOnce([pinnedScene]);

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
                title: 'Chapter 1',
                sealedAt: null,
                sceneCount: 2,
            }],
        });

        const result = await gatherContext(state, 'look', deps);

        // Scene 005 should not be fetched again (alreadyCoveredIds skips it)
        const fetchedIds = mockFetchArchiveScenes.mock.calls[0]?.[1] ?? [];
        expect(fetchedIds).not.toContain('005');
        expect(fetchedIds).toContain('006');
        // Result contains both
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
