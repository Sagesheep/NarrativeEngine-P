/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TurnState, TurnCallbacks } from '../turn/turnOrchestrator';
import type { GameContext, ChatMessage } from '../../types';

vi.mock('../llm/apiClient', () => ({
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
vi.mock('../infrastructure/backgroundQueue', () => ({
    backgroundQueue: { push: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../archive-memory/importanceRater', () => ({ rateImportance: vi.fn().mockResolvedValue(3) }));
vi.mock('../npc/npcDetector', () => ({
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
vi.mock('../enemy/enemySuggestions', () => ({ detectEnemySuggestions: vi.fn().mockResolvedValue([]) }));

import { runPostTurnPipeline } from '../turn/postTurnPipeline';
import { api } from '../llm/apiClient';
import { backgroundQueue } from '../infrastructure/backgroundQueue';
import { extractNPCNames, validateNPCCandidates, classifyNPCNames } from '../npc/npcDetector';
import { detectEnemySuggestions } from '../enemy/enemySuggestions';
import { DEFAULT_ENEMY_COMBAT_CONFIG } from '../enemy/enemyCombat';
import { useAppStore } from '../../store/useAppStore';

const mockApi = vi.mocked(api);
const mockBQ = vi.mocked(backgroundQueue);
const mockExtractNPCNames = vi.mocked(extractNPCNames);
const mockValidateNPCCandidates = vi.mocked(validateNPCCandidates);
const mockClassifyNPCNames = vi.mocked(classifyNPCNames);
const mockDetectEnemySuggestions = vi.mocked(detectEnemySuggestions);

const baseContext = (): GameContext => ({
    loreRaw: '',
    rulesRaw: '',
    canonState: '',
    headerIndex: 'index',
    starter: '',
    continuePrompt: '',
    inventory: 'sword',
    characterProfile: 'hero',
    notebook: [],
} as unknown as GameContext);

const makeState = (overrides: Partial<TurnState> = {}): TurnState => ({
    input: 'attack the goblin',
    displayInput: 'attack the goblin',
    settings: { aiTier: 'max' } as any,
    context: baseContext(),
    messages: [],
    condenser: { condensedUpToIndex: -1 },
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
    updateLastAssistantMessage: vi.fn(),
    updateContext: vi.fn(),
    setArchiveIndex: vi.fn(),
    setTimeline: vi.fn(),
    updateNPC: vi.fn(),
    addNPC: vi.fn(),
    setCondensed: vi.fn(),
    setStreaming: vi.fn(),
    setLoadingStatus: vi.fn(),
    addNpcSuggestions: vi.fn(),
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

    it('queues enemy discoveries for review when campaign discovery is enabled', async () => {
        mockApi.archive.append.mockResolvedValueOnce({ sceneId: '001' });
        mockApi.chapters.list.mockResolvedValueOnce([]);
        mockDetectEnemySuggestions.mockResolvedValueOnce([{
            kind: 'new',
            name: 'Orc Berserker',
            classification: 'Orc',
        }]);
        useAppStore.setState({ activeCampaignId: 'campaign-1' });
        mockBQ.push.mockImplementationOnce(async (_label, execute) => execute());
        const callbacks = { ...makeCallbacks(), addEnemySuggestions: vi.fn() };
        const state = makeState({
            enemyCompendium: [],
            enemyCombatConfig: { ...DEFAULT_ENEMY_COMBAT_CONFIG, enemyDiscoveryEnabled: true },
        });

        await runPostTurnPipeline(state, callbacks, ASSISTANT_CONTENT, ALL_MSGS);

        expect(mockDetectEnemySuggestions).toHaveBeenCalled();
        expect(callbacks.addEnemySuggestions).toHaveBeenCalledWith([
            expect.objectContaining({ kind: 'new', name: 'Orc Berserker' }),
        ], ASSISTANT_CONTENT);
    });

    it('Lite tier cannot run enemy discovery even when the flag is enabled', async () => {
        mockApi.archive.append.mockResolvedValueOnce({ sceneId: '001' });
        mockApi.chapters.list.mockResolvedValueOnce([]);
        useAppStore.setState({ activeCampaignId: 'campaign-1' });
        const callbacks = { ...makeCallbacks(), addEnemySuggestions: vi.fn() };
        const state = makeState({
            settings: { aiTier: 'lite' } as any,
            enemyCompendium: [],
            enemyCombatConfig: { ...DEFAULT_ENEMY_COMBAT_CONFIG, enemyDiscoveryEnabled: true },
        });

        await runPostTurnPipeline(state, callbacks, ASSISTANT_CONTENT, ALL_MSGS);

        expect(mockDetectEnemySuggestions).not.toHaveBeenCalled();
        expect(callbacks.addEnemySuggestions).not.toHaveBeenCalled();
    });

    it('disabled enemyDiscovery flag means no scan', async () => {
        mockApi.archive.append.mockResolvedValueOnce({ sceneId: '001' });
        mockApi.chapters.list.mockResolvedValueOnce([]);
        useAppStore.setState({ activeCampaignId: 'campaign-1' });
        const callbacks = { ...makeCallbacks(), addEnemySuggestions: vi.fn() };
        const state = makeState({
            enemyCompendium: [],
            enemyCombatConfig: { ...DEFAULT_ENEMY_COMBAT_CONFIG, enemyDiscoveryEnabled: false },
        });

        await runPostTurnPipeline(state, callbacks, ASSISTANT_CONTENT, ALL_MSGS);

        expect(mockDetectEnemySuggestions).not.toHaveBeenCalled();
    });

    it('skips a queued enemy discovery when the campaign switches before the request starts', async () => {
        mockApi.archive.append.mockResolvedValueOnce({ sceneId: '001' });
        mockApi.chapters.list.mockResolvedValueOnce([]);
        useAppStore.setState({ activeCampaignId: 'campaign-1' });
        // The background task fires AFTER the campaign has already switched.
        mockBQ.push.mockImplementationOnce(async (_label, execute) => {
            useAppStore.setState({ activeCampaignId: 'campaign-2' });
            await execute();
            useAppStore.setState({ activeCampaignId: 'campaign-1' });
        });
        const callbacks = { ...makeCallbacks(), addEnemySuggestions: vi.fn() };
        const state = makeState({
            enemyCompendium: [],
            enemyCombatConfig: { ...DEFAULT_ENEMY_COMBAT_CONFIG, enemyDiscoveryEnabled: true },
        });

        await runPostTurnPipeline(state, callbacks, ASSISTANT_CONTENT, ALL_MSGS);

        // The scan was skipped before the LLM call because the campaign changed.
        expect(mockDetectEnemySuggestions).not.toHaveBeenCalled();
        expect(callbacks.addEnemySuggestions).not.toHaveBeenCalled();
    });

    it('prevents enemy discovery suggestion write when the campaign switches during the request', async () => {
        mockApi.archive.append.mockResolvedValueOnce({ sceneId: '001' });
        mockApi.chapters.list.mockResolvedValueOnce([]);
        useAppStore.setState({ activeCampaignId: 'campaign-1' });
        mockBQ.push.mockImplementationOnce(async (_label, execute) => {
            await execute();
        });
        // The scan resolves, but switches the active campaign before it returns
        // so the post-scan guard drops the suggestions.
        vi.mocked(detectEnemySuggestions).mockImplementationOnce(async () => {
            useAppStore.setState({ activeCampaignId: 'campaign-2' });
            return [{ kind: 'new' as const, name: 'Orc' }];
        });
        const callbacks = { ...makeCallbacks(), addEnemySuggestions: vi.fn() };
        const state = makeState({
            enemyCompendium: [],
            enemyCombatConfig: { ...DEFAULT_ENEMY_COMBAT_CONFIG, enemyDiscoveryEnabled: true },
        });

        await runPostTurnPipeline(state, callbacks, ASSISTANT_CONTENT, ALL_MSGS);

        // Suggestions were produced but dropped because the campaign changed.
        expect(callbacks.addEnemySuggestions).not.toHaveBeenCalled();
    });

    it('enforces single-flight: only one discovery task per campaign', async () => {
        mockApi.archive.append.mockResolvedValue({ sceneId: '001' });
        mockApi.chapters.list.mockResolvedValue([]);
        useAppStore.setState({ activeCampaignId: 'campaign-1' });
        let queueCalls = 0;
        mockBQ.push.mockImplementation(async (_label, execute) => {
            queueCalls++;
            if (queueCalls === 1) return; // first turn queues the scan
            await execute(); // subsequent turns run their own tracks
        });
        const callbacks = { ...makeCallbacks(), addEnemySuggestions: vi.fn() };
        const state = makeState({
            enemyCompendium: [],
            enemyCombatConfig: { ...DEFAULT_ENEMY_COMBAT_CONFIG, enemyDiscoveryEnabled: true },
            incrementBookkeepingTurnCounter: vi.fn().mockReturnValue(1),
        });

        // First turn — queues Enemy-Discovery (does not execute the scan body).
        await runPostTurnPipeline(state, callbacks, ASSISTANT_CONTENT, ALL_MSGS);
        // Second turn — in-flight flag is set, so the scan is skipped (no second queue).
        await runPostTurnPipeline(state, callbacks, ASSISTANT_CONTENT, ALL_MSGS);

        const discoveryQueues = vi.mocked(mockBQ.push).mock.calls.filter(c => c[0] === 'Enemy-Discovery');
        expect(discoveryQueues.length).toBe(1);
    });

    // Durable-commit v1: a failed append no longer just returns quietly. The index is
    // consulted once — the prose write lands synchronously server-side, so "no data"
    // can mean "written, response lost" — and the verdict is reported to the caller,
    // which keeps the turn armed instead of retiring an unarchived scene.
    it('reports archived:false and refreshes nothing when append fails and no scene is on disk', async () => {
        mockApi.archive.append.mockResolvedValueOnce(null);
        mockApi.archive.getIndex.mockResolvedValueOnce([]); // verification: nothing there

        const callbacks = makeCallbacks();
        const result = await runPostTurnPipeline(makeState(), callbacks, ASSISTANT_CONTENT, ALL_MSGS);

        expect(result).toEqual({ archived: false });
        expect(callbacks.setArchiveIndex).not.toHaveBeenCalled();
    });

    it('recovers the scene id from the index when the append response was lost', async () => {
        const written = [{ sceneId: '001', timestamp: 1, keywords: [], npcsMentioned: [], witnesses: [], userSnippet: 'attack the goblin' }];
        mockApi.archive.append.mockResolvedValueOnce(null);
        mockApi.archive.getIndex.mockResolvedValue(written);
        mockApi.chapters.list.mockResolvedValueOnce([]);

        const callbacks = makeCallbacks();
        const result = await runPostTurnPipeline(makeState(), callbacks, ASSISTANT_CONTENT, ALL_MSGS);

        expect(result).toEqual({ archived: true });
        expect(callbacks.updateLastAssistantMessage).toHaveBeenCalledWith({ sceneId: '001' });
    });

    it('re-links instead of re-appending when a retry finds the turn already archived', async () => {
        const written = [{ sceneId: '001', timestamp: 1, keywords: [], npcsMentioned: [], witnesses: [], userSnippet: 'attack the goblin' }];
        mockApi.archive.getIndex.mockResolvedValue(written);
        mockApi.chapters.list.mockResolvedValueOnce([]);

        const callbacks = makeCallbacks();
        const result = await runPostTurnPipeline(
            makeState(), callbacks, ASSISTANT_CONTENT, ALL_MSGS, undefined, { verifyExistingScene: true },
        );

        expect(mockApi.archive.append).not.toHaveBeenCalled();
        expect(result).toEqual({ archived: true });
        expect(callbacks.updateLastAssistantMessage).toHaveBeenCalledWith({ sceneId: '001' });
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

    it('populates NPC suggestions for new NPC names detected in assistant content', async () => {
        mockApi.archive.append.mockResolvedValueOnce({ sceneId: '001' });
        mockApi.chapters.list.mockResolvedValueOnce([]);

        mockExtractNPCNames.mockReturnValueOnce(['Kaelen']);
        mockValidateNPCCandidates.mockResolvedValueOnce(['Kaelen']);
        mockClassifyNPCNames.mockReturnValueOnce({ newNames: ['Kaelen'], existingNpcs: [] });

        const callbacks = makeCallbacks();
        await runPostTurnPipeline(makeState(), callbacks, ASSISTANT_CONTENT, ALL_MSGS);

        expect(callbacks.addNpcSuggestions).toHaveBeenCalledWith(['Kaelen'], ASSISTANT_CONTENT);
        const npcGenCalls = vi.mocked(mockBQ.push).mock.calls.filter(c => c[0] === 'NPC-Gen:Kaelen');
        expect(npcGenCalls).toHaveLength(0);
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
