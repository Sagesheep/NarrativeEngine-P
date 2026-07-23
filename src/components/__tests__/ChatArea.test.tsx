import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatArea } from '../ChatArea';
import type { ChatMessage, AppSettings, GameContext, CondenserState } from '../../types';

const { mockAnswerOocQuestion, mockSummarizeAskGmConversation } = vi.hoisted(() => ({ mockAnswerOocQuestion: vi.fn(), mockSummarizeAskGmConversation: vi.fn() }));

vi.mock('../../store/useAppStore', () => {
    const state = {
        messages: [] as ChatMessage[],
        condenser: { condensedUpToIndex: -1 } as CondenserState,
        context: {
            loreRaw: '', rulesRaw: '', canonState: '', headerIndex: '',
            starter: '', continuePrompt: '', inventory: '', inventoryLastScene: '',
            characterProfile: { identity: {}, activeTraits: [] }, characterProfileLastScene: '',
            canonStateActive: false, headerIndexActive: false,
            starterActive: false, continuePromptActive: false,
            inventoryActive: false, characterProfileActive: false,
            surpriseEngineActive: false, encounterEngineActive: false,
            worldEngineActive: false, diceFairnessActive: false,
            sceneNote: '', sceneNoteActive: false, sceneNoteDepth: 0,
            worldVibe: '',
            notebook: [], notebookActive: false,
            pcPromptDismissed: true,
        } as unknown as GameContext,
        activeCampaignId: 'test-campaign',
        settings: {
            presets: [{ id: 'p1', name: 'Test', storyAIProviderId: 'prov1' }],
            providers: [{ id: 'prov1', label: 'Test', endpoint: 'http://test', apiKey: 'k', modelName: 'm' }],
            activePresetId: 'p1',
            contextLimit: 4096,
            debugMode: false,
            showReasoning: true,
            autoCondenseEnabled: true,
            condenseAggressiveness: 'smart' as const,
        } as unknown as AppSettings,
        loreChunks: [],
        npcLedger: [],
        archiveIndex: [],
        chapters: [],
        timeline: [],
        pinnedChapterIds: [],
        bookkeepingTurnCounter: 0,
        autoBookkeepingInterval: 5,
        setArchiveIndex: vi.fn(),
        clearArchive: vi.fn(),
        updateLastAssistant: vi.fn(),
        updateContext: vi.fn(),
        setCondensed: vi.fn(),
        deleteMessage: vi.fn(),
        deleteMessagesFrom: vi.fn(),
        resetCondenser: vi.fn(),
        setTimeline: vi.fn(),
        setChapters: vi.fn(),
        addMessage: vi.fn(),
        updateLastMessage: vi.fn(),
        updateLastAssistantMessage: vi.fn(),
        updateNPC: vi.fn(),
        addNPC: vi.fn(),
        setLastPayloadTrace: vi.fn(),
        setActivePreset: vi.fn(),
        clearPinnedChapters: vi.fn(),
        incrementBookkeepingTurnCounter: vi.fn(() => 1),
        resetBookkeepingTurnCounter: vi.fn(),
        setCondenser: vi.fn(),
        getActiveStoryEndpoint: vi.fn(() => ({ id: 'prov1', label: 'Test', endpoint: 'http://test', apiKey: 'k', modelName: 'm' })),
        getActiveUtilityEndpoint: vi.fn(() => undefined),
        getActiveSummarizerEndpoint: vi.fn(() => undefined),
        getActivePreset: vi.fn(() => undefined),
        setDivergenceRegister: vi.fn(),
        toggleDivergenceChapter: vi.fn(),
        toggleDivergenceCategory: vi.fn(),
        pinDivergenceFact: vi.fn(),
        editDivergenceFact: vi.fn(),
        deleteDivergenceFact: vi.fn(),
        dismissDivergenceReviewFlag: vi.fn(),
        confirmReviewEntry: vi.fn(),
        divergenceRegister: { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 },
        pipelinePhase: 'idle' as const,
        streamingStats: null,
        setPipelinePhase: vi.fn(),
        setStreamingStats: vi.fn(),
        setStreaming: vi.fn(),
        toggleDrawer: vi.fn(),
        drawerOpen: false,
        deepArmed: false,
        setDeepArmed: vi.fn(),
        armedRoll: null,
        setArmedRoll: vi.fn(),
        openDiceRollModal: vi.fn(),
        closeDiceRollModal: vi.fn(),
        diceRollModalOpen: false,
        armedLoot: null,
        clearArmedLoot: vi.fn(),
        armLoot: vi.fn(),
        armedOneShot: null,
        setArmedOneShot: vi.fn(),
        armedAbsoluteCommand: null,
        setArmedAbsoluteCommand: vi.fn(),
    };
    const subscribe = vi.fn(() => vi.fn());
    const getState = vi.fn(() => state);
    const useAppStore = Object.assign(
        (selector: any) => {
            const result = selector(state);
            return result;
        },
        { getState, subscribe }
    );
    return { useAppStore };
});

vi.mock('../../services/ooc/oocService', () => ({ answerOocQuestion: mockAnswerOocQuestion }));

vi.mock('../../services/ooc/askGmHandoff', async importOriginal => ({ ...(await importOriginal<typeof import('../../services/ooc/askGmHandoff')>()), summarizeAskGmConversation: mockSummarizeAskGmConversation }));

vi.mock('../../services/turn/turnOrchestrator', () => ({
    runTurn: vi.fn(async () => {}),
}));

vi.mock('../../services/turn/pendingCommit', () => ({
    commitPendingTurn: vi.fn(async () => {}),
    findPendingCommitMessage: vi.fn(() => null),
    findRetryableMessage: vi.fn(() => null),
    hasSwipeSet: vi.fn(() => false),
}));

vi.mock('../../services/archive-memory/condenser', () => ({
    shouldCondense: vi.fn(() => false),
    computeTrimIndex: vi.fn(() => -1),
    getCondenseBudgetRatio: vi.fn(() => 0.75),
}));

vi.mock('../../services/saveFileEngine', () => ({
    runSaveFilePipeline: vi.fn(async () => ({ headerIndex: '', indexSuccess: true })),
    generateChapterSummary: vi.fn(async () => null),
}));

vi.mock('../../services/llm/apiClient', () => ({
    api: {
        archive: {
            open: vi.fn(async () => {}),
            clear: vi.fn(async () => {}),
            getIndex: vi.fn(async () => []),
            deleteFrom: vi.fn(async () => {}),
            fetchScenes: vi.fn(async () => []),
        },
        chapters: {
            seal: vi.fn(async () => null),
            list: vi.fn(async () => []),
            update: vi.fn(async () => {}),
        },
        timeline: {
            get: vi.fn(async () => []),
        },
    },
}));

vi.mock('../../lib/apiBase', () => ({
    API_BASE: 'http://localhost:3001',
}));

vi.mock('idb-keyval', () => ({
    set: vi.fn(async () => {}),
}));

vi.mock('../Toast', () => ({
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../services/archive-memory/archiveChapterEngine', () => ({
    shouldAutoSeal: vi.fn(() => ({ shouldSeal: false, reason: '' })),
}));

import { useAppStore } from '../../store/useAppStore';
import { runTurn } from '../../services/turn/turnOrchestrator';
import { commitPendingTurn } from '../../services/turn/pendingCommit';
import { answerOocQuestion } from '../../services/ooc/oocService';

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
        id: `msg-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
        ...overrides,
    };
}

describe('ChatArea', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        const state = useAppStore.getState();
        state.messages = [];
        state.condenser = { condensedUpToIndex: -1 };
        state.activeCampaignId = 'test-campaign';
        state.archiveIndex = [];
        state.chapters = [];
        state.pipelinePhase = 'idle';
        (mockSummarizeAskGmConversation as ReturnType<typeof vi.fn>).mockResolvedValue('Keep the gate scene tense.');
        (mockAnswerOocQuestion as ReturnType<typeof vi.fn>).mockResolvedValue({ text: 'Ask GM answer', sources: [], archiveSearched: false });
    });

    it('renders empty state when no messages', () => {
        render(<ChatArea />);
        expect(screen.getByText('Awaiting transmission...')).toBeInTheDocument();
    });

    it('renders message list with user and assistant messages', () => {
        const state = useAppStore.getState();
        state.messages = [
            makeMessage({ role: 'user', content: 'I attack the dragon' }),
            makeMessage({ role: 'assistant', content: 'The dragon roars!' }),
        ];
        render(<ChatArea />);
        expect(screen.getByText('I attack the dragon')).toBeInTheDocument();
        expect(screen.getByText('The dragon roars!')).toBeInTheDocument();
    });

    it('sends message on button click', async () => {
        const user = userEvent.setup();
        render(<ChatArea />);
        const textarea = screen.getByPlaceholderText('What do you do?');
        await user.type(textarea, 'Hello world');
        const sendBtn = screen.getByPlaceholderText('What do you do?')
            .closest('.flex')?.querySelector('button:last-child') as HTMLElement;
        await user.click(sendBtn);
        expect(runTurn).toHaveBeenCalled();
        const [turnState] = (runTurn as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(turnState.input).toBe('Hello world');
    });

    it('sends message on Enter key', async () => {
        const user = userEvent.setup();
        render(<ChatArea />);
        const textarea = screen.getByPlaceholderText('What do you do?');
        await user.type(textarea, 'Testing enter{Enter}');
        expect(runTurn).toHaveBeenCalled();
    });

    it('does not send on Shift+Enter', async () => {
        const user = userEvent.setup();
        render(<ChatArea />);
        const textarea = screen.getByPlaceholderText('What do you do?');
        await user.type(textarea, 'No send{Shift>}{Enter}');
        expect(runTurn).not.toHaveBeenCalled();
    });

    it('enters edit mode when edit button clicked', async () => {
        const user = userEvent.setup();
        const state = useAppStore.getState();
        state.messages = [
            makeMessage({ role: 'user', content: 'Editable message' }),
        ];
        render(<ChatArea />);
        const editBtn = screen.getByTitle('Edit');
        await user.click(editBtn);
        // Edit mode renders a textarea with placeholder "Edit message..."
        // and a Save button with title "Save edit (Enter)"
        expect(screen.getByPlaceholderText('Edit message...')).toBeInTheDocument();
        expect(screen.getByTitle('Save edit (Enter)')).toBeInTheDocument();
    });

    it('shows streaming indicator when isStreaming is true', () => {
        const state = useAppStore.getState();
        state.messages = [makeMessage({ role: 'user', content: 'Hi' })];
        (runTurn as ReturnType<typeof vi.fn>).mockImplementation(async (_s: any, _c: any, _ac: any) => {
            state.messages.push(makeMessage({ role: 'assistant', content: 'streaming...' }));
        });
        render(<ChatArea />);
    });

    it('opens Ask GM without committing a pending turn or changing canonical story messages', async () => {
        const user = userEvent.setup();
        const state = useAppStore.getState();
        const storyMessages = [makeMessage({ role: 'assistant', content: 'A visible pending swipe', pendingCommit: true, swipeSet: [{ id: 'swipe-1', text: 'A visible pending swipe', sceneStakes: 'calm', tagPresent: false }] })];
        state.messages = storyMessages;
        render(<ChatArea />);
        await user.click(screen.getByTitle('Open Ask GM side chat'));
        expect(screen.getByRole('heading', { name: 'Ask GM' })).toBeInTheDocument();
        expect(commitPendingTurn).not.toHaveBeenCalled();
        expect(runTurn).not.toHaveBeenCalled();
        expect(state.messages).toBe(storyMessages);
        expect(state.messages[0].pendingCommit).toBe(true);
    });

    it('blocks story send while an unresolved Ask GM request is generating without changing canonical messages', async () => {
        const user = userEvent.setup();
        const state = useAppStore.getState();
        const storyMessages = [makeMessage({ role: 'assistant', content: 'Canonical story' })];
        state.messages = storyMessages;
        (mockAnswerOocQuestion as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
        render(<ChatArea />);
        const storyInput = screen.getByPlaceholderText('What do you do?');
        await user.type(storyInput, 'Advance the story');
        await user.click(screen.getByTitle('Open Ask GM side chat'));
        await user.type(screen.getByPlaceholderText('Ask the GM...'), 'Quick Ask GM question');
        await user.click(screen.getByTitle('Send Ask GM question'));
        await waitFor(() => expect(answerOocQuestion).toHaveBeenCalledTimes(1));
        expect(screen.getByTitle('Stop Ask GM response')).toBeInTheDocument();
        expect((storyInput.closest('.flex')?.querySelector('button:last-child') as HTMLButtonElement).disabled).toBe(true);
        await user.click(storyInput.closest('.flex')?.querySelector('button:last-child') as HTMLButtonElement);
        expect(runTurn).not.toHaveBeenCalled();
        expect(state.messages).toBe(storyMessages);
        expect(state.messages[0].content).toBe('Canonical story');
    });

    it('disables Ask GM input while story generation is active', async () => {
        const user = userEvent.setup();
        const state = useAppStore.getState();
        state.pipelinePhase = 'generating';
        render(<ChatArea />);
        await user.click(screen.getByTitle('Open Ask GM side chat'));
        expect(screen.getByPlaceholderText('Ask the GM...')).toBeDisabled();
    });
    it('requires an editable confirmation before arming a visible one-turn Story AI note', async () => {
        const user = userEvent.setup();
        const state = useAppStore.getState();
        const canonical = [makeMessage({ role: 'assistant', content: 'Canonical story' })];
        state.messages = canonical;
        render(<ChatArea />);
        await user.click(screen.getByTitle('Open Ask GM side chat'));
        await user.type(screen.getByPlaceholderText('Ask the GM...'), 'How should I approach the gate?');
        await user.click(screen.getByTitle('Send Ask GM question'));
        await waitFor(() => expect(screen.getByText('Pass to Story AI')).toBeInTheDocument());
        await user.click(screen.getByText('Pass to Story AI'));
        await waitFor(() => expect(screen.getByText('This will be sent to the Story AI with your next turn:')).toBeInTheDocument());
        await user.clear(screen.getByLabelText('Ask GM brief preview'));
        await user.type(screen.getByLabelText('Ask GM brief preview'), 'Edited player guidance.');
        await user.click(screen.getByText('Confirm'));
        expect(screen.getByText('Story AI note armed')).toBeInTheDocument();
        expect(commitPendingTurn).not.toHaveBeenCalled();
        await user.click(screen.getByText('Edit'));
        await user.clear(screen.getByLabelText('Edit Story AI note'));
        await user.type(screen.getByLabelText('Edit Story AI note'), 'Final player guidance.');
        await user.click(screen.getByText('Save'));
        expect(screen.getByText('Final player guidance.')).toBeInTheDocument();
        const storyInput = screen.getByPlaceholderText('What do you do?');
        await user.type(storyInput, 'I approach the gate.');
        await user.click(storyInput.closest('.flex')?.querySelector('button:last-child') as HTMLButtonElement);
        const [turnState] = (runTurn as ReturnType<typeof vi.fn>).mock.calls.at(-1);
        expect(turnState.nextTurnOocBrief).toBe('Final player guidance.');
        expect(state.messages).toBe(canonical);
        expect(screen.queryByText('Story AI note armed')).not.toBeInTheDocument();

    });
    it('stop button aborts the in-flight turn (abort controller lifecycle)', async () => {
        const user = userEvent.setup();
        let capturedAbort: AbortController | null = null;
        (runTurn as ReturnType<typeof vi.fn>).mockImplementation(
            (_state: unknown, callbacks: { setStreaming: (v: boolean) => void }, abortController: AbortController) => {
                capturedAbort = abortController;
                callbacks.setStreaming(true);
                return new Promise(() => {});
            }
        );
        render(<ChatArea />);
        const textarea = screen.getByPlaceholderText('What do you do?');
        await user.type(textarea, 'Start a turn{Enter}');
        const stopBtn = textarea.closest('.flex')?.querySelector('button:last-child') as HTMLButtonElement;
        // While streaming the send button becomes an enabled stop control (input is empty).
        await waitFor(() => expect(stopBtn.disabled).toBe(false));
        expect(capturedAbort).not.toBeNull();
        expect(capturedAbort!.signal.aborted).toBe(false);
        await user.click(stopBtn);
        expect(capturedAbort!.signal.aborted).toBe(true);
        expect(useAppStore.getState().setPipelinePhase).toHaveBeenCalledWith('idle');
        // Back to idle: the button is a disabled send control again.
        await waitFor(() => expect(stopBtn.disabled).toBe(true));
    });

    it('force save writes to IndexedDB', async () => {
        const user = userEvent.setup();
        render(<ChatArea />);
        const saveBtn = screen.getByText(/SAVE CAMPAIGN/i).closest('button')!;
        await user.click(saveBtn);
    });

    it('shows load more button when messages exceed visibleCount', () => {
        const state = useAppStore.getState();
        state.messages = Array.from({ length: 20 }, (_, i) =>
            makeMessage({ role: 'user', content: `Message ${i}` })
        );
        render(<ChatArea />);
        expect(screen.getByText(/Load older messages/i)).toBeInTheDocument();
    });
});
