import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TurnState, TurnCallbacks } from '../turnOrchestrator';
import type { GameContext, ChatMessage } from '../../types';

vi.mock('../apiClient', () => ({
    api: {
        archive: {
            append: vi.fn(),
            getIndex: vi.fn().mockResolvedValue([]),
            fetchScenes: vi.fn().mockResolvedValue([]),
        },
        timeline: { get: vi.fn().mockResolvedValue([]) },
        chapters: {
            list: vi.fn().mockResolvedValue([]),
            seal: vi.fn().mockResolvedValue(null),
            update: vi.fn().mockResolvedValue(null),
        },
    },
}));
vi.mock('../backgroundQueue', () => ({
    backgroundQueue: { push: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../importanceRater', () => ({ rateImportance: vi.fn().mockResolvedValue(3) }));
vi.mock('../npcDetector', () => ({
    extractNPCNames: vi.fn().mockReturnValue([]),
    classifyNPCNames: vi.fn().mockReturnValue({ newNames: [], existingNpcs: [] }),
    validateNPCCandidates: vi.fn().mockResolvedValue([]),
}));
vi.mock('../saveFileEngine', () => ({ generateChapterSummary: vi.fn().mockResolvedValue(null) }));
vi.mock('../../components/Toast', () => ({ toast: { info: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('../chatEngine', () => ({
    buildPayload: vi.fn(),
    sendMessage: vi.fn(),
    generateNPCProfile: vi.fn(),
    updateExistingNPCs: vi.fn(),
}));
vi.mock('../characterProfileParser', () => ({ scanCharacterProfile: vi.fn() }));
vi.mock('../inventoryParser', () => ({ scanInventory: vi.fn() }));

import { runPostTurnPipeline } from '../postTurnPipeline';
import { api } from '../apiClient';
import { backgroundQueue } from '../backgroundQueue';
import { extractNPCNames, validateNPCCandidates, classifyNPCNames } from '../npcDetector';

const mockApi = vi.mocked(api);
const mockBQ = vi.mocked(backgroundQueue);
const mockExtractNPCNames = vi.mocked(extractNPCNames);
const mockValidateNPCCandidates = vi.mocked(validateNPCCandidates);
const mockClassifyNPCNames = vi.mocked(classifyNPCNames);

const baseContext = (): GameContext => ({
    loreRaw: '',
    rulesRaw: '',
    canonState: '',
    headerIndex: 'index',
    starter: '',
    continuePrompt: '',
    inventory: 'sword',
    characterProfile: 'hero',
    interventionQueue: [],
    notebook: [],
} as unknown as GameContext);

const makeState = (overrides: Partial<TurnState> = {}): TurnState => ({
    input: 'attack the goblin',
    displayInput: 'attack the goblin',
    settings: {} as any,
    context: baseContext(),
    messages: [],
    condenser: { condensedSummary: '', condensedUpToIndex: -1, isCondensing: false },
    loreChunks: [],
    npcLedger: [],
    archiveIndex: [],
    activeCampaignId: 'campaign-1',
    provider: { endpoint: 'http://llm', apiKey: '', modelName: 'm' },
    getMessages: vi.fn().mockReturnValue([]),
    getFreshProvider: vi.fn().mockReturnValue({ endpoint: 'http://llm', apiKey: '', modelName: 'm' }),
    chapters: [],
    pinnedChapterIds: [],
    clearPinnedChapters: vi.fn(),
    setChapters: vi.fn(),
    incrementBookkeepingTurnCounter: vi.fn().mockReturnValue(1),
    resetBookkeepingTurnCounter: vi.fn(),
    autoBookkeepingInterval: 5,
    getFreshContext: vi.fn().mockReturnValue(baseContext()),
    ...overrides,
});

const makeCallbacks = (): TurnCallbacks => ({
    onCheckingNotes: vi.fn(),
    addMessage: vi.fn(),
    updateLastAssistant: vi.fn(),
    updateLastMessage: vi.fn(),
    updateContext: vi.fn(),
    setArchiveIndex: vi.fn(),
    setTimeline: vi.fn(),
    updateNPC: vi.fn(),
    addNPC: vi.fn(),
    setCondensed: vi.fn(),
    setCondensing: vi.fn(),
    setStreaming: vi.fn(),
    setLoadingStatus: vi.fn(),
});

const ASSISTANT_CONTENT = 'The goblin falls to the ground.';
const ALL_MSGS: ChatMessage[] = [{ id: 'm1', role: 'assistant', content: ASSISTANT_CONTENT, timestamp: 1000 }];

describe('runPostTurnPipeline', () => {
    beforeEach(() => vi.clearAllMocks());

    it('calls api.archive.append with displayInput and lastAssistantContent', async () => {
        mockApi.archive.append.mockResolvedValueOnce({ sceneId: '001' });
        mockApi.chapters.list.mockResolvedValueOnce([]);

        const state = makeState();
        await runPostTurnPipeline(state, makeCallbacks(), ASSISTANT_CONTENT, ALL_MSGS);

        expect(mockApi.archive.append).toHaveBeenCalledWith(
            'campaign-1',
            'attack the goblin',
            ASSISTANT_CONTENT,
            3  // mocked rateImportance returns 3
        );
    });

    it('returns early (without calling getIndex) when archive.append returns null', async () => {
        mockApi.archive.append.mockResolvedValueOnce(null);

        const callbacks = makeCallbacks();
        await runPostTurnPipeline(makeState(), callbacks, ASSISTANT_CONTENT, ALL_MSGS);

        expect(mockApi.archive.getIndex).not.toHaveBeenCalled();
        expect(callbacks.setArchiveIndex).not.toHaveBeenCalled();
    });

    it('calls callbacks.setArchiveIndex with fresh index after successful append', async () => {
        const freshIndex = [{ sceneId: '001', timestamp: 1, keywords: [], npcsMentioned: [], witnesses: [], userSnippet: '' }];
        mockApi.archive.append.mockResolvedValueOnce({ sceneId: '001' });
        mockApi.archive.getIndex.mockResolvedValueOnce(freshIndex);
        mockApi.chapters.list.mockResolvedValueOnce([]);

        const callbacks = makeCallbacks();
        await runPostTurnPipeline(makeState(), callbacks, ASSISTANT_CONTENT, ALL_MSGS);

        expect(callbacks.setArchiveIndex).toHaveBeenCalledWith(freshIndex);
    });

    it('calls state.setChapters after listing chapters', async () => {
        const freshChapters = [{ chapterId: 'ch1', title: 'Ch1', sceneRange: ['001', '005'], sceneCount: 3, sealedAt: null }];
        mockApi.archive.append.mockResolvedValueOnce({ sceneId: '001' });
        mockApi.chapters.list.mockResolvedValueOnce(freshChapters);

        const state = makeState();
        await runPostTurnPipeline(state, makeCallbacks(), ASSISTANT_CONTENT, ALL_MSGS);

        expect(state.setChapters).toHaveBeenCalledWith(freshChapters);
    });

    it('pushes Chapter-AutoSeal to backgroundQueue when sceneCount >= CHAPTER_SCENE_SOFT_CAP', async () => {
        // CHAPTER_SCENE_SOFT_CAP = 25
        const openChapter = { chapterId: 'ch1', title: 'Chapter 1', sceneRange: ['001', '025'], sceneCount: 25, sealedAt: null };
        mockApi.archive.append.mockResolvedValueOnce({ sceneId: '025' });
        mockApi.chapters.list.mockResolvedValueOnce([openChapter]);

        await runPostTurnPipeline(makeState(), makeCallbacks(), ASSISTANT_CONTENT, ALL_MSGS);

        expect(mockBQ.push).toHaveBeenCalledWith('Chapter-AutoSeal', expect.any(Function));
    });

    it('does NOT push Chapter-AutoSeal when sceneCount < CHAPTER_SCENE_SOFT_CAP', async () => {
        const openChapter = { chapterId: 'ch1', title: 'Chapter 1', sceneRange: ['001', '003'], sceneCount: 3, sealedAt: null };
        mockApi.archive.append.mockResolvedValueOnce({ sceneId: '003' });
        mockApi.chapters.list.mockResolvedValueOnce([openChapter]);

        await runPostTurnPipeline(makeState(), makeCallbacks(), ASSISTANT_CONTENT, ALL_MSGS);

        const autoSealCalls = vi.mocked(mockBQ.push).mock.calls.filter(c => c[0] === 'Chapter-AutoSeal');
        expect(autoSealCalls).toHaveLength(0);
    });

    it('queues NPC-Gen for new NPC names detected in assistant content', async () => {
        mockApi.archive.append.mockResolvedValueOnce({ sceneId: '001' });
        mockApi.chapters.list.mockResolvedValueOnce([]);

        mockExtractNPCNames.mockReturnValueOnce(['Kaelen']);
        mockValidateNPCCandidates.mockResolvedValueOnce(['Kaelen']);
        mockClassifyNPCNames.mockReturnValueOnce({ newNames: ['Kaelen'], existingNpcs: [] });

        await runPostTurnPipeline(makeState(), makeCallbacks(), ASSISTANT_CONTENT, ALL_MSGS);

        expect(mockBQ.push).toHaveBeenCalledWith('NPC-Gen:Kaelen', expect.any(Function));
    });

    it('calls incrementBookkeepingTurnCounter and resetBookkeepingTurnCounter when turnCount >= interval', async () => {
        mockApi.archive.append.mockResolvedValueOnce({ sceneId: '005' });
        mockApi.chapters.list.mockResolvedValueOnce([]);

        const state = makeState({
            incrementBookkeepingTurnCounter: vi.fn().mockReturnValue(5),
            autoBookkeepingInterval: 5,
            resetBookkeepingTurnCounter: vi.fn(),
        });

        await runPostTurnPipeline(state, makeCallbacks(), ASSISTANT_CONTENT, ALL_MSGS);

        expect(state.incrementBookkeepingTurnCounter).toHaveBeenCalled();
        expect(state.resetBookkeepingTurnCounter).toHaveBeenCalled();
        expect(mockBQ.push).toHaveBeenCalledWith('Profile-Scan', expect.any(Function));
        expect(mockBQ.push).toHaveBeenCalledWith('Inventory-Scan', expect.any(Function));
    });

    it('does NOT call resetBookkeepingTurnCounter when turnCount < interval', async () => {
        mockApi.archive.append.mockResolvedValueOnce({ sceneId: '001' });
        mockApi.chapters.list.mockResolvedValueOnce([]);

        const state = makeState({
            incrementBookkeepingTurnCounter: vi.fn().mockReturnValue(2),
            autoBookkeepingInterval: 5,
            resetBookkeepingTurnCounter: vi.fn(),
        });

        await runPostTurnPipeline(state, makeCallbacks(), ASSISTANT_CONTENT, ALL_MSGS);

        expect(state.resetBookkeepingTurnCounter).not.toHaveBeenCalled();
    });
});
