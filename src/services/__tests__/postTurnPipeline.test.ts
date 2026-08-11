/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TurnState, TurnCallbacks } from '../turn/turnOrchestrator';
import type { GameContext, ChatMessage } from '../../types';
import type { ValidatedMod } from '../../services/mods/modTypes';
import type { SandboxHostMessage, SandboxWorkerLike, SandboxWorkerMessage } from '../../services/mods/sandbox/sandboxTypes';
import { modToComputeTrack } from '../../services/mods/computeTrack';
import { postTurnTracks } from '../turn/tracks';

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

import { runPostTurnPipeline } from '../turn/postTurnPipeline';
import { api } from '../llm/apiClient';
import { backgroundQueue } from '../infrastructure/backgroundQueue';
import { extractNPCNames, validateNPCCandidates, classifyNPCNames } from '../npc/npcDetector';
import { useAppStore } from '../../store/useAppStore';

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
    getFreshLocationState: vi.fn().mockReturnValue({ activeCampaignId: 'campaign-1', locationLedger: [], context: baseContext() }),
    setCharacterProfileData: vi.fn(),
    setInventoryItems: vi.fn(),
    setLocationLedger: vi.fn(),
    addLocationSuggestions: vi.fn(),
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

    // Phase 8.3 — the enemy discovery track left core with the rest of the
    // enemy logic. The mod (8.5) ships its own discovery scan through
    // `postTurn` and `model:auxiliary` capabilities, which the loader already
    // whitelists (`mod.arc.compute` proves the path). The six enemy discovery
    // tests that were here (enabled/Lite/disabled/campaign-switch/single-
    // flight) retired with the `enemySuggestionTrack`; the mod's own test
    // suite will cover these behaviours post-8.5.

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

describe('compute mod integration', () => {
    it('runs a fixture compute mod in the real post-turn pipeline and applies its declared write', async () => {
        mockApi.archive.append.mockResolvedValueOnce({ sceneId: '001' });
        mockApi.chapters.list.mockResolvedValueOnce([]);

        const worker: SandboxWorkerLike = {
            onmessage: null,
            onerror: null,
            postMessage(message: SandboxHostMessage) {
                if (message.type !== 'run') return;
                queueMicrotask(() => worker.onmessage?.({
                    data: {
                        type: 'done',
                        writes: [{ kind: 'store', name: 'updateContext', args: [{ currentFeature: 'computed' }] }],
                        result: { computed: true },
                    },
                } as MessageEvent<SandboxWorkerMessage>));
            },
            terminate: vi.fn(),
        };

        const mod = {
            id: 'compute-fixture',
            name: 'Compute Fixture',
            version: '1.0.0',
            description: '',
            file: 'compute-fixture/manifest.json',
            contributions: [{ id: 'placeholder', order: 100, text: 'fixture' }],
            tables: [],
            panels: [],
            screens: [],
            screenSources: [],
            compute: {
                file: 'compute.js',
                hook: 'postTurn' as const,
                capabilities: ['write:updateContext'],
            },
            computeSource: 'export default async function () { return { computed: true }; }',
        } as ValidatedMod;
        const track = modToComputeTrack(mod, { sandboxOptions: { createWorker: () => worker } });
        postTurnTracks.register(track);

        try {
            const callbacks = makeCallbacks();
            await runPostTurnPipeline(makeState(), callbacks, ASSISTANT_CONTENT, ALL_MSGS);
            expect(callbacks.updateContext).toHaveBeenCalledWith({ currentFeature: 'computed' });
        } finally {
            postTurnTracks.unregister(track.id);
        }
    });
});