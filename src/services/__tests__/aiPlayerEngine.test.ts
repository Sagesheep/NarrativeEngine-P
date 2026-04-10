import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TurnState, TurnCallbacks } from '../turnOrchestrator';
import type { GameContext, ChatMessage, AppSettings } from '../../types';

vi.mock('../chatEngine', () => ({
    sendMessage: vi.fn(),
    buildPayload: vi.fn(),
    generateNPCProfile: vi.fn(),
    updateExistingNPCs: vi.fn(),
}));
vi.mock('../../utils/uid', () => ({ uid: vi.fn().mockReturnValue('test-uid') }));

import { handleInterventions } from '../aiPlayerEngine';
import { sendMessage } from '../chatEngine';

const mockSendMessage = vi.mocked(sendMessage);

// Minimal context with all intervention flags off by default
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
    enemyPlayerActive: false,
    neutralPlayerActive: false,
    allyPlayerActive: false,
    notebook: [],
} as unknown as GameContext);

const baseSettings = (): AppSettings => ({
    presets: [{
        id: 'p1',
        storyAI: { endpoint: 'http://llm', apiKey: '', modelName: 'm' },
        enemyAI: { endpoint: 'http://llm', apiKey: '', modelName: 'm' },
        neutralAI: { endpoint: 'http://llm', apiKey: '', modelName: 'm' },
        allyAI: { endpoint: 'http://llm', apiKey: '', modelName: 'm' },
    }],
    activePresetId: 'p1',
} as unknown as AppSettings);

const makeState = (overrides: Partial<TurnState> = {}): TurnState => ({
    input: 'attack',
    displayInput: 'attack',
    settings: baseSettings(),
    context: baseContext(),
    messages: [],
    condenser: { condensedSummary: '', condensedUpToIndex: -1, isCondensing: false },
    loreChunks: [],
    npcLedger: [],
    archiveIndex: [],
    activeCampaignId: 'campaign-1',
    provider: { endpoint: 'http://llm', apiKey: '', modelName: 'm' },
    getMessages: () => [],
    getFreshProvider: () => ({ endpoint: 'http://llm', apiKey: '', modelName: 'm' }),
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

const makeCallbacks = (): TurnCallbacks => ({
    onCheckingNotes: vi.fn(),
    addMessage: vi.fn(),
    updateLastAssistant: vi.fn(),
    updateLastMessage: vi.fn(),
    updateContext: vi.fn(),
    setArchiveIndex: vi.fn(),
    updateNPC: vi.fn(),
    addNPC: vi.fn(),
    setCondensed: vi.fn(),
    setCondensing: vi.fn(),
    setStreaming: vi.fn(),
    setLoadingStatus: vi.fn(),
});

const abortController = new AbortController();

describe('handleInterventions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns early without calling sendMessage when all players inactive and no queue', async () => {
        const state = makeState();
        const callbacks = makeCallbacks();

        await handleInterventions(state, callbacks, 'attack', abortController);

        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(callbacks.addMessage).not.toHaveBeenCalled();
    });

    it('uses forcedInterventions (priority 1) over queue and roll', async () => {
        mockSendMessage.mockImplementation((_ep, _msgs, _onChunk, onDone) => {
            onDone('The goblin lunges!');
            return Promise.resolve();
        });

        const state = makeState({ forcedInterventions: ['enemy'] });
        const callbacks = makeCallbacks();

        await handleInterventions(state, callbacks, 'move', abortController);

        expect(mockSendMessage).toHaveBeenCalledOnce();
        expect(callbacks.addMessage).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'AI_ENEMY', role: 'assistant' })
        );
    });

    it('pops from interventionQueue (priority 2) and updates context', async () => {
        mockSendMessage.mockImplementation((_ep, _msgs, _onChunk, onDone) => {
            onDone('The ally steps forward.');
            return Promise.resolve();
        });

        const state = makeState({
            context: { ...baseContext(), interventionQueue: ['ally'] },
        });
        const callbacks = makeCallbacks();

        await handleInterventions(state, callbacks, 'run', abortController);

        // Queue update: interventionQueue should now be []
        expect(callbacks.updateContext).toHaveBeenCalledWith({ interventionQueue: [] });
        expect(callbacks.addMessage).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'AI_ALLY' })
        );
    });

    it('does not trigger when cooldown is active for the player type', async () => {
        // Enemy is active with 100% chance, but cooldown of 2 means 5-message window
        // We place an AI_ENEMY message in recent history → cooldown should block it
        const recentMsg: ChatMessage = {
            id: 'msg-1', role: 'assistant', name: 'AI_ENEMY',
            content: 'prev action', timestamp: Date.now(),
        };
        const state = makeState({
            context: {
                ...baseContext(),
                enemyPlayerActive: true,
                interventionChance: 100,
                enemyCooldown: 2,
            },
            messages: [recentMsg],
        });
        const callbacks = makeCallbacks();

        await handleInterventions(state, callbacks, 'attack', abortController);

        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('queues remaining roll successes into interventionQueue', async () => {
        // All three players active, 100% chance, no cooldown, no recent messages
        mockSendMessage.mockImplementation((_ep, _msgs, _onChunk, onDone) => {
            onDone('Action!');
            return Promise.resolve();
        });

        const state = makeState({
            context: {
                ...baseContext(),
                enemyPlayerActive: true,
                neutralPlayerActive: true,
                allyPlayerActive: true,
                interventionChance: 100,
                enemyCooldown: 0,
                neutralCooldown: 0,
                allyCooldown: 0,
            },
        });
        const callbacks = makeCallbacks();

        await handleInterventions(state, callbacks, 'look', abortController);

        // One fires immediately, two go into queue
        expect(mockSendMessage).toHaveBeenCalledOnce();
        expect(callbacks.updateContext).toHaveBeenCalledWith({
            interventionQueue: expect.arrayContaining([expect.any(String)]),
        });
        const queueArg = vi.mocked(callbacks.updateContext).mock.calls[0][0] as any;
        expect(queueArg.interventionQueue).toHaveLength(2);
    });

    it('swallows errors from generateAIPlayerAction and continues', async () => {
        mockSendMessage.mockImplementation((_ep, _msgs, _onChunk, _onDone, onError) => {
            onError('LLM failure');
            return Promise.resolve();
        });

        const state = makeState({ forcedInterventions: ['enemy'] });
        const callbacks = makeCallbacks();

        // Should not throw
        await expect(
            handleInterventions(state, callbacks, 'attack', abortController)
        ).resolves.toBeUndefined();

        expect(callbacks.addMessage).not.toHaveBeenCalled();
    });

    it('posts assistant message with correct name and rolled result format', async () => {
        mockSendMessage.mockImplementation((_ep, _msgs, _onChunk, onDone) => {
            onDone('The neutral force watches.');
            return Promise.resolve();
        });

        const state = makeState({ forcedInterventions: ['neutral'] });
        const callbacks = makeCallbacks();

        await handleInterventions(state, callbacks, 'sneak', abortController);

        const addedMsg = vi.mocked(callbacks.addMessage).mock.calls[0][0];
        expect(addedMsg.role).toBe('assistant');
        expect(addedMsg.name).toBe('AI_NEUTRAL');
        expect(addedMsg.content).toMatch(/^\[Rolled \d+ - \w+\] /);
        expect(addedMsg.id).toBe('test-uid');
    });
});
