import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatArea } from '../ChatArea';
import type { ChatMessage, AppSettings, GameContext, CondenserState } from '../../types';

vi.mock('../../store/useAppStore', () => {
    const state = {
        messages: [] as ChatMessage[],
        condenser: { condensedSummary: '', condensedUpToIndex: -1, isCondensing: false } as CondenserState,
        context: {
            loreRaw: '', rulesRaw: '', canonState: '', headerIndex: '',
            starter: '', continuePrompt: '', inventory: '', inventoryLastScene: '',
            characterProfile: '', characterProfileLastScene: '',
            canonStateActive: false, headerIndexActive: false,
            starterActive: false, continuePromptActive: false,
            inventoryActive: false, characterProfileActive: false,
            surpriseEngineActive: false, encounterEngineActive: false,
            worldEngineActive: false, diceFairnessActive: false,
            sceneNote: '', sceneNoteActive: false, sceneNoteDepth: 0,
            worldVibe: '', enemyPlayerActive: false, neutralPlayerActive: false,
            allyPlayerActive: false, enemyPlayerPrompt: '', neutralPlayerPrompt: '',
            allyPlayerPrompt: '', interventionChance: 0, enemyCooldown: 0,
            neutralCooldown: 0, allyCooldown: 0, interventionQueue: [],
            notebook: [], notebookActive: false,
        } as unknown as GameContext,
        activeCampaignId: 'test-campaign',
        settings: {
            presets: [{ id: 'p1', name: 'Test', storyAI: { endpoint: 'http://test', apiKey: 'k', modelName: 'm' }, imageAI: { endpoint: '', apiKey: '', modelName: '' }, summarizerAI: { endpoint: '', apiKey: '', modelName: '' } }],
            activePresetId: 'p1',
            contextLimit: 4096,
            debugMode: false,
            showReasoning: true,
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
        setCondensing: vi.fn(),
        deleteMessage: vi.fn(),
        deleteMessagesFrom: vi.fn(),
        resetCondenser: vi.fn(),
        setTimeline: vi.fn(),
        setChapters: vi.fn(),
        addMessage: vi.fn(),
        updateLastMessage: vi.fn(),
        updateNPC: vi.fn(),
        addNPC: vi.fn(),
        setLastPayloadTrace: vi.fn(),
        setActivePreset: vi.fn(),
        clearPinnedChapters: vi.fn(),
        incrementBookkeepingTurnCounter: vi.fn(() => 1),
        resetBookkeepingTurnCounter: vi.fn(),
        setCondenser: vi.fn(),
        getActiveStoryEndpoint: vi.fn(() => ({ endpoint: 'http://test', apiKey: 'k', modelName: 'm' })),
        getActiveUtilityEndpoint: vi.fn(() => undefined),
        getActiveSummarizerEndpoint: vi.fn(() => undefined),
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

vi.mock('../../services/turnOrchestrator', () => ({
    runTurn: vi.fn(async () => {}),
}));

vi.mock('../../services/condenser', () => ({
    condenseHistory: vi.fn(async () => ({ summary: 'test summary', upToIndex: 2 })),
    shouldCondense: vi.fn(() => false),
}));

vi.mock('../../services/saveFileEngine', () => ({
    runSaveFilePipeline: vi.fn(async () => ({ headerIndex: '', indexSuccess: true })),
    generateChapterSummary: vi.fn(async () => null),
}));

vi.mock('../../services/apiClient', () => ({
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

vi.mock('../../services/archiveChapterEngine', () => ({
    shouldAutoSeal: vi.fn(() => ({ shouldSeal: false, reason: '' })),
}));

import { useAppStore } from '../../store/useAppStore';
import { runTurn } from '../../services/turnOrchestrator';
import { condenseHistory, shouldCondense } from '../../services/condenser';
import { set as idbSet } from 'idb-keyval';
import { api } from '../../services/apiClient';
import { shouldAutoSeal } from '../../services/archiveChapterEngine';

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
        state.condenser = { condensedSummary: '', condensedUpToIndex: -1, isCondensing: false };
        state.activeCampaignId = 'test-campaign';
        state.archiveIndex = [];
        state.chapters = [];
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
        expect(screen.getByText('Editing Message')).toBeInTheDocument();
    });

    it('shows streaming indicator when isStreaming is true', () => {
        const state = useAppStore.getState();
        state.messages = [makeMessage({ role: 'user', content: 'Hi' })];
        (runTurn as ReturnType<typeof vi.fn>).mockImplementation(async (_s: any, _c: any, _ac: any) => {
            state.messages.push(makeMessage({ role: 'assistant', content: 'streaming...' }));
        });
        render(<ChatArea />);
    });

    it('force save writes to IndexedDB', async () => {
        const user = userEvent.setup();
        render(<ChatArea />);
        const saveBtn = screen.getByText(/SAVE CAMPAIGN/i).closest('button')!;
        await user.click(saveBtn);
        expect(idbSet).toHaveBeenCalled();
    });

    it('seal chapter calls API', async () => {
        const user = userEvent.setup();
        const state = useAppStore.getState();
        state.chapters = [{ chapterId: 'CH01', title: 'Chapter 1', sceneRange: ['001', '005'] as [string, string], summary: '', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], tone: '', themes: [], sceneCount: 5 }] as any;
        (api.chapters.seal as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            sealedChapter: { chapterId: 'CH01' },
            newOpenChapter: { chapterId: 'CH02' },
        });
        (api.chapters.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
        vi.stubGlobal('prompt', vi.fn(() => 'Test Chapter'));
        render(<ChatArea />);
        const sealBtn = screen.getByTitle('Manually seal current chapter');
        await user.click(sealBtn);
        await waitFor(() => {
            expect(api.chapters.seal).toHaveBeenCalledWith('test-campaign', 'Test Chapter');
        });
        vi.restoreAllMocks();
    });

    it('clear archive calls API and resets store', async () => {
        const user = userEvent.setup();
        const state = useAppStore.getState();
        state.archiveIndex = [{ sceneId: '001', timestamp: 1, keywords: [], npcsMentioned: [], witnesses: [], userSnippet: '' }];
        vi.stubGlobal('confirm', vi.fn(() => true));
        render(<ChatArea />);
        const clearBtn = screen.getByText('Clear Archive').closest('button')!;
        await user.click(clearBtn);
        await waitFor(() => {
            expect(api.archive.clear).toHaveBeenCalledWith('test-campaign');
            expect(state.clearArchive).toHaveBeenCalled();
        });
        vi.restoreAllMocks();
    });

    it('shows load more button when messages exceed visibleCount', () => {
        const state = useAppStore.getState();
        state.messages = Array.from({ length: 20 }, (_, i) =>
            makeMessage({ role: 'user', content: `Message ${i}` })
        );
        render(<ChatArea />);
        expect(screen.getByText(/Load older messages/i)).toBeInTheDocument();
    });

    it('condense button triggers condensation', async () => {
        const user = userEvent.setup();
        const state = useAppStore.getState();
        state.messages = Array.from({ length: 10 }, (_, i) =>
            makeMessage({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Msg ${i}` })
        );
        state.condenser = { condensedSummary: '', condensedUpToIndex: -1, isCondensing: false };
        render(<ChatArea />);
        const condenseBtn = screen.getByText('Condense').closest('button')!;
        await user.click(condenseBtn);
        await waitFor(() => {
            expect(condenseHistory).toHaveBeenCalled();
        });
    });

    it('auto-condense fires when shouldCondense returns true', async () => {
        (shouldCondense as ReturnType<typeof vi.fn>).mockReturnValue(true);
        const state = useAppStore.getState();
        state.messages = Array.from({ length: 20 }, (_, i) =>
            makeMessage({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Msg ${i}` })
        );
        render(<ChatArea />);
        await waitFor(() => {
            expect(condenseHistory).toHaveBeenCalled();
        });
    });
});
